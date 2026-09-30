import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ApprovalMode, Capabilities, DomainEvent, Model, Thread } from '@harness/contracts'
import { killTree, readNdjson, runCli } from '@harness/proc'
import { CURSOR_CAPABILITIES } from './capabilities.js'
import { spawnCursorAgent } from './launch.js'
import { CursorEventMapper, CursorEventSchema, type CursorEvent } from './events.js'
import {
  collapseCursorModels,
  getCursorIndex,
  rememberCursorIndex,
  resolveCursorModel,
  type RawCursorModel,
} from './models.js'

export const CURSOR_SUPPORTED_VERSION = '2026.07'

export { CURSOR_CAPABILITIES }

type Events = { event: [DomainEvent]; log: [string] }
type StartOptions = {
  model?: string
  effort?: string
  serviceTier?: string
  approval?: ApprovalMode
  instructions?: string
}
export type CursorTurnOptions = Pick<StartOptions, 'model' | 'effort' | 'serviceTier'>
type Spawn = typeof spawnCursorAgent
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
    this.#run = options.run ?? runCli
  }

  get capabilities(): Capabilities {
    return CURSOR_CAPABILITIES
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
   * The picker stores the concrete id `cursor-agent models` printed. An older
   * selection may still be a collapsed base id plus an effort or Fast tier;
   * the CLI wants the concrete per-variant id. The mapping comes from the
   * parsed listing — normally still warm from the picker's listModels call;
   * when it is not (server restart straight into a resume), one listing run
   * restores it. A concrete id, or a base id at its defaults, passes through.
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
    if (attachments.length) throw new Error('Cursor CLI attachments are not supported')
    this.#startingTurn = true
    this.#options = applyCursorTurnOptions(this.#options, options)
    const effectiveOptions = await this.#withConcreteModel(this.#options).finally(() => {
      this.#startingTurn = false
    })
    // The previous turn's process can outlive its `result` event by a moment;
    // a lingering child must not block or clobber the new turn.
    if (this.#child) await killTree(this.#child)
    const turnId = `${threadId}-turn-${crypto.randomUUID()}`
    const prompt =
      this.#instructionsPending && this.#options.instructions
        ? `<system-instructions>\n${this.#options.instructions}\n</system-instructions>\n\n${text}`
        : text
    this.#instructionsPending = false
    // cursor-agent uses a positional prompt, and reads stdin when that
    // position is empty and stdin is not a terminal. On Windows the positional
    // form is `cmd.exe /c`, and cmd treats `<system-instructions>` and
    // `<user-design-request>` as redirection, so the model sees an empty tag
    // or a phase preamble with the typed sentence cut off. The body goes to
    // stdin. Ending stdin is required: the CLI reads until EOF, then trims.
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      ...(effectiveOptions.approval === 'auto' || effectiveOptions.approval === 'full'
        ? ['--force']
        : []),
      ...(effectiveOptions.model ? ['--model', effectiveOptions.model] : []),
      ...(this.#sessionId ? ['--resume', this.#sessionId] : []),
    ]
    const child = this.#spawn('cursor-agent', args, { cwd: this.#workspacePath })
    writePrompt(child, prompt)
    this.#child = child
    this.#turnId = turnId
    this.#mapper = new CursorEventMapper(turnId)
    this.emit('event', {
      type: 'turn.started',
      turn: { id: turnId, threadId, status: 'running', createdAt: Date.now() },
    })
    readNdjson(
      child.stdout,
      (value) => this.#onEvent(CursorEventSchema.parse(value)),
      (line) => this.emit('log', `unparsable stdout: ${line.slice(0, 200)}`),
      {
        onError: (error) => {
          this.#fail(turnId, error.message)
          void killTree(child)
        },
      },
    )
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.emit('log', chunk.trimEnd()))
    child.on('error', () => this.#fail(turnId, 'Cursor Agent CLI could not start.'))
    child.on('exit', () => {
      if (this.#child === child) this.#child = undefined
    })
    // 'close', not 'exit': at exit the stdio pipes may still hold the final
    // `result` chunk, and failing here would report a successful turn as a
    // crash. 'close' fires only once all output has been delivered.
    child.on('close', (code) => {
      if (this.#child === child) this.#child = undefined
      this.#fail(turnId, `cursor-agent exited with code ${code ?? 'unknown'}`)
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

  async listModels(): Promise<Model[]> {
    // The CLI authenticates and fetches the account catalog before it prints.
    // The shared 5s command timeout cuts that short on a cold Windows start
    // and the picker then keeps whatever shorter list it already had.
    const result = await this.#run('cursor-agent', ['models'], 20_000)
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
      this.#sessionId = event.session_id
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
 * PowerShell 5.1 pipes a native command's stdout as UTF-16 LE. Read as UTF-8,
 * that is ASCII with NUL bytes between letters, and the catalog header never
 * matches.
 */
function decodeCursorModelsOutput(output: string): string {
  const text = output.replace(/^\uFEFF/, '')
  return (text.includes('\0') ? text.replace(/\0/g, '') : text).replace(ANSI, '')
}

/**
 * Every account row printed by `cursor-agent models`.
 *
 * Codex and Grok each put one picker row on every model their signed-in
 * catalog returns. Cursor's CLI does the same thing in text: one id and
 * display name per line, including effort and fast permutations. Those rows
 * are the catalog. A collapsed index is remembered beside them so an older
 * base-id selection can still be resolved to a concrete id.
 */
export function parseCursorModels(output: string): Model[] {
  const raw: RawCursorModel[] = []
  let readingModels = false
  for (const rawLine of decodeCursorModelsOutput(output).split(/\r\n|\n|\r/)) {
    const line = rawLine.trim()
    if (/^available models:?$/i.test(line)) {
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
    if (!id || /\s/.test(id)) continue

    raw.push({
      id,
      displayName: displayName || id,
      isDefault: status?.[1]?.split(',').some((label) => label.trim() === 'default') ?? false,
    })
  }
  rememberCursorIndex(collapseCursorModels(raw).index)
  return raw.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    isDefault: model.isDefault,
    reasoningEfforts: [],
    serviceTiers: [],
  }))
}

function writePrompt(child: ChildProcessWithoutNullStreams, prompt: string): void {
  const stdin = child.stdin
  // Auth can fail before the CLI reads. The close handler reports that turn;
  // an EPIPE here must not crash the server.
  stdin.on('error', () => undefined)
  if (stdin.write(prompt, 'utf8')) {
    stdin.end()
    return
  }
  stdin.once('drain', () => {
    stdin.end()
  })
}

function validateApproval(approval: ApprovalMode | undefined): void {
  if (approval === 'auto-review') {
    throw new Error('Cursor CLI does not support automatic approval review')
  }
}
