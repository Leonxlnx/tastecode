import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ApprovalMode, Capabilities, DomainEvent, Model, Thread } from '@harness/contracts'
import { JsonRpcValueSchema, killTree, readNdjson } from '@harness/proc'
import { z } from 'zod'

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
 * directly rather than through `spawnCli`'s cmd.exe route. Prompts still do
 * not belong on argv: CreateProcess rejects long command lines even without
 * cmd.exe. Grok's `--prompt-file` keeps the exact UTF-8 text off argv.
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
  images: true,
}

const IMAGE_MIME_TYPES = new Map<string, string>([
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
])

export function grokPromptJson(text: string, attachments: string[]): string {
  return JSON.stringify([
    { type: 'text', text },
    ...attachments.map((file) => {
      const mimeType = IMAGE_MIME_TYPES.get(path.extname(file).toLowerCase())
      return mimeType
        ? {
            type: 'image',
            data: readFileSync(file).toString('base64'),
            mimeType,
            uri: pathToFileURL(file).href,
          }
        : {
            type: 'resource_link',
            name: path.basename(file),
            uri: pathToFileURL(file).href,
          }
    }),
  ])
}

/** Model-specific reasoning levels published for Grok 4.5. The CLI's global
 *  `--reasoning-effort` help lists every level understood by any model, so it
 *  cannot be the capability set for each row returned by `grok models`. */
export const GROK_EFFORTS = ['low', 'medium', 'high']
const GROK_4_6_EFFORTS = [...GROK_EFFORTS, 'xhigh']

type GrokModelDetails = {
  reasoningEfforts: readonly string[]
  defaultReasoningEffort: string
}

const GROK_MODEL_DETAILS = new Map<string, GrokModelDetails>([
  [
    'grok-4.6',
    {
      reasoningEfforts: GROK_4_6_EFFORTS,
      defaultReasoningEffort: 'high',
    },
  ],
  [
    'grok-4.5',
    {
      reasoningEfforts: GROK_EFFORTS,
      defaultReasoningEffort: 'high',
    },
  ],
])

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

/** The per-turn argv. Only a prompt file path travels through CreateProcess. */
export function grokTurnArgs(
  promptFile: string,
  options: GrokStartOptions,
  sessionId: string | undefined,
): string[] {
  return [
    '--prompt-file',
    promptFile,
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

const GrokFrameSchema = z.object({
  type: z.string().optional(),
  data: z.string().optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  title: z.string().optional(),
  status: z.string().nullable().optional(),
  rawInput: z
    .object({ file_path: z.string().optional(), command: z.string().optional() })
    .optional(),
  content: JsonRpcValueSchema.optional(),
  rawOutput: JsonRpcValueSchema.optional(),
  stopReason: z.string().optional(),
  sessionId: z.string().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      reasoning_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
})

type GrokFrame = z.infer<typeof GrokFrameSchema>

type OpenTool = {
  itemId: string
  itemType: 'command' | 'file_change' | 'tool_call'
  label: string
  command?: string
  path?: string
}

export type GrokAdapterEvents = {
  event: [DomainEvent]
  log: [string]
  /** Grok's opaque resume identity. It is not the TasteCode thread id. */
  providerSessionId: [string]
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
  /** Stable TasteCode identity, kept separate from Grok's opaque resume id. */
  #threadId: string | undefined
  /** Grok's own session id, so follow-up turns resume rather than restart. */
  #providerSessionId: string | undefined
  #child: ChildProcessWithoutNullStreams | undefined
  /** Why we killed a child: only an explicit Stop completes the turn. */
  #killReasons = new WeakMap<ChildProcessWithoutNullStreams, 'interrupt' | 'silent'>()
  #promptDirectories = new WeakMap<ChildProcessWithoutNullStreams, string>()
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
    const threadId = `grok-${crypto.randomUUID()}`
    this.#threadId = threadId
    this.#providerSessionId = undefined
    this.#instructionsPending = Boolean(options.instructions)
    return {
      id: threadId,
      provider: 'grok',
      workspacePath,
      createdAt: Date.now(),
    }
  }

  /**
   * Reattach a persisted TasteCode thread to Grok's separate native session.
   * The two ids are deliberately explicit here: passing the TasteCode id to
   * `grok -r` would start from an identity the CLI has never heard of.
   */
  async resumeThread(
    threadId: string,
    providerSessionId: string,
    workspacePath: string,
    options: GrokStartOptions = {},
  ): Promise<Thread> {
    if (options.approval === 'auto-review') {
      throw new Error('Grok does not support automatic approval review')
    }
    if (!threadId) throw new Error('TasteCode thread id is required to resume Grok')
    if (!providerSessionId) throw new Error('Grok native session id is required to resume')
    this.#workspacePath = workspacePath
    this.#options = options
    this.#threadId = threadId
    this.#providerSessionId = providerSessionId
    // The provider session already received its initial instructions. Adding
    // them to the next user message would duplicate and expose them as text.
    this.#instructionsPending = false
    return {
      id: threadId,
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
    if (threadId !== this.#threadId) {
      throw new Error(`Grok adapter is attached to a different TasteCode thread`)
    }
    this.#options = applyGrokTurnOptions(this.#options, options)
    // A process restart resets in-memory counters. Random ids cannot collide
    // with turns already persisted for this thread before the restart.
    const turnId = `${threadId}-turn-${crypto.randomUUID()}`
    const prompt =
      this.#instructionsPending && this.#options.instructions
        ? `<system-instructions>\n${this.#options.instructions}\n</system-instructions>\n\n${text}`
        : text
    this.#instructionsPending = false
    const promptDirectory = mkdtempSync(path.join(tmpdir(), 'harness-grok-'))
    const promptFile = path.join(promptDirectory, attachments.length ? 'prompt.json' : 'prompt.md')
    try {
      writeFileSync(
        promptFile,
        attachments.length ? grokPromptJson(prompt, attachments) : prompt,
        'utf8',
      )
    } catch (error) {
      rmSync(promptDirectory, { recursive: true, force: true })
      throw error
    }
    const args = grokTurnArgs(promptFile, this.#options, this.#providerSessionId)

    // A turn already in flight would be orphaned by the reassignment below.
    if (this.#child) this.#stop(this.#child)
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.#spawn(grokCommand(), args, {
        cwd: this.#workspacePath,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      rmSync(promptDirectory, { recursive: true, force: true })
      throw error
    }
    this.#promptDirectories.set(child, promptDirectory)
    this.#child = child

    this.emit('event', {
      type: 'turn.started',
      turn: { id: turnId, threadId, status: 'running', createdAt: Date.now() },
    })

    let terminal = false
    let messageCounter = 1
    let message = new StreamedItem(`${turnId}-message-${messageCounter}`)
    const reasoning = new StreamedItem(`${turnId}-reasoning`)
    let toolCounter = 0
    /** toolCallId -> the open item it maps to. */
    const tools = new Map<string, OpenTool>()
    const completeTool = (entry: OpenTool, status: 'completed' | 'failed', output?: string) => {
      this.emit('event', {
        type: 'item.completed',
        item: {
          id: entry.itemId,
          turnId,
          type: entry.itemType,
          status,
          ...(entry.itemType === 'command'
            ? {
                command: entry.command ?? entry.label,
                ...(output ? { text: output } : {}),
              }
            : {}),
          ...(entry.itemType === 'file_change' && entry.path ? { path: entry.path } : {}),
          ...(entry.itemType === 'file_change' && output ? { text: output } : {}),
          ...(entry.itemType === 'tool_call'
            ? { text: output ? `${entry.label}\n${output}` : entry.label }
            : {}),
          createdAt: Date.now(),
        },
      })
    }
    const finishItems = (status: 'completed' | 'failed') => {
      reasoning.complete(turnId, 'reasoning', this, status)
      message.complete(turnId, 'message', this, status)
      for (const entry of tools.values()) completeTool(entry, status)
      tools.clear()
    }

    readNdjson(
      child.stdout,
      (value) => {
        if (terminal) return
        const parsed = GrokFrameSchema.safeParse(value)
        if (!parsed.success) {
          this.emit('log', `unrecognized Grok frame: ${JSON.stringify(value).slice(0, 200)}`)
          return
        }
        const frame = parsed.data
        if (frame.type === 'thought' && frame.data !== undefined) {
          if (reasoning.push(frame.data, turnId, 'reasoning', this)) return
          return
        }
        if (frame.type === 'text' && frame.data !== undefined) {
          message.push(frame.data, turnId, 'message', this)
          return
        }
        if (frame.type === 'tool_call' && frame.toolCallId) {
          message.complete(turnId, 'message', this)
          message = new StreamedItem(`${turnId}-message-${++messageCounter}`)
          const name = frame.toolName ?? frame.title ?? 'tool'
          const itemType =
            name === 'write' || name === 'search_replace'
              ? 'file_change'
              : name === 'run_terminal_command'
                ? 'command'
                : 'tool_call'
          const itemId = `${turnId}-tool-${++toolCounter}`
          const entry = {
            itemId,
            itemType,
            label: frame.title ?? name,
            ...(frame.rawInput?.command
              ? {
                  command: frame.rawInput?.command,
                }
              : {}),
            ...(frame.rawInput?.file_path
              ? {
                  path: frame.rawInput?.file_path,
                }
              : {}),
          } satisfies OpenTool
          tools.set(frame.toolCallId, entry)
          this.emit('event', {
            type: 'item.started',
            item: {
              id: itemId,
              turnId,
              type: itemType,
              status: 'started',
              ...(itemType === 'command'
                ? {
                    command: frame.rawInput?.command ?? entry.label,
                  }
                : {}),
              ...(itemType === 'file_change' && entry.path
                ? {
                    path: entry.path,
                  }
                : {}),
              ...(itemType === 'tool_call' ? { text: entry.label } : {}),
              createdAt: Date.now(),
            },
          })
          return
        }
        if (frame.type === 'tool_call_update' && frame.toolCallId && frame.status) {
          const entry = tools.get(frame.toolCallId)
          if (!entry) return
          const output = grokToolOutput(frame)
          completeTool(entry, frame.status === 'failed' ? 'failed' : 'completed', output)
          tools.delete(frame.toolCallId)
          return
        }
        if (frame.type === 'end') {
          if (terminal) return
          terminal = true
          if (
            this.#child === child &&
            frame.sessionId &&
            frame.sessionId !== this.#providerSessionId
          ) {
            this.#providerSessionId = frame.sessionId
            this.emit('providerSessionId', frame.sessionId)
          }
          finishItems(frame.stopReason === 'end_turn' ? 'completed' : 'failed')
          const usage = frame.usage
          if (usage) {
            const reasoningTokens = usage.reasoning_tokens ?? 0
            this.emit('event', {
              type: 'usage.updated',
              usage: {
                ...(this.#options.model
                  ? {
                      model: this.#options.model,
                    }
                  : {}),
                inputTokens: usage.input_tokens ?? 0,
                cachedInputTokens: usage.cache_read_input_tokens ?? 0,
                outputTokens: (usage.output_tokens ?? 0) + reasoningTokens,
                reasoningTokens,
                totalTokens: usage.total_tokens ?? 0,
                inputIncludesCached: false,
                ...(frame.total_cost_usd !== undefined
                  ? {
                      costUsd: frame.total_cost_usd,
                    }
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

    child.on('close', (code) => {
      this.#cleanupPrompt(child)
      if (this.#child === child) this.#child = undefined
      if (terminal) return
      terminal = true
      const killReason = this.#killReasons.get(child)
      if (killReason === 'interrupt') {
        finishItems('failed')
        this.emit('event', { type: 'turn.completed', turnId, status: 'interrupted' })
        return
      }
      if (killReason === 'silent') {
        finishItems('failed')
        return
      }
      // An exit without an end frame would otherwise look like a hang.
      this.emit('event', {
        type: 'thread.error',
        threadId,
        message: `grok exited with code ${code ?? 'unknown'} before reporting a result`,
      })
      finishItems('failed')
      this.emit('event', { type: 'turn.completed', turnId, status: 'failed' })
    })

    // A spawn failure emits 'error' on the child; without a listener that
    // throws out of the event loop and takes the whole server down.
    child.on('error', (error) => {
      this.#cleanupPrompt(child)
      if (this.#child === child) this.#child = undefined
      if (terminal) return
      terminal = true
      const killReason = this.#killReasons.get(child)
      if (killReason === 'interrupt') {
        finishItems('failed')
        this.emit('event', { type: 'turn.completed', turnId, status: 'interrupted' })
        return
      }
      if (killReason === 'silent') {
        finishItems('failed')
        return
      }
      this.emit('event', { type: 'thread.error', threadId, message: String(error) })
      finishItems('failed')
      this.emit('event', { type: 'turn.completed', turnId, status: 'failed' })
    })

    child.stdin.end()
    return turnId
  }

  async interrupt(): Promise<void> {
    if (this.#child) this.#stop(this.#child, 'interrupt')
  }

  /** `grok models` prints a default line plus an "Available models:" list. */
  async listModels(): Promise<Model[]> {
    return parseGrokModels(await this.#capture(['models']))
  }

  dispose(): void {
    if (this.#child) this.#stop(this.#child)
    this.#child = undefined
  }

  #stop(child: ChildProcessWithoutNullStreams, reason: 'interrupt' | 'silent' = 'silent'): void {
    if (reason === 'interrupt' || !this.#killReasons.has(child))
      this.#killReasons.set(child, reason)
    killTree(child)
  }

  #cleanupPrompt(child: ChildProcessWithoutNullStreams): void {
    const directory = this.#promptDirectories.get(child)
    if (!directory) return
    this.#promptDirectories.delete(child)
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } catch (error) {
      this.emit('log', `temporary prompt cleanup failed: ${String(error)}`)
    }
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
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const timer = setTimeout(() => {
      killTree(child)
      finish(new Error('grok did not answer in time'))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.on('error', (error) => finish(error))
    child.on('close', (code) =>
      finish(code === 0 ? stdout : new Error(`grok exited with code ${code ?? 'unknown'}`)),
    )
    child.stdin.on('error', () => undefined)
    child.stdin.end()
  })
}

function grokToolOutput(frame: GrokFrame): string | undefined {
  const parts = [frame.content, frame.rawOutput]
    .map((value) => {
      if (value === null || value === undefined || value === '') return undefined
      if (Array.isArray(value) && value.length === 0) return undefined
      const text = z.string().safeParse(value)
      return text.success ? text.data : JSON.stringify(value, null, 2)
    })
    .filter((value): value is string => value !== undefined)
  const unique = [...new Set(parts)]
  return unique.length ? unique.join('\n') : undefined
}

/** Auth as the CLI reports it on `grok models` — nothing else is read. */
export type GrokAccount = { signedIn: boolean }

export async function grokAccount(): Promise<GrokAccount> {
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
    status: 'completed' | 'failed' = 'completed',
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
        status,
        text: this.#text.trimEnd(),
        createdAt: Date.now(),
      },
    })
  }
}

/**
 * Parse `grok models`. Grok 1.0 marks the default with `*` and the remaining
 * available models with `-`; 0.1 used `*` for every row.
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
  let foundModel = false
  for (const rawLine of output.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim()
    if (/^Available models:/i.test(line)) {
      reading = true
      continue
    }
    if (!reading) continue
    if (!line) {
      if (foundModel) break
      continue
    }
    const match = line.match(/^[*-]\s*(\S+)(\s+\(default\))?/)
    if (!match) {
      if (foundModel) break
      continue
    }
    foundModel = true
    const id = match[1]!
    const details = GROK_MODEL_DETAILS.get(id)
    models.push({
      id,
      displayName: grokDisplayName(id),
      isDefault: Boolean(match[2]),
      reasoningEfforts: details ? [...details.reasoningEfforts] : [],
      ...(details
        ? {
            defaultReasoningEffort: details.defaultReasoningEffort,
          }
        : {}),
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
export function parseGrokAccount(output: string): GrokAccount {
  return { signedIn: !/You are not authenticated/i.test(output) }
}

export { SUPPORTED as GROK_SUPPORTED_VERSION }
