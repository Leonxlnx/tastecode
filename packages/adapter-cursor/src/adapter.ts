import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ApprovalMode, Capabilities, DomainEvent, Model, Thread } from '@harness/contracts'
import { killTree, readNdjson, runCli, spawnCli } from '@harness/proc'
import { CursorEventMapper, CursorEventSchema, type CursorEvent } from './events.js'
import {
  collapseCursorModels,
  getCursorIndex,
  rememberCursorIndex,
  resolveCursorModel,
  type RawCursorModel,
} from './models.js'

export const CURSOR_SUPPORTED_VERSION = '2026.07'

export const CURSOR_CAPABILITIES: Capabilities = {
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: false,
  approvals: false,
  images: false,
}

type Events = { event: [DomainEvent]; log: [string] }
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
  #workspacePath = ''
  #options: StartOptions = {}
  #sessionId: string | undefined
  #threadId: string | undefined
  #child: ChildProcessWithoutNullStreams | undefined
  #mapper: CursorEventMapper | undefined
  #turnId: string | undefined
  #startingTurn = false
  #turnCounter = 0
  #instructionsPending = false
  readonly #spawn: Spawn
  readonly #run: Run

  constructor(options: { spawn?: Spawn; run?: Run } = {}) {
    super()
    this.#spawn = options.spawn ?? spawnCli
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
    if (attachments.length) throw new Error('Cursor CLI attachments are not supported')
    this.#startingTurn = true
    this.#options = applyCursorTurnOptions(this.#options, options)
    const effectiveOptions = await this.#withConcreteModel(this.#options).finally(() => {
      this.#startingTurn = false
    })
    // The previous turn's process can outlive its `result` event by a moment;
    // a lingering child must not block or clobber the new turn.
    if (this.#child) killTree(this.#child)
    const turnId = `${threadId}-turn-${++this.#turnCounter}`
    const prompt =
      this.#instructionsPending && this.#options.instructions
        ? `<system-instructions>\n${this.#options.instructions}\n</system-instructions>\n\n${text}`
        : text
    this.#instructionsPending = false
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      ...(effectiveOptions.approval === 'auto' || effectiveOptions.approval === 'full'
        ? ['--force']
        : []),
      ...(effectiveOptions.model ? ['--model', effectiveOptions.model] : []),
      ...(this.#sessionId ? ['--resume', this.#sessionId] : []),
      prompt,
    ]
    const child = this.#spawn('cursor-agent', args, { cwd: this.#workspacePath })
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
    killTree(this.#child)
    this.#child = undefined
    for (const event of this.#mapper?.finish() ?? []) this.emit('event', event)
    this.emit('event', { type: 'turn.completed', turnId, status: 'interrupted' })
    this.#turnId = undefined
    this.#mapper = undefined
  }

  respondToApproval(): void {}

  async listModels(): Promise<Model[]> {
    const result = await this.#run('cursor-agent', ['models'])
    if (result.code !== 0) throw new Error('Cursor model discovery failed')
    return parseCursorModels(result.stdout)
  }

  dispose(): void {
    if (this.#child) killTree(this.#child)
    this.#child = undefined
    this.#threadId = undefined
    this.#turnId = undefined
    this.#mapper = undefined
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
