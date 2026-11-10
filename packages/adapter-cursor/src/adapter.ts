import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import type { ApprovalMode, Capabilities, DomainEvent, Model, Thread } from '@harness/contracts'
import {
  argumentPromptLimit,
  killTree,
  ProtocolFrameError,
  readNdjson,
  type runCli,
  type spawnCli,
} from '@harness/proc'
import { CURSOR_SIGN_IN_REQUIRED, cursorNeedsSignIn } from './auth.js'
import { CursorEventMapper, CursorEventSchema, type CursorEvent } from './events.js'
import { findCursorWindowsLauncher, runCursorAgent, spawnCursorAgent } from './launch.js'
import { readCursorModels } from './listing.js'
import {
  collapseCursorModels,
  getCursorIndex,
  rememberCursorIndex,
  resolveCursorModel,
  type RawCursorModel,
} from './models.js'
import { CURSOR_CAPABILITIES } from './capabilities.js'

/**
 * The cursor-agent build line this adapter's frames were captured from. It
 * documents the wire and gates nothing: the CLI updates itself every month,
 * and a frame that no longer matches fails its turn with ProtocolFrameError.
 */
export const CURSOR_SUPPORTED_VERSION = '2026.07'

export { CURSOR_CAPABILITIES } from './capabilities.js'

const IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp'])

/** What a turn's attachments add to cursor-agent's argv and prompt. */
export type CursorAttachments = { args: string[]; files: string[] }

/**
 * Images go through cursor-agent's `--image <path>` ("Attach image(s) to a
 * headless prompt", hidden from 2026.07 help): the CLI reads each file,
 * scales it to 2048 px and sends it as JPEG pixels. Other files are named in
 * the prompt, and their folders become extra workspace roots (`--add-dir`)
 * so the agent may read them.
 */
export function cursorAttachments(attachments: readonly string[]): CursorAttachments {
  const images = attachments.filter((file) =>
    IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()),
  )
  const files = attachments.filter((file) => !images.includes(file))
  const folders = [...new Set(files.map((file) => path.dirname(file)))]
  return {
    args: [
      ...images.flatMap((file) => ['--image', file]),
      ...folders.flatMap((folder) => ['--add-dir', folder]),
    ],
    files,
  }
}

type Events = { event: [DomainEvent]; log: [string]; providerSessionId: [string] }
type StartOptions = {
  model?: string
  effort?: string
  serviceTier?: string
  approval?: ApprovalMode
  instructions?: string
}
export type CursorTurnOptions = Pick<StartOptions, 'model' | 'effort' | 'serviceTier'>
type Spawn = typeof spawnCli
type Run = typeof runCli

function applyCursorTurnOptions(current: StartOptions, next: CursorTurnOptions): StartOptions {
  if (Object.keys(next).length === 0) return current
  const merged = { ...current }
  for (const field of ['model', 'effort', 'serviceTier'] as const) {
    if (!(field in next)) continue
    const value = next[field]
    if (value === undefined) delete merged[field]
    else merged[field] = value
  }
  return merged
}

export class CursorAdapter extends EventEmitter<Events> {
  #processStop: Promise<void> = Promise.resolve()
  #workspacePath = ''
  #options: StartOptions = {}
  #sessionId: string | undefined
  #threadId: string | undefined
  #child: ChildProcessWithoutNullStreams | undefined
  #mapper: CursorEventMapper | undefined
  #turnId: string | undefined
  #startingTurn = false
  #instructionsPending = false
  readonly #spawn: Spawn
  readonly #run: Run

  constructor(options: { spawn?: Spawn; run?: Run } = {}) {
    super()
    this.#spawn = options.spawn ?? spawnCursorAgent
    this.#run = options.run ?? runCursorAgent
  }

  get capabilities(): Capabilities {
    return CURSOR_CAPABILITIES
  }

  /**
   * The prompt is the last argument of every turn's command line. Without
   * its bundled node.exe, Windows runs the CLI through a batch shim, whose
   * cmd.exe line holds 8,191 characters.
   */
  get promptLimit(): number {
    return process.platform === 'win32' && !findCursorWindowsLauncher()
      ? 7_000
      : argumentPromptLimit()
  }

  /**
   * The cursor-agent chat id once the CLI reported one. A new thread's own id
   * is chosen before the first turn and names no chat; resuming needs this one.
   */
  get providerSessionId(): string | undefined {
    return this.#sessionId
  }

  /** Called with the chat id whenever the CLI reports a new one, and at once if known. */
  onProviderSessionId(listener: (providerSessionId: string) => void): void {
    this.on('providerSessionId', listener)
    if (this.#sessionId) listener(this.#sessionId)
  }

  async startThread(workspacePath: string, options: StartOptions = {}): Promise<Thread> {
    validateApproval(options.approval)
    this.#workspacePath = workspacePath
    this.#options = options
    await this.#withConcreteModel(options)
    this.#sessionId = undefined
    this.#instructionsPending = Boolean(options.instructions)
    this.#threadId = `cursor-${crypto.randomUUID()}`
    return {
      id: this.#threadId,
      provider: 'cursor',
      workspacePath,
      createdAt: Date.now(),
    }
  }

  async resumeThread(
    threadId: string,
    workspacePath: string,
    options: StartOptions = {},
  ): Promise<Thread> {
    validateApproval(options.approval)
    const sessionId = threadId.startsWith('cursor-') ? threadId.slice(7) : threadId
    if (!sessionId) throw new Error('Cursor session id is missing')
    this.#workspacePath = workspacePath
    this.#options = options
    await this.#withConcreteModel(options)
    this.#sessionId = sessionId
    this.#instructionsPending = false
    this.#threadId = `cursor-${sessionId}`
    return { id: this.#threadId, provider: 'cursor', workspacePath, createdAt: Date.now() }
  }

  /**
   * Model ids in the catalog are collapsed base models; the CLI wants the
   * concrete per-variant id. The mapping comes from the parsed listing —
   * normally still warm from the picker's listModels call; when it is not
   * (server restart straight into a resume), one listing run restores it.
   * Selections at the model's defaults pass through without any of this.
   */
  async #withConcreteModel(options: StartOptions): Promise<StartOptions> {
    if (!options.model || (!options.effort && !options.serviceTier)) return options
    if (!getCursorIndex()) {
      try {
        await this.listModels()
      } catch {
        // The turn still runs on the base id; only the effort/tier override
        // is lost, and the CLI reports an unknown id itself if it must.
      }
    }
    return {
      ...options,
      model: resolveCursorModel(
        getCursorIndex(),
        options.model,
        options.effort,
        options.serviceTier,
      ),
    }
  }

  async sendTurn(
    threadId: string,
    text: string,
    attachments: string[] = [],
    options: CursorTurnOptions = {},
  ): Promise<string> {
    if (!this.#workspacePath || threadId !== this.#threadId) {
      throw new Error('Cursor session has not started')
    }
    if (this.#turnId || this.#startingTurn) throw new Error('a turn is already running')
    this.#startingTurn = true
    this.#options = applyCursorTurnOptions(this.#options, options)
    const effectiveOptions = await this.#withConcreteModel(this.#options).finally(() => {
      this.#startingTurn = false
    })
    // The previous turn's process can outlive its `result` event by a moment;
    // a lingering child must not block or clobber the new turn.
    if (this.#child) await killTree(this.#child)
    const turnId = `${threadId}-turn-${crypto.randomUUID()}`
    const attached = cursorAttachments(attachments)
    const request = attached.files.length
      ? `${text}\n\nAttached files:\n${attached.files.map((file) => `- ${file}`).join('\n')}`
      : text
    const prompt =
      this.#instructionsPending && this.#options.instructions
        ? `<system-instructions>\n${this.#options.instructions}\n</system-instructions>\n\n${request}`
        : request
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      ...(effectiveOptions.approval === 'auto' || effectiveOptions.approval === 'full'
        ? ['--force']
        : []),
      ...(effectiveOptions.model ? ['--model', effectiveOptions.model] : []),
      ...(this.#sessionId ? ['--resume', this.#sessionId] : []),
      ...attached.args,
      // The CLI reads a prompt that starts with "-" as an option and exits
      // with "error: unknown option" (a list, "--- notes", "-1 is wrong").
      // After "--" everything is the prompt.
      '--',
      prompt,
    ]
    const child = this.#spawn('cursor-agent', args, { cwd: this.#workspacePath })
    // The instructions count as sent only once the CLI has started; a spawn
    // that throws keeps them for the retry.
    this.#instructionsPending = false
    this.#child = child
    this.#turnId = turnId
    this.#mapper = new CursorEventMapper(turnId)
    this.emit('event', {
      type: 'turn.started',
      turn: { id: turnId, threadId, status: 'running', createdAt: Date.now() },
    })
    const exitReason = new CursorExitReason()
    readNdjson(
      child.stdout,
      (value) => this.#onEvent(CursorEventSchema.parse(value)),
      (line) => {
        exitReason.addLine(line)
        this.emit('log', `unparsable stdout: ${line.slice(0, 200)}`)
      },
      {
        onError: (error) => {
          // A frame that does not match the schema, or a throwing event
          // listener, leaves the stream intact; keep reading it.
          if (!(error instanceof ProtocolFrameError)) {
            this.emit('log', `Cursor event handling failed: ${error.message}`)
            return
          }
          this.#fail(turnId, error.message)
          void killTree(child)
        },
      },
    )
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      exitReason.addChunk(chunk)
      this.emit('log', chunk.trimEnd())
    })
    child.on('error', () => this.#fail(turnId, 'Cursor Agent CLI could not start.'))
    child.on('exit', () => {
      if (this.#child === child) this.#child = undefined
    })
    // 'close', not 'exit': at exit the stdio pipes may still hold the final
    // `result` chunk, and failing here would report a successful turn as a
    // crash. 'close' fires only once all output has been delivered, the
    // plain-text reason of a refused turn included.
    child.on('close', (code) => {
      if (this.#child === child) this.#child = undefined
      const reason = code === 0 ? undefined : exitReason.text()
      this.#fail(turnId, reason ?? `cursor-agent exited with code ${code ?? 'unknown'}`)
    })
    return turnId
  }

  async interrupt(): Promise<void> {
    if (!this.#child || !this.#turnId) return
    const turnId = this.#turnId
    const stopped = killTree(this.#child)
    this.#processStop = stopped
    this.#child = undefined
    for (const event of this.#mapper?.finish() ?? []) this.emit('event', event)
    this.emit('event', { type: 'turn.completed', turnId, status: 'interrupted' })
    this.#turnId = undefined
    this.#mapper = undefined
    await stopped
  }

  respondToApproval(): void {}

  /** Shares its read with the sign-in check and any other picker (listing.ts). */
  async listModels(): Promise<Model[]> {
    const result = await readCursorModels(this.#run)
    if (cursorNeedsSignIn(result)) throw new Error(CURSOR_SIGN_IN_REQUIRED)
    if (result.code !== 0) throw new Error('Cursor model discovery failed')
    return parseCursorModels(result.stdout)
  }

  dispose(): Promise<void> {
    const stopped = this.#child ? killTree(this.#child) : this.#processStop
    this.#child = undefined
    this.#threadId = undefined
    this.#turnId = undefined
    this.#mapper = undefined
    this.#processStop = stopped
    return stopped
  }

  #onEvent(event: CursorEvent): void {
    if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
      if (event.session_id === this.#sessionId) return
      this.#sessionId = event.session_id
      this.emit('providerSessionId', event.session_id)
      return
    }
    if (!this.#mapper) return
    for (const domainEvent of this.#mapper.translate(event)) {
      this.emit('event', domainEvent)
      if (domainEvent.type === 'turn.completed') {
        this.#turnId = undefined
        this.#mapper = undefined
      }
    }
  }

  /** No-op unless `turnId` is still the live turn — late exits from a
   *  finished or replaced turn must not fail whatever runs now. */
  #fail(turnId: string, message: string): void {
    if (this.#turnId !== turnId) return
    for (const event of this.#mapper?.finish() ?? []) this.emit('event', event)
    this.emit('event', { type: 'thread.error', threadId: this.#threadId!, message })
    this.emit('event', { type: 'turn.completed', turnId, status: 'failed' })
    this.#turnId = undefined
    this.#mapper = undefined
  }
}

// oxlint-disable-next-line no-control-regex, no-useless-escape -- ANSI parsing requires ESC.
const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g

/**
 * Parse the account-specific rows printed by `cursor-agent models`, collapsed
 * to base models. The variant map behind the collapse is remembered for the
 * session that later has to resolve a selection back to a concrete id.
 */
export function parseCursorModels(output: string): Model[] {
  const raw: RawCursorModel[] = []
  let readingModels = false
  for (const rawLine of output.replace(ANSI, '').split(/\r\n|\n|\r/)) {
    const line = rawLine.trim()
    if (line === 'Available models') {
      readingModels = true
      continue
    }
    if (!readingModels || !line) continue
    if (line.startsWith('Tip:')) break

    const status = line.match(/\s+\(((?:current|default)(?:,\s*(?:current|default))*)\)$/)
    const details = status ? line.slice(0, -status[0].length) : line
    const separator = details.indexOf(' - ')
    const id = (separator < 0 ? details : details.slice(0, separator)).trim()
    const displayName = (separator < 0 ? id : details.slice(separator + 3)).trim()
    if (!id || /\s/.test(id) || /^auto(?:matic)?$/i.test(id)) continue

    raw.push({
      id,
      displayName: displayName || id,
      isDefault: status?.[1]?.split(',').some((label) => label.trim() === 'default') ?? false,
    })
  }
  const { models, index } = collapseCursorModels(raw)
  rememberCursorIndex(index)
  return models
}

function validateApproval(approval: ApprovalMode | undefined): void {
  if (approval === 'auto-review') {
    throw new Error('Cursor CLI does not support automatic approval review')
  }
}

/** How much of the CLI's own words a failed turn's message carries. */
const REASON_LIMIT = 400
const REASON_LINES = 6
/**
 * A typed "ActionRequiredError: …" (its class in group 1), a plain "Error: …",
 * or commander's "error: …".
 */
const ERROR_LINE = /^(?:([A-Z][\w$]*)Error|[Ee]rror):\s*(\S.*)$/

/**
 * Why cursor-agent ended a turn it never ran, in its own words. A turn the
 * CLI refuses ends with exit code 1 and no `result` frame; the reason is
 * plain text, on stderr or as a stdout line that is not JSON. 2026.07.23-e383d2b
 * printed "ActionRequiredError: Kimi K3 is not included in your weekly usage …"
 * for a model outside the plan (2026-11-04), and a multi-line notice for a
 * folder it does not trust. After the cause it may add a generic "Error:
 * command failed unexpectedly." (Gemini 4 Argon, 2026-11-04), so the first
 * typed `…Error:` line wins, then the first plain `Error:` line, either
 * without its class name; otherwise the last few lines are joined. Typed
 * beats plain whatever the order, since the two may come on different pipes.
 */
class CursorExitReason {
  #partial = ''
  #lines: string[] = []
  #typedError: string | undefined
  #plainError: string | undefined

  /** A stderr chunk, which can end mid-line. */
  addChunk(chunk: string): void {
    const lines = `${this.#partial}${chunk}`.split(/\r\n|\n|\r/)
    // Only a line's start is ever used, so an endless line stays bounded.
    this.#partial = (lines.pop() ?? '').slice(0, REASON_LIMIT * 2)
    for (const line of lines) this.addLine(line)
  }

  addLine(raw: string): void {
    const line = raw
      .replace(ANSI, '')
      .trim()
      .slice(0, REASON_LIMIT + 1)
    // Blank lines, rules and box borders say nothing.
    if (!/[\p{L}\p{N}]/u.test(line)) return
    const error = ERROR_LINE.exec(line)
    if (error?.[1]) this.#typedError ??= error[2]
    else if (error) this.#plainError ??= error[2]
    this.#lines = [...this.#lines, line].slice(-REASON_LINES)
  }

  /** The reason as one short paragraph, or undefined when the CLI printed nothing useful. */
  text(): string | undefined {
    this.addChunk('\n')
    let text = this.#typedError ?? this.#plainError
    if (!text) {
      // The newest lines, as many as fit; a notice ends with what to do.
      const kept: string[] = []
      for (const line of this.#lines.toReversed()) {
        if (kept.length && [line, ...kept].join(' ').length > REASON_LIMIT) break
        kept.unshift(line)
      }
      text = kept.join(' ')
    }
    if (!text) return undefined
    return text.length > REASON_LIMIT ? `${text.slice(0, REASON_LIMIT - 1).trimEnd()}…` : text
  }
}
