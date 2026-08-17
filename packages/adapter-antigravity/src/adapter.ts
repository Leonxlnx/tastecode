import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { ApprovalMode, Capabilities, DomainEvent, Model, Thread } from '@harness/contracts'
import { killTree, readNdjson } from '@harness/proc'
import { z } from 'zod'
import {
  collapseAntigravityModels,
  getAntigravityIndex,
  rememberAntigravityIndex,
  resolveAntigravityModel,
} from './models.js'
import { propertiesWhen } from './properties-when.js'

/**
 * Tier 3 adapter: drives Google's Antigravity CLI (`agy`) in headless
 * stream-json mode. Antigravity replaced the Gemini CLI for individual
 * accounts in June 2026; unlike gemini-cli it has no ACP mode, so this is a
 * per-turn print invocation like the Claude Code adapter.
 *
 * Frames captured against agy 1.1.10 on Windows through real non-TTY pipes:
 *
 *   {"event":"init","conversation_id":"...","init":{"model":"...","cwd":"..."}}
 *   {"event":"step_update","step_update":{"state":"ACTIVE","step_type":"agent_response","text_delta":"..."}}
 *   {"event":"result","result":{"conversation_id":"...","status":"SUCCESS","response":"...","usage":{...}}}
 *
 * `agy.exe` is a real executable, not a .cmd shim, so it is spawned directly
 * rather than through `spawnCli`'s cmd.exe route — cmd.exe truncates argv at
 * the first newline (#372), and a direct spawn carries multi-line prompts
 * intact (verified by capture).
 *
 * This never reads a credential. The binary authenticates itself with the
 * user's Google account on first interactive run. See rules/security.md.
 */

const SUPPORTED = '1.1'

export const ANTIGRAVITY_CAPABILITIES: Capabilities = {
  // Print mode is one-shot: no steer, no fork, and permission prompts cannot
  // be answered mid-turn — the launch mode decides them instead.
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: false,
  approvals: false,
  images: false,
}

export type AntigravityStartOptions = {
  instructions?: string | undefined
  model?: string | undefined
  effort?: string | undefined
  approval?: ApprovalMode | undefined
}

export type AntigravityTurnOptions = Pick<AntigravityStartOptions, 'model' | 'effort'>

function applyAntigravityTurnOptions(
  current: AntigravityStartOptions,
  next: AntigravityTurnOptions,
): AntigravityStartOptions {
  if (Object.keys(next).length === 0) return current
  const merged = { ...current }
  for (const field of ['model', 'effort'] as const) {
    if (!(field in next)) continue
    const value = next[field]
    if (value === undefined) delete merged[field]
    else merged[field] = value
  }
  return merged
}

/**
 * The per-turn argv. The prompt may be multi-line because the binary is
 * spawned directly (never through cmd.exe).
 */
export function antigravityTurnArgs(
  prompt: string,
  options: AntigravityStartOptions,
  conversationId: string | undefined,
): string[] {
  // The picker holds a collapsed base id; the wire wants the concrete
  // per-effort slug from the listing.
  const model = options.model
    ? resolveAntigravityModel(getAntigravityIndex(), options.model, options.effort)
    : undefined
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    ...(model ? ['--model', model] : []),
    // ask -> the CLI's default permission behavior; auto -> accept edits but
    // not commands; full -> the CLI's own skip-everything switch.
    ...(options.approval === 'auto' ? ['--mode', 'accept-edits'] : []),
    ...(options.approval === 'full' ? ['--dangerously-skip-permissions'] : []),
    ...(conversationId ? ['--conversation', conversationId] : []),
  ]
}

/** Resolve the binary: PATH name normally, the installer's fixed Windows home
 *  as a fallback because the installing shell's PATH update needs a restart. */
export function antigravityCommand(): string {
  if (process.platform !== 'win32') return 'agy'
  const localAppData = process.env['LOCALAPPDATA']
  if (!localAppData) return 'agy.exe'
  const installed = path.join(localAppData, 'agy', 'bin', 'agy.exe')
  return existsSync(installed) ? installed : 'agy.exe'
}

const AgyUsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  thinking_tokens: z.number().optional(),
  cache_read_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
})

const AgyFrameSchema = z.object({
  event: z.string().optional(),
  conversation_id: z.string().optional(),
  step_update: z
    .object({
      state: z.string().optional(),
      step_type: z.string().optional(),
      text_delta: z.string().optional(),
      usage: AgyUsageSchema.optional(),
    })
    .optional(),
  result: z
    .object({
      conversation_id: z.string().optional(),
      status: z.string().optional(),
      response: z.string().optional(),
      usage: AgyUsageSchema.optional(),
    })
    .optional(),
})

export type AntigravityAdapterEvents = {
  event: [DomainEvent]
  log: [string]
}

type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd?: string; stdio: ['pipe', 'pipe', 'pipe']; windowsHide: boolean },
) => ChildProcessWithoutNullStreams

export class AntigravityAdapter extends EventEmitter<AntigravityAdapterEvents> {
  readonly #spawn: SpawnFn
  #workspacePath = ''
  #options: AntigravityStartOptions = {}
  /** agy's own conversation id, so follow-up turns resume rather than restart. */
  #conversationId: string | undefined
  #child: ChildProcessWithoutNullStreams | undefined
  /** Children we killed on purpose — their non-zero exits are not failures. */
  #intentionalKills = new WeakSet<ChildProcessWithoutNullStreams>()
  #turnCounter = 0
  /** Session instructions ride in front of the first prompt: the CLI has no
   *  system-prompt flag, and the same pattern is what the Cursor adapter uses. */
  #instructionsPending = false

  constructor(options: { spawn?: SpawnFn } = {}) {
    super()
    this.#spawn = options.spawn ?? spawn
  }

  get capabilities(): Capabilities {
    return ANTIGRAVITY_CAPABILITIES
  }

  async startThread(workspacePath: string, options: AntigravityStartOptions = {}): Promise<Thread> {
    if (options.approval === 'auto-review') {
      throw new Error('Antigravity does not support automatic approval review')
    }
    this.#workspacePath = workspacePath
    this.#options = options
    this.#conversationId = undefined
    this.#instructionsPending = Boolean(options.instructions)
    return {
      id: `antigravity-${crypto.randomUUID()}`,
      provider: 'antigravity',
      workspacePath,
      createdAt: Date.now(),
    }
  }

  async sendTurn(
    threadId: string,
    text: string,
    attachments: string[] = [],
    options: AntigravityTurnOptions = {},
  ): Promise<string> {
    if (attachments.length) throw new Error('Antigravity attachments are not supported yet')
    this.#options = applyAntigravityTurnOptions(this.#options, options)
    // The picker normally warms this process-wide index. A server restart can
    // resume straight into a turn, though, and passing the collapsed anchor
    // id in that case silently loses a non-default effort selection.
    if (this.#options.model && this.#options.effort && !getAntigravityIndex()) {
      try {
        await this.listModels()
      } catch (error) {
        this.emit('log', `Antigravity effort discovery failed: ${String(error)}`)
      }
    }
    const turnId = `${threadId}-turn-${++this.#turnCounter}`
    const prompt =
      this.#instructionsPending && this.#options.instructions
        ? `<system-instructions>\n${this.#options.instructions}\n</system-instructions>\n\n${text}`
        : text
    this.#instructionsPending = false
    const args = antigravityTurnArgs(prompt, this.#options, this.#conversationId)

    // A turn already in flight would be orphaned by the reassignment below —
    // its exit handler must also not clobber the new child's reference.
    if (this.#child) this.#stop(this.#child)
    const child = this.#spawn(antigravityCommand(), args, {
      cwd: this.#workspacePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.#child = child

    this.emit('event', {
      type: 'turn.started',
      turn: { id: turnId, threadId, status: 'running', createdAt: Date.now() },
    })

    let sawResult = false
    let messageStarted = false
    let messageText = ''
    const messageId = `${turnId}-message`

    readNdjson(
      child.stdout,
      (value) => {
        const frame = AgyFrameSchema.parse(value)
        if (frame.event === 'init' && frame.conversation_id) {
          this.#conversationId = frame.conversation_id
          return
        }
        if (frame.event === 'step_update' && frame.step_update?.step_type === 'agent_response') {
          const delta = frame.step_update.text_delta ?? ''
          if (!delta) return
          if (!messageStarted) {
            messageStarted = true
            this.emit('event', {
              type: 'item.started',
              item: {
                id: messageId,
                turnId,
                type: 'message',
                role: 'assistant',
                status: 'started',
                text: '',
                createdAt: Date.now(),
              },
            })
          }
          messageText += delta
          this.emit('event', { type: 'item.delta', turnId, itemId: messageId, textDelta: delta })
          return
        }
        if (frame.event === 'result' && frame.result) {
          sawResult = true
          const usage = frame.result.usage
          const text = frame.result.response ?? messageText
          if (messageStarted || text.trim()) {
            this.emit('event', {
              type: 'item.completed',
              item: {
                id: messageId,
                turnId,
                type: 'message',
                role: 'assistant',
                status: 'completed',
                text: text.trimEnd(),
                createdAt: Date.now(),
              },
            })
          }
          if (usage) {
            const reasoningTokens = usage.thinking_tokens ?? 0
            this.emit('event', {
              type: 'usage.updated',
              usage: {
                ...propertiesWhen(this.#options.model, (includedValue) => ({
                  model: includedValue,
                })),
                inputTokens: usage.input_tokens ?? 0,
                cachedInputTokens: usage.cache_read_tokens ?? 0,
                outputTokens: (usage.output_tokens ?? 0) + reasoningTokens,
                reasoningTokens,
                totalTokens: usage.total_tokens ?? 0,
              },
            })
          }
          if (frame.result.status === 'SUCCESS') {
            this.emit('event', { type: 'turn.completed', turnId, status: 'completed' })
          } else {
            this.emit('event', {
              type: 'thread.error',
              threadId,
              message: `Antigravity finished with status ${frame.result.status ?? 'unknown'}`,
            })
            this.emit('event', { type: 'turn.completed', turnId, status: 'failed' })
          }
        }
      },
      (line) => this.emit('log', `unparsable stdout: ${line.slice(0, 200)}`),
    )

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.emit('log', chunk.trimEnd()))

    child.on('exit', (code) => {
      if (this.#child === child) this.#child = undefined
      if (this.#intentionalKills.has(child)) return
      // An exit without a result frame would otherwise look like a hang.
      if (sawResult) return
      this.emit('event', {
        type: 'thread.error',
        threadId,
        message: `agy exited with code ${code ?? 'unknown'} before reporting a result`,
      })
      this.emit('event', { type: 'turn.completed', turnId, status: 'failed' })
    })

    // A spawn failure emits 'error' on the child; without a listener that
    // throws out of the event loop and takes the whole server down.
    child.on('error', (error) => {
      if (this.#child === child) this.#child = undefined
      this.emit('event', { type: 'thread.error', threadId, message: String(error) })
      this.emit('event', { type: 'turn.completed', turnId, status: 'failed' })
    })

    child.stdin.end()
    return turnId
  }

  async interrupt(): Promise<void> {
    if (this.#child) this.#stop(this.#child)
  }

  /**
   * `agy models` prints one model slug per line with efforts baked into the
   * slugs; the listing is collapsed into base models so effort lives on the
   * slider (see models.ts). Verified against agy 1.1.10.
   *
   * The CLI blocks forever on a piped stdin that never closes — captured: an
   * open-stdin `agy models` never exits, a closed one answers in under two
   * seconds — so stdin closes immediately and the discovery must not go
   * through helpers that keep it open.
   */
  async listModels(): Promise<Model[]> {
    return new Promise((resolve, reject) => {
      const child = this.#spawn(antigravityCommand(), ['models'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdout = ''
      let settled = false
      const finish = (result: Model[] | Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (result instanceof Error) reject(result)
        else resolve(result)
      }
      const timer = setTimeout(() => {
        killTree(child)
        finish(new Error('Antigravity model discovery timed out'))
      }, 15000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => (stdout += chunk))
      child.on('error', (error) => finish(error))
      child.on('exit', (code) =>
        finish(
          code === 0
            ? parseAntigravityModels(stdout)
            : new Error('Antigravity model discovery failed'),
        ),
      )
      child.stdin.on('error', () => undefined)
      child.stdin.end()
    })
  }

  dispose(): void {
    if (this.#child) this.#stop(this.#child)
    this.#child = undefined
  }

  #stop(child: ChildProcessWithoutNullStreams): void {
    this.#intentionalKills.add(child)
    killTree(child)
  }
}

export function parseAntigravityModels(output: string): Model[] {
  const slugs = [
    ...new Set(
      output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        // agy 1.1.10 printed one slug per line. Starting in 1.1.11 it prints a
        // table (`slug<TAB>Display Name`), so only the first column belongs on
        // the wire. A status sentence uses ordinary single spaces; a table
        // column uses a tab or padding, while a legacy id has no remainder.
        .map((line) => {
          const slug = line.split(/\s+/, 1)[0] ?? ''
          const remainder = line.slice(slug.length)
          return remainder && !/^(?:\t| {2,})/.test(remainder) ? '' : slug
        })
        .filter((slug) => /^[\w./:-]+$/i.test(slug) && !/^(?:id|model|model-id)$/i.test(slug)),
    ),
  ]
  const { models, index } = collapseAntigravityModels(slugs)
  rememberAntigravityIndex(index)
  return models
}

export { SUPPORTED as ANTIGRAVITY_SUPPORTED_VERSION }
