import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ApprovalMode, Capabilities, DomainEvent, Model, Thread } from '@harness/contracts'
import { killTree, readNdjson } from '@harness/proc'

/**
 * Tier 3 adapter: drives xAI's Grok Build CLI (`grok`) in headless
 * streaming-json mode — one `-p` invocation per turn, follow-ups resumed
 * through the CLI's own session id, the same shape as the Antigravity
 * adapter.
 *
 * Frames captured against grok 0.1.219 on Windows through real non-TTY
 * pipes (see fixtures/stream.jsonl):
 *
 *   {"type":"thought","data":"..."}                             reasoning delta
 *   {"type":"text","data":"..."}                                answer delta
 *   {"type":"tool_call","toolCallId":"...","toolName":"write",
 *    "title":"write","status":"pending","rawInput":{...}}       tool started
 *   {"type":"tool_call_update","toolCallId":"...",
 *    "status":"completed","content":[...],"rawOutput":{...}}    tool finished
 *   {"type":"usage","usage":{...}}                              usage snapshot
 *   {"type":"end","stopReason":"end_turn","sessionId":"...",
 *    "usage":{...},"total_cost_usd":...}                        terminal frame
 *   {"type":"available_commands",...}                           roster noise
 *
 * A version banner may precede the JSON on stdout; readNdjson routes
 * unparsable lines to the log callback, so it is tolerated by construction.
 *
 * `grok.exe` is a real executable, not a .cmd shim, so it is spawned
 * directly rather than through `spawnCli`'s cmd.exe route — cmd.exe
 * truncates argv at the first newline (#372), and a direct spawn carries
 * multi-line prompts intact.
 *
 * This never reads a credential. `grok models` reports "You are not
 * authenticated." on its own, which is the entire auth probe.
 */

const SUPPORTED = '0.1'

export const GROK_CAPABILITIES: Capabilities = {
  // Print mode is one-shot: no steer, no fork, and permission prompts cannot
  // be answered mid-turn — the launch mode decides them instead.
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: true,
  approvals: false,
  images: false,
}

/** Model-specific reasoning levels published for Grok 4.5. The CLI's global
 *  `--reasoning-effort` help lists every level understood by any model, so it
 *  cannot be the capability set for each row returned by `grok models`. */
export const GROK_EFFORTS = ['low', 'medium', 'high']

type GrokModelDetails = {
  reasoningEfforts: readonly string[]
  defaultReasoningEffort: string
}

const GROK_MODEL_DETAILS: Readonly<Record<string, GrokModelDetails>> = {
  'grok-4.5': {
    reasoningEfforts: GROK_EFFORTS,
    defaultReasoningEffort: 'high',
  },
}

export type GrokStartOptions = {
  instructions?: string | undefined
  model?: string | undefined
  effort?: string | undefined
  approval?: ApprovalMode | undefined
}

export type GrokTurnOptions = Pick<GrokStartOptions, 'model' | 'effort'>

function applyGrokTurnOptions(current: GrokStartOptions, next: GrokTurnOptions): GrokStartOptions {
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

/** The per-turn argv. The prompt may be multi-line because the binary is
 *  spawned directly (never through cmd.exe). */
export function grokTurnArgs(
  prompt: string,
  options: GrokStartOptions,
  sessionId: string | undefined,
): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'streaming-json',
    ...(options.model ? ['--model', options.model] : []),
    ...(options.effort ? ['--reasoning-effort', options.effort] : []),
    // ask -> the CLI's default permission behavior; auto -> accept edits but
    // not commands; full -> the CLI's own skip-everything mode.
    ...(options.approval === 'auto' ? ['--permission-mode', 'acceptEdits'] : []),
    ...(options.approval === 'full' ? ['--permission-mode', 'bypassPermissions'] : []),
    ...(sessionId ? ['-r', sessionId] : []),
  ]
}

/** Resolve the binary: PATH name normally, the installer's fixed home as a
 *  fallback because a parent shell's stale PATH otherwise hides it. */
export function grokCommand(): string {
  const installed = path.join(
    homedir(),
    '.grok',
    'bin',
    process.platform === 'win32' ? 'grok.exe' : 'grok',
  )
  return existsSync(installed) ? installed : 'grok'
}

type GrokFrame = {
  type?: string
  data?: string
  toolCallId?: string
  toolName?: string
  title?: string
  status?: string | null
  rawInput?: { file_path?: string; command?: string }
  stopReason?: string
  sessionId?: string
  total_cost_usd?: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    reasoning_tokens?: number
    cache_read_input_tokens?: number
    total_tokens?: number
  }
}

export type GrokAdapterEvents = {
  event: [DomainEvent]
  log: [string]
}

type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd?: string; stdio: ['pipe', 'pipe', 'pipe']; windowsHide: boolean },
) => ChildProcessWithoutNullStreams

export class GrokAdapter extends EventEmitter<GrokAdapterEvents> {
  readonly #spawn: SpawnFn
  #workspacePath = ''
  #options: GrokStartOptions = {}
  /** grok's own session id, so follow-up turns resume rather than restart. */
  #sessionId: string | undefined
  #child: ChildProcessWithoutNullStreams | undefined
  /** Children we killed on purpose — their non-zero exits are not failures. */
  #intentionalKills = new WeakSet<ChildProcessWithoutNullStreams>()
  #turnCounter = 0
  /** Session instructions ride in front of the first prompt: the CLI's
   *  --system-prompt-override would REPLACE the agent's own prompt, which is
   *  more than session instructions should do. */
  #instructionsPending = false

  constructor(options: { spawn?: SpawnFn } = {}) {
    super()
    this.#spawn = options.spawn ?? spawn
  }

  get capabilities(): Capabilities {
    return GROK_CAPABILITIES
  }

  async startThread(workspacePath: string, options: GrokStartOptions = {}): Promise<Thread> {
    if (options.approval === 'auto-review') {
      throw new Error('Grok does not support automatic approval review')
    }
    this.#workspacePath = workspacePath
    this.#options = options
    this.#sessionId = undefined
    this.#instructionsPending = Boolean(options.instructions)
    return {
      id: `grok-${crypto.randomUUID()}`,
      provider: 'grok',
      workspacePath,
      createdAt: Date.now(),
    }
  }

  async sendTurn(
    threadId: string,
    text: string,
    attachments: string[] = [],
    options: GrokTurnOptions = {},
  ): Promise<string> {
    if (attachments.length) throw new Error('Grok attachments are not supported yet')
    this.#options = applyGrokTurnOptions(this.#options, options)
    const turnId = `${threadId}-turn-${++this.#turnCounter}`
    const prompt =
      this.#instructionsPending && this.#options.instructions
        ? `<system-instructions>\n${this.#options.instructions}\n</system-instructions>\n\n${text}`
        : text
    this.#instructionsPending = false
    const args = grokTurnArgs(prompt, this.#options, this.#sessionId)

    // A turn already in flight would be orphaned by the reassignment below.
    if (this.#child) this.#stop(this.#child)
    const child = this.#spawn(grokCommand(), args, {
      cwd: this.#workspacePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.#child = child

    this.emit('event', {
      type: 'turn.started',
      turn: { id: turnId, threadId, status: 'running', createdAt: Date.now() },
    })

    let sawEnd = false
    const message = new StreamedItem(`${turnId}-message`)
    const reasoning = new StreamedItem(`${turnId}-reasoning`)
    /** toolCallId -> the open item it maps to. */
    const tools = new Map<
      string,
      {
        itemId: string
        itemType: 'command' | 'file_change' | 'tool_call'
        label: string
        path?: string
      }
    >()

    readNdjson(
      child.stdout,
      (value) => {
        const frame = value as GrokFrame
        if (frame.type === 'thought' && typeof frame.data === 'string') {
          if (reasoning.push(frame.data, turnId, 'reasoning', this)) return
          return
        }
        if (frame.type === 'text' && typeof frame.data === 'string') {
          message.push(frame.data, turnId, 'message', this)
          return
        }
        if (frame.type === 'tool_call' && frame.toolCallId) {
          const name = frame.toolName ?? frame.title ?? 'tool'
          const itemType =
            name === 'write' || name === 'search_replace'
              ? 'file_change'
              : name === 'run_terminal_command'
                ? 'command'
                : 'tool_call'
          const itemId = `${turnId}-tool-${tools.size + 1}`
          const entry = {
            itemId,
            itemType,
            label: frame.title ?? name,
            ...(frame.rawInput?.file_path ? { path: frame.rawInput.file_path } : {}),
          } as const
          tools.set(frame.toolCallId, entry)
          this.emit('event', {
            type: 'item.started',
            item: {
              id: itemId,
              turnId,
              type: itemType,
              status: 'started',
              ...(itemType === 'command'
                ? { command: frame.rawInput?.command ?? entry.label }
                : {}),
              ...(itemType === 'file_change' && entry.path ? { path: entry.path } : {}),
              ...(itemType === 'tool_call' ? { text: entry.label } : {}),
              createdAt: Date.now(),
            },
          })
          return
        }
        if (frame.type === 'tool_call_update' && frame.toolCallId && frame.status) {
          const entry = tools.get(frame.toolCallId)
          if (!entry) return
          this.emit('event', {
            type: 'item.completed',
            item: {
              id: entry.itemId,
              turnId,
              type: entry.itemType,
              status: frame.status === 'failed' ? 'failed' : 'completed',
              ...(entry.itemType === 'command' ? { command: entry.label } : {}),
              ...(entry.itemType === 'file_change' && entry.path ? { path: entry.path } : {}),
              ...(entry.itemType === 'tool_call' ? { text: entry.label } : {}),
              createdAt: Date.now(),
            },
          })
          tools.delete(frame.toolCallId)
          return
        }
        if (frame.type === 'end') {
          sawEnd = true
          if (frame.sessionId) this.#sessionId = frame.sessionId
          reasoning.complete(turnId, 'reasoning', this)
          message.complete(turnId, 'message', this)
          const usage = frame.usage
          if (usage) {
            const reasoningTokens = usage.reasoning_tokens ?? 0
            this.emit('event', {
              type: 'usage.updated',
              usage: {
                ...(this.#options.model ? { model: this.#options.model } : {}),
                inputTokens: usage.input_tokens ?? 0,
                cachedInputTokens: usage.cache_read_input_tokens ?? 0,
                outputTokens: (usage.output_tokens ?? 0) + reasoningTokens,
                reasoningTokens,
                totalTokens: usage.total_tokens ?? 0,
                inputIncludesCached: false,
                ...(typeof frame.total_cost_usd === 'number'
                  ? { costUsd: frame.total_cost_usd }
                  : {}),
              },
            })
          }
          if (frame.stopReason === 'end_turn') {
            this.emit('event', { type: 'turn.completed', turnId, status: 'completed' })
          } else {
            this.emit('event', {
              type: 'thread.error',
              threadId,
              message: `Grok finished with stop reason ${frame.stopReason ?? 'unknown'}`,
            })
            this.emit('event', { type: 'turn.completed', turnId, status: 'failed' })
          }
        }
        // usage snapshots and available_commands are noise between turns.
      },
      (line) => this.emit('log', `unparsable stdout: ${line.slice(0, 200)}`),
    )

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.emit('log', chunk.trimEnd()))

    child.on('exit', (code) => {
      if (this.#child === child) this.#child = undefined
      if (this.#intentionalKills.has(child)) return
      if (sawEnd) return
      // An exit without an end frame would otherwise look like a hang.
      this.emit('event', {
        type: 'thread.error',
        threadId,
        message: `grok exited with code ${code ?? 'unknown'} before reporting a result`,
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

  /** `grok models` prints a default line plus an "Available models:" list. */
  async listModels(): Promise<Model[]> {
    return parseGrokModels(await this.#capture(['models']))
  }

  dispose(): void {
    if (this.#child) this.#stop(this.#child)
    this.#child = undefined
  }

  #stop(child: ChildProcessWithoutNullStreams): void {
    this.#intentionalKills.add(child)
    killTree(child)
  }

  #capture(args: string[], timeoutMs = 15000): Promise<string> {
    return captureGrok(this.#spawn, args, timeoutMs)
  }
}

function captureGrok(spawnFn: SpawnFn, args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(grokCommand(), args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let settled = false
    const finish = (result: string | Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      result instanceof Error ? reject(result) : resolve(result)
    }
    const timer = setTimeout(() => {
      killTree(child)
      finish(new Error('grok did not answer in time'))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.on('error', (error) => finish(error))
    child.on('exit', (code) =>
      finish(code === 0 ? stdout : new Error(`grok exited with code ${code ?? 'unknown'}`)),
    )
    child.stdin.on('error', () => undefined)
    child.stdin.end()
  })
}

/** Auth as the CLI reports it on `grok models` — nothing else is read. */
export async function grokAccount(): Promise<{ signedIn: boolean }> {
  return parseGrokAccount(await captureGrok(spawn, ['models']))
}

/** `grok logout` clears the CLI's own cached credentials. */
export async function signOutGrok(): Promise<void> {
  await captureGrok(spawn, ['logout'])
}

/** One streamed text item (message or reasoning): started lazily on the
 *  first delta, completed once, with the accumulated text. */
class StreamedItem {
  readonly #id: string
  #text = ''
  #started = false
  #completed = false

  constructor(id: string) {
    this.#id = id
  }

  push(
    delta: string,
    turnId: string,
    type: 'message' | 'reasoning',
    emitter: EventEmitter<GrokAdapterEvents>,
  ): boolean {
    if (!delta) return false
    if (!this.#started) {
      this.#started = true
      emitter.emit('event', {
        type: 'item.started',
        item: {
          id: this.#id,
          turnId,
          type,
          ...(type === 'message' ? { role: 'assistant' as const } : {}),
          status: 'started',
          text: '',
          createdAt: Date.now(),
        },
      })
    }
    this.#text += delta
    emitter.emit('event', { type: 'item.delta', turnId, itemId: this.#id, textDelta: delta })
    return true
  }

  complete(
    turnId: string,
    type: 'message' | 'reasoning',
    emitter: EventEmitter<GrokAdapterEvents>,
  ): void {
    if (!this.#started || this.#completed) return
    this.#completed = true
    emitter.emit('event', {
      type: 'item.completed',
      item: {
        id: this.#id,
        turnId,
        type,
        ...(type === 'message' ? { role: 'assistant' as const } : {}),
        status: 'completed',
        text: this.#text.trimEnd(),
        createdAt: Date.now(),
      },
    })
  }
}

/**
 * Parse `grok models`. Captured shape (grok 0.1.219):
 *
 *   You are not authenticated.
 *
 *   Default model: grok-4.5
 *
 *   Available models:
 *     * grok-4.5 (default)
 */
export function parseGrokModels(output: string): Model[] {
  const models: Model[] = []
  let reading = false
  for (const rawLine of output.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim()
    if (/^Available models:/i.test(line)) {
      reading = true
      continue
    }
    if (!reading || !line) continue
    const match = line.match(/^\*\s*(\S+)(\s+\(default\))?/)
    if (!match) continue
    const id = match[1]!
    const details = GROK_MODEL_DETAILS[id]
    models.push({
      id,
      displayName: grokDisplayName(id),
      isDefault: Boolean(match[2]),
      reasoningEfforts: details ? [...details.reasoningEfforts] : [],
      ...(details ? { defaultReasoningEffort: details.defaultReasoningEffort } : {}),
      serviceTiers: [],
    })
  }
  return models
}

/** `grok-4.5` -> "Grok 4.5" while keeping future catalog ids readable. */
export function grokDisplayName(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((token) => {
      if (token.toLowerCase() === 'grok') return 'Grok'
      if (/^\d+(?:\.\d+)*$/.test(token)) return token
      return token.charAt(0).toUpperCase() + token.slice(1)
    })
    .join(' ')
}

/** The CLI announces its own auth state on `grok models`. */
export function parseGrokAccount(output: string): { signedIn: boolean } {
  return { signedIn: !/You are not authenticated/i.test(output) }
}

export { SUPPORTED as GROK_SUPPORTED_VERSION }
