import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ApprovalMode, Capabilities, DomainEvent, Model, Thread } from '@harness/contracts'
import { readNdjson, spawnCli } from '@harness/proc'
import { CursorEventMapper, type CursorEvent } from './events.js'

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
type StartOptions = { model?: string; approval?: ApprovalMode }
type Spawn = typeof spawnCli

export class CursorAdapter extends EventEmitter<Events> {
  #workspacePath = ''
  #options: StartOptions = {}
  #sessionId: string | undefined
  #threadId: string | undefined
  #child: ChildProcessWithoutNullStreams | undefined
  #mapper: CursorEventMapper | undefined
  #turnId: string | undefined
  #turnCounter = 0
  #terminalEvent = false
  readonly #spawn: Spawn

  constructor(options: { spawn?: Spawn } = {}) {
    super()
    this.#spawn = options.spawn ?? spawnCli
  }

  get capabilities(): Capabilities {
    return CURSOR_CAPABILITIES
  }

  async startThread(workspacePath: string, options: StartOptions = {}): Promise<Thread> {
    validateApproval(options.approval)
    this.#workspacePath = workspacePath
    this.#options = options
    this.#sessionId = undefined
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
    this.#sessionId = sessionId
    this.#threadId = `cursor-${sessionId}`
    return { id: this.#threadId, provider: 'cursor', workspacePath, createdAt: Date.now() }
  }

  async sendTurn(threadId: string, text: string, attachments: string[] = []): Promise<string> {
    if (!this.#workspacePath || threadId !== this.#threadId) {
      throw new Error('Cursor session has not started')
    }
    if (this.#child) throw new Error('a turn is already running')
    if (attachments.length) throw new Error('Cursor CLI attachments are not supported')
    const turnId = `${threadId}-turn-${++this.#turnCounter}`
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      ...(this.#options.approval === 'auto' || this.#options.approval === 'full'
        ? ['--force']
        : []),
      ...(this.#options.model ? ['--model', this.#options.model] : []),
      ...(this.#sessionId ? ['--resume', this.#sessionId] : []),
      text,
    ]
    const child = this.#spawn('cursor-agent', args, { cwd: this.#workspacePath })
    this.#child = child
    this.#turnId = turnId
    this.#mapper = new CursorEventMapper(turnId)
    this.#terminalEvent = false
    this.emit('event', {
      type: 'turn.started',
      turn: { id: turnId, threadId, status: 'running', createdAt: Date.now() },
    })
    readNdjson(
      child.stdout,
      (value) => this.#onEvent(value as CursorEvent),
      (line) => this.emit('log', `unparsable stdout: ${line.slice(0, 200)}`),
    )
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.emit('log', chunk.trimEnd()))
    child.on('error', () => this.#fail('Cursor Agent CLI could not start.'))
    child.on('exit', (code) => {
      this.#child = undefined
      if (!this.#terminalEvent && this.#turnId) {
        this.#fail(`cursor-agent exited with code ${code ?? 'unknown'}`)
      }
    })
    return turnId
  }

  async interrupt(): Promise<void> {
    if (!this.#child || !this.#turnId) return
    const turnId = this.#turnId
    this.#terminalEvent = true
    this.#child.kill()
    for (const event of this.#mapper?.finish() ?? []) this.emit('event', event)
    this.emit('event', { type: 'turn.completed', turnId, status: 'interrupted' })
    this.#turnId = undefined
    this.#mapper = undefined
  }

  respondToApproval(): void {}

  async listModels(): Promise<Model[]> {
    return []
  }

  dispose(): void {
    this.#terminalEvent = true
    this.#child?.kill()
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
        this.#terminalEvent = true
        this.#turnId = undefined
        this.#mapper = undefined
      }
    }
  }

  #fail(message: string): void {
    if (!this.#turnId) return
    const turnId = this.#turnId
    this.#terminalEvent = true
    for (const event of this.#mapper?.finish() ?? []) this.emit('event', event)
    this.emit('event', { type: 'thread.error', threadId: this.#threadId!, message })
    this.emit('event', { type: 'turn.completed', turnId, status: 'failed' })
    this.#turnId = undefined
    this.#mapper = undefined
  }
}

function validateApproval(approval: ApprovalMode | undefined): void {
  if (approval === 'auto-review') {
    throw new Error('Cursor CLI does not support automatic approval review')
  }
}
