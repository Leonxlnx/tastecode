import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ApprovalMode, Capabilities, DomainEvent, Model, Thread } from '@harness/contracts'
import { killTree, readNdjson, runCli, spawnCli } from '@harness/proc'
import { toDomainEvents, type ClaudeEvent } from './events.js'

/**
 * Tier 3 adapter: drives the `claude` CLI in headless streaming mode.
 *
 * Unlike Codex there is no protocol server and no generated types — this reads
 * NDJSON off stdout and is coupled to an output shape we do not control. Every
 * field is treated as optional and anything unrecognised is ignored rather
 * than fatal, because the shape will change and a session dying on an unknown
 * event is a worse failure than a missing row.
 *
 * Nothing multi-line may ever go on argv: on Windows `spawnCli` runs through a
 * cmd.exe shim, and cmd.exe cuts the assembled command line at the first
 * newline inside any argument — silently dropping the rest of that argument
 * and every argument after it (#372). The prompt therefore travels over stdin
 * as stream-json input, and the session instructions travel as a file path via
 * `--append-system-prompt-file`.
 *
 * Verified against claude-code 2.1.220; stdin stream-json prompt delivery,
 * `--resume` alongside it, `--append-system-prompt-file`, and base64 image
 * content blocks captured against 2.1.222 on Windows through the real cmd.exe
 * spawn path.
 *
 * As with Codex, this never reads a credential. The binary authenticates
 * itself. See rules/security.md.
 */

const SUPPORTED = '2.1'

export const CLAUDE_CAPABILITIES: Capabilities = {
  // No steer or fork over the CLI surface: those are protocol features Codex
  // has and this does not. The UI reads capabilities and hides what is absent
  // rather than offering a button that fails.
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: true,
  approvals: false,
  images: true,
}

/**
 * The first four are the family aliases `claude --model` documents. They track
 * the newest model in that family, while their display names spell out the
 * current version. Below them sit pinned previous models. Current as of
 * claude-code 2.1.222.
 *
 * Effort levels come from the docs' per-model table (docs/en/model-config):
 * every effort-capable model takes low..max, the 4.6 generation lacks xhigh,
 * and the default is high everywhere except Opus 4.7 (xhigh).
 */
const FULL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const CLAUDE_MODELS: Model[] = [
  claudeAlias('fable', 'Fable 5', 'Most capable — flagship tier', FULL_EFFORTS, true),
  claudeAlias('opus', 'Opus 5', 'Deep reasoning', FULL_EFFORTS),
  claudeAlias('sonnet', 'Sonnet 5', 'Balanced speed and capability', FULL_EFFORTS),
  // Haiku is absent from the docs' effort table; models not listed there do
  // not support effort, so it gets no slider rather than a dead one.
  claudeAlias('haiku', 'Haiku 4.5', 'Fastest and cheapest', []),
  claudeAlias('claude-opus-4-8', 'Opus 4.8', 'Previous Opus generation', FULL_EFFORTS),
  claudeAlias('claude-opus-4-7', 'Opus 4.7', 'Older Opus generation', FULL_EFFORTS, false, 'xhigh'),
  claudeAlias('claude-opus-4-6', 'Opus 4.6', 'Older Opus generation', [
    'low',
    'medium',
    'high',
    'max',
  ]),
  claudeAlias('claude-sonnet-4-6', 'Sonnet 4.6', 'Previous Sonnet generation', [
    'low',
    'medium',
    'high',
    'max',
  ]),
]

function claudeAlias(
  id: string,
  displayName: string,
  description: string,
  reasoningEfforts: string[],
  isDefault = false,
  defaultReasoningEffort = 'high',
): Model {
  return {
    id,
    displayName,
    description,
    isDefault,
    reasoningEfforts,
    serviceTiers: [],
    ...(reasoningEfforts.length > 0 ? { defaultReasoningEffort } : {}),
  }
}

/** Claude Code names its permission modes differently; ours map on cleanly. */
const PERMISSION_MODE: Partial<Record<ApprovalMode, string>> = {
  ask: 'default',
  auto: 'acceptEdits',
  full: 'bypassPermissions',
}

export type ClaudeAdapterEvents = {
  event: [DomainEvent]
  log: [string]
}

export type ClaudeStartOptions = {
  instructions?: string | undefined
  model?: string | undefined
  effort?: string | undefined
  approval?: ApprovalMode | undefined
}

export type ClaudeTurnOptions = Pick<ClaudeStartOptions, 'model' | 'effort'>

type SpawnFn = typeof spawnCli
type RunFn = typeof runCli

function applyClaudeTurnOptions(
  current: ClaudeStartOptions,
  next: ClaudeTurnOptions,
): ClaudeStartOptions {
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

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

/** One stream-json stdin line: how the prompt and attachments reach the CLI, never argv. */
export function claudeUserMessage(text: string, attachments: string[] = []): string {
  const files = attachments.filter((file) => !IMAGE_MIME_TYPES[path.extname(file).toLowerCase()])
  const prompt = files.length
    ? `${text}\n\nAttached file paths:\n${files.map((file) => `- ${JSON.stringify(file)}`).join('\n')}`
    : text
  return `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...attachments.flatMap((file) => {
          const mediaType = IMAGE_MIME_TYPES[path.extname(file).toLowerCase()]
          return mediaType
            ? [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mediaType,
                    data: readFileSync(file).toString('base64'),
                  },
                },
              ]
            : []
        }),
      ],
    },
  })}\n`
}

/**
 * The per-turn argv. Exported for the test that holds the #372 invariant:
 * no element may ever contain a newline, because cmd.exe would truncate the
 * command line there and silently drop every argument after it.
 */
export function claudeTurnArgs(
  options: ClaudeStartOptions,
  sessionId: string | undefined,
  instructionsFile: string | undefined,
): string[] {
  const permissionMode = options.approval ? PERMISSION_MODE[options.approval] : undefined
  return [
    '-p',
    '--output-format',
    'stream-json',
    // Required alongside stream-json, and it is what surfaces tool calls at
    // all rather than only the final answer.
    '--verbose',
    '--input-format',
    'stream-json',
    ...(options.model ? ['--model', options.model] : []),
    // Documented session flag (low, medium, high, xhigh, max); the CLI clamps
    // levels a model does not support to its nearest lower one itself.
    ...(options.effort ? ['--effort', options.effort] : []),
    ...(permissionMode ? ['--permission-mode', permissionMode] : []),
    ...(instructionsFile ? ['--append-system-prompt-file', instructionsFile] : []),
    // Continuity: without this every turn starts a fresh context and the
    // agent forgets the conversation it is in the middle of.
    ...(sessionId ? ['--resume', sessionId] : []),
  ]
}

/** Values the installed Claude Code binary publishes for `--effort`. */
export function parseClaudeEfforts(output: string): string[] {
  const match = output.match(/--effort\s+<[^>]+>[\s\S]{0,200}?\(([^)]+)\)/i)
  if (!match?.[1]) return []
  return [
    ...new Set(
      match[1]
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ]
}

function claudeModelsForEfforts(available: string[]): Model[] {
  const supported = new Set(available)
  return CLAUDE_MODELS.map((model) => {
    const reasoningEfforts = model.reasoningEfforts.filter((effort) => supported.has(effort))
    const next = { ...model, reasoningEfforts }
    delete next.defaultReasoningEffort
    if (reasoningEfforts.length > 0) {
      const defaultIndex = model.reasoningEfforts.indexOf(model.defaultReasoningEffort ?? '')
      const nearestDefault = reasoningEfforts.reduce((best, effort) =>
        Math.abs(model.reasoningEfforts.indexOf(effort) - defaultIndex) <
        Math.abs(model.reasoningEfforts.indexOf(best) - defaultIndex)
          ? effort
          : best,
      )
      next.defaultReasoningEffort =
        model.defaultReasoningEffort && supported.has(model.defaultReasoningEffort)
          ? model.defaultReasoningEffort
          : nearestDefault
    }
    return next
  })
}

export class ClaudeCodeAdapter extends EventEmitter<ClaudeAdapterEvents> {
  readonly #spawn: SpawnFn
  readonly #run: RunFn
  #workspacePath = ''
  #options: ClaudeStartOptions = {}
  #reportedModel: string | undefined
  /** Claude Code's own session id, so follow-up turns resume rather than restart. */
  #sessionId: string | undefined
  #child: ChildProcessWithoutNullStreams | undefined
  /** Children we killed on purpose — their non-zero exits are not failures. */
  #intentionalKills = new WeakSet<ChildProcessWithoutNullStreams>()
  #turnCounter = 0
  /** Where the multi-line session instructions live, since argv cannot carry them. */
  #instructionsDir: string | undefined
  #instructionsFile: string | undefined

  constructor(options: { spawn?: SpawnFn; run?: RunFn } = {}) {
    super()
    this.#spawn = options.spawn ?? spawnCli
    this.#run = options.run ?? runCli
  }

  get capabilities(): Capabilities {
    return CLAUDE_CAPABILITIES
  }

  /**
   * There is no long-lived process to start. A turn is one invocation, and
   * continuity comes from `--resume` with the session id the CLI hands back.
   */
  async startThread(workspacePath: string, options: ClaudeStartOptions = {}): Promise<Thread> {
    if (options.approval === 'auto-review') {
      throw new Error('Claude Code does not support automatic approval review')
    }
    this.#workspacePath = workspacePath
    this.#options = options
    this.#reportedModel = options.model
    this.#sessionId = undefined
    this.#clearInstructionsFile()
    if (options.instructions) {
      try {
        this.#instructionsDir = mkdtempSync(path.join(tmpdir(), 'harness-claude-'))
        this.#instructionsFile = path.join(this.#instructionsDir, 'system-prompt.md')
        writeFileSync(this.#instructionsFile, options.instructions, 'utf8')
      } catch (error) {
        // Style guidance is not worth failing the thread over; run without it.
        this.#clearInstructionsFile()
        this.emit('log', `session instructions dropped: ${String(error)}`)
      }
    }
    return {
      id: `claude-${crypto.randomUUID()}`,
      provider: 'claude-code',
      workspacePath,
      createdAt: Date.now(),
    }
  }

  async sendTurn(
    threadId: string,
    text: string,
    attachments: string[] = [],
    options: ClaudeTurnOptions = {},
  ): Promise<string> {
    this.#options = applyClaudeTurnOptions(this.#options, options)
    const userMessage = claudeUserMessage(text, attachments)
    if ('model' in options) this.#reportedModel = this.#options.model
    const turnId = `${threadId}-turn-${++this.#turnCounter}`
    const args = claudeTurnArgs(this.#options, this.#sessionId, this.#instructionsFile)

    // A turn already in flight would be orphaned by the reassignment below —
    // its exit handler must also not clobber the new child's reference.
    if (this.#child) this.#stop(this.#child)
    const child = this.#spawn('claude', args, { cwd: this.#workspacePath })
    this.#child = child

    this.emit('event', {
      type: 'turn.started',
      turn: { id: turnId, threadId, status: 'running', createdAt: Date.now() },
    })

    readNdjson(
      child.stdout,
      (value) => this.#onEvent(value as ClaudeEvent, turnId),
      (line) => this.emit('log', `unparsable stdout: ${line.slice(0, 200)}`),
    )

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.emit('log', chunk.trimEnd()))

    child.on('exit', (code) => {
      if (this.#child === child) this.#child = undefined
      // A non-zero exit without a `result` event means the CLI failed before
      // it could report anything, and silence would look like a hang. But an
      // exit WE caused is not a failure: taskkill reports code 1, and the old
      // check wrote a phantom "claude exited with code 1" into the transcript
      // on every Stop, close, and turn replacement.
      if (this.#intentionalKills.has(child)) return
      if (code !== 0 && code !== null) {
        this.emit('event', {
          type: 'thread.error',
          threadId,
          message: `claude exited with code ${code}`,
        })
        this.emit('event', { type: 'turn.completed', turnId, status: 'failed' })
      }
    })

    // A spawn failure emits 'error' on the child; without a listener that
    // throws out of the event loop and takes the whole server down.
    child.on('error', (error) => {
      if (this.#child === child) this.#child = undefined
      this.emit('event', { type: 'thread.error', threadId, message: String(error) })
      this.emit('event', { type: 'turn.completed', turnId, status: 'failed' })
    })

    // A child that dies before reading stdin surfaces EPIPE here; the exit
    // handler already reports that failure, so the write error is only noise.
    child.stdin.on('error', () => undefined)
    child.stdin.write(userMessage)
    child.stdin.end()

    return turnId
  }

  async interrupt(): Promise<void> {
    if (this.#child) this.#stop(this.#child)
  }

  /**
   * Models are not enumerable over this surface — there is no equivalent of
   * Codex's model/list — but `--model` documents stable aliases that always
   * point at the newest model of each family. The per-model table above is
   * intersected with this installed binary's own `--effort` values so removed
   * levels disappear rather than becoming dead slider stops.
   */
  async listModels(): Promise<Model[]> {
    try {
      const result = await this.#run('claude', ['--help'])
      const efforts = result.code === 0 ? parseClaudeEfforts(result.stdout) : []
      return efforts.length > 0 ? claudeModelsForEfforts(efforts) : CLAUDE_MODELS
    } catch (error) {
      this.emit('log', `Claude effort discovery fell back to known values: ${String(error)}`)
      return CLAUDE_MODELS
    }
  }

  dispose(): void {
    if (this.#child) this.#stop(this.#child)
    this.#child = undefined
    this.#clearInstructionsFile()
  }

  #clearInstructionsFile(): void {
    if (this.#instructionsDir) {
      try {
        rmSync(this.#instructionsDir, { recursive: true, force: true })
      } catch {
        // A leftover temp directory is not worth surfacing; the OS sweeps it.
      }
    }
    this.#instructionsDir = undefined
    this.#instructionsFile = undefined
  }

  /** Kill a child we own on purpose, and remember that its exit is ours. */
  #stop(child: ChildProcessWithoutNullStreams): void {
    this.#intentionalKills.add(child)
    killTree(child)
  }

  #onEvent(event: ClaudeEvent, turnId: string): void {
    if (event.message?.model) this.#reportedModel = event.message.model
    // The init event carries the session id we need for the next turn.
    if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
      this.#sessionId = event.session_id
      const version = String((event as { claude_code_version?: string }).claude_code_version ?? '')
      if (version && !version.startsWith(SUPPORTED)) {
        this.emit(
          'log',
          `claude-code ${version} is newer than the ${SUPPORTED}.x this adapter was written against`,
        )
      }
      return
    }

    if (event.type === 'rate_limit_event') {
      const info = (event as { rate_limit_info?: { utilization?: number } }).rate_limit_info
      if (info?.utilization && info.utilization > 0.9) {
        this.emit('log', `rate limit at ${Math.round(info.utilization * 100)}%`)
      }
      return
    }

    for (const domainEvent of toDomainEvents(event, turnId)) {
      if (domainEvent.type === 'usage.updated' && this.#reportedModel) {
        this.emit('event', {
          ...domainEvent,
          usage: { ...domainEvent.usage, model: this.#reportedModel },
        })
      } else {
        this.emit('event', domainEvent)
      }
    }
  }
}
