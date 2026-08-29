import { randomUUID } from 'node:crypto'
import { spawn, type IPty } from 'node-pty'
import {
  cleanupExitedPtySession,
  desktopPath,
  ownPtySession,
  terminatePtySession,
} from '@harness/proc'

const DEFAULT_CLOSE_TIMEOUT_MS = 10_000
const DEFAULT_OUTPUT_BATCH_DELAY_MS = 4
const DEFAULT_OUTPUT_BATCH_SIZE = 64 * 1024
type SpawnPty = typeof spawn
type TerminatePty = (process: IPty) => Promise<void>

const spawnOwnedPty: SpawnPty = (file, args, options) => {
  const process = spawn(file, args, options)
  try {
    return ownPtySession(process)
  } catch (ownershipError) {
    try {
      process.kill()
    } catch (cleanupError) {
      throw new AggregateError(
        [ownershipError, cleanupError],
        `failed to own or stop PTY ${process.pid}`,
      )
    }
    throw ownershipError
  }
}

type TerminalEntry = {
  threadId: string
  process: IPty
  output: { dispose(): void }
  outputBuffer: TerminalOutputBuffer
  exited: Promise<void>
  hasExited: boolean
}

/**
 * Coalesce a burst of native PTY chunks into frame-sized renderer updates.
 * node-pty can emit thousands of tiny chunks during command output; forwarding
 * each one as its own JSON/WebSocket message costs far more than parsing the
 * same bytes in xterm. Interactive output still flushes within four
 * milliseconds, while sustained output flushes at 64 KiB to keep memory and
 * latency bounded.
 */
export class TerminalOutputBuffer {
  #chunks: string[] = []
  #length = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #disposed = false

  constructor(
    private readonly emit: (data: string) => void,
    private readonly delayMs = DEFAULT_OUTPUT_BATCH_DELAY_MS,
    private readonly maximumSize = DEFAULT_OUTPUT_BATCH_SIZE,
  ) {}

  push(data: string): void {
    if (this.#disposed || data.length === 0) return
    this.#chunks.push(data)
    this.#length += data.length
    if (this.#length >= this.maximumSize) {
      this.flush()
      return
    }
    this.#timer ??= setTimeout(() => this.flush(), this.delayMs)
  }

  flush(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    if (this.#length === 0 || this.#disposed) return
    const data = this.#chunks.join('')
    this.#chunks = []
    this.#length = 0
    this.emit(data)
  }

  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#chunks = []
    this.#length = 0
    this.#disposed = true
  }
}

export class TerminalManager {
  #byId = new Map<string, TerminalEntry>()
  #byThread = new Map<string, string>()
  #closingById = new Map<string, Promise<void>>()
  #closingByThread = new Map<string, Set<Promise<void>>>()
  #closingThreads = new Map<string, Promise<void>>()
  #closingAll: Promise<void> | undefined
  #onOutput: (terminalId: string, data: string) => void
  #onExit: (terminalId: string, exitCode: number | null) => void
  #spawnPty: SpawnPty
  #terminatePty: TerminatePty
  #cleanupExitedPty: TerminatePty
  #closeTimeoutMs: number

  constructor(
    handlers: {
      onOutput: (terminalId: string, data: string) => void
      onExit: (terminalId: string, exitCode: number | null) => void
    },
    options: {
      spawnPty?: SpawnPty
      terminatePty?: TerminatePty
      cleanupExitedPty?: TerminatePty
      closeTimeoutMs?: number
    } = {},
  ) {
    this.#onOutput = handlers.onOutput
    this.#onExit = handlers.onExit
    this.#spawnPty = options.spawnPty ?? spawnOwnedPty
    this.#terminatePty = options.terminatePty ?? terminatePtySession
    this.#cleanupExitedPty = options.cleanupExitedPty ?? cleanupExitedPtySession
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
  }

  open(threadId: string, cwd: string, columns: number, rows: number): string {
    return this.#spawn(threadId, [], cwd, columns, rows)
  }

  /**
   * Run one command to completion in a terminal. Keyed like a thread terminal
   * so a second request for the same key reattaches to the run in progress
   * instead of starting the command twice. A real pty rather than a plain
   * child process, so an installer that asks a question can be handed to the
   * user instead of hanging invisibly.
   */
  run(key: string, command: string, cwd: string, columns: number, rows: number): string {
    const args =
      globalThis.process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
    return this.#spawn(key, args, cwd, columns, rows)
  }

  #spawn(key: string, args: string[], cwd: string, columns: number, rows: number): string {
    if (this.#closingAll) throw new Error('terminal manager is closing')
    if (this.#closingThreads.has(key)) throw new Error(`terminal is closing: ${key}`)
    if (this.#closingByThread.has(key)) throw new Error(`terminal is closing: ${key}`)

    const currentId = this.#byThread.get(key)
    if (currentId) {
      this.resize(currentId, columns, rows)
      return currentId
    }

    const terminalId = randomUUID()
    const process = this.#spawnPty(platformShell(), args, {
      name: 'xterm-256color',
      cols: columns,
      rows,
      cwd,
      env: terminalEnvironment(),
    })
    const outputBuffer = new TerminalOutputBuffer((data) => this.#onOutput(terminalId, data))
    const output = process.onData((data) => outputBuffer.push(data))
    let resolveExited: () => void = () => {}
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve
    })
    const entry = { threadId: key, process, output, outputBuffer, exited, hasExited: false }
    this.#byId.set(terminalId, entry)
    this.#byThread.set(key, terminalId)

    process.onExit(({ exitCode }) => {
      // Preserve the last prompt or command output before publishing the exit.
      // Explicit close disposes the buffer first because that pane is gone.
      outputBuffer.flush()
      output.dispose()
      entry.hasExited = true
      void this.#cleanupExitedTerminal(terminalId)
      resolveExited()
      this.#onExit(terminalId, Number.isInteger(exitCode) ? exitCode : null)
    })

    return terminalId
  }

  write(terminalId: string, data: string): void {
    this.#get(terminalId).process.write(data)
  }

  resize(terminalId: string, columns: number, rows: number): void {
    this.#get(terminalId).process.resize(columns, rows)
  }

  close(terminalId: string): Promise<void> {
    const alreadyClosing = this.#closingById.get(terminalId)
    if (alreadyClosing) return alreadyClosing

    const entry = this.#byId.get(terminalId)
    if (!entry) return Promise.resolve()
    // Start termination first. If ownership cannot be proved or node-pty
    // rejects synchronously, a later close can retry instead of losing it.
    const termination = entry.hasExited
      ? this.#cleanupExitedPty(entry.process)
      : this.#terminatePty(entry.process)
    const stopOutput = termination.then(() => {
      // node-pty flushes buffered output after kill(); once termination is
      // accepted, the client no longer needs those late chunks. A rejected
      // termination keeps the stream attached so the same PTY can be retried.
      entry.output.dispose()
      entry.outputBuffer.dispose()
    })
    const closing = Promise.all([this.#boundedExit(terminalId, entry.exited), stopOutput]).then(
      () => undefined,
    )
    this.#closingById.set(terminalId, closing)
    const threadClosings = this.#closingByThread.get(entry.threadId) ?? new Set<Promise<void>>()
    threadClosings.add(closing)
    this.#closingByThread.set(entry.threadId, threadClosings)
    // A timeout is a failed close, not evidence that the native process is
    // gone. Keep that generation tracked until its real exit arrives so a
    // retry cannot delete the cwd underneath it.
    void closing.catch(() => undefined)
    void closing.then(
      () => {
        if (this.#byId.get(terminalId) === entry) this.#byId.delete(terminalId)
        if (this.#byThread.get(entry.threadId) === terminalId) {
          this.#byThread.delete(entry.threadId)
        }
        this.#forgetClosing(terminalId, entry.threadId, closing)
      },
      () => {
        // If the ownership anchor is still alive, a later close can retry.
        // Once it exits, retain the failed close as a tombstone so no new PTY
        // can reuse the thread while descendants may still exist.
        if (!entry.hasExited) this.#forgetClosing(terminalId, entry.threadId, closing)
      },
    )
    return closing
  }

  closeThread(threadId: string): Promise<void> {
    const alreadyClosing = this.#closingThreads.get(threadId)
    if (alreadyClosing) return alreadyClosing

    const closing = this.#drainThread(threadId)
    this.#closingThreads.set(threadId, closing)
    void closing.then(
      () => this.#closingThreads.delete(threadId),
      () => this.#closingThreads.delete(threadId),
    )
    return closing
  }

  closeAll(): Promise<void> {
    if (this.#closingAll) return this.#closingAll
    this.#closingAll = this.#drainAll()
    return this.#closingAll
  }

  async #drainThread(threadId: string): Promise<void> {
    const waits = new Set(this.#closingByThread.get(threadId) ?? [])
    const terminalId = this.#byThread.get(threadId)
    if (terminalId) waits.add(this.close(terminalId))
    await settleAll(waits, `terminal shutdown failed for ${threadId}`)
  }

  async #drainAll(): Promise<void> {
    const waits = new Set<Promise<void>>(this.#closingById.values())
    for (const closingThread of this.#closingThreads.values()) waits.add(closingThread)
    for (const terminalId of this.#byId.keys()) {
      try {
        waits.add(this.close(terminalId))
      } catch (error) {
        waits.add(Promise.reject(error))
      }
    }
    await settleAll(waits, 'terminal shutdown failed')
  }

  #boundedExit(terminalId: string, exited: Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`terminal shutdown timed out: ${terminalId}`)),
        this.#closeTimeoutMs,
      )
      void exited.then(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }

  #forgetClosing(terminalId: string, threadId: string, closing: Promise<void>): void {
    if (this.#closingById.get(terminalId) === closing) this.#closingById.delete(terminalId)
    const threadClosings = this.#closingByThread.get(threadId)
    threadClosings?.delete(closing)
    if (threadClosings?.size === 0) this.#closingByThread.delete(threadId)
  }

  async #cleanupExitedTerminal(terminalId: string): Promise<void> {
    try {
      await this.close(terminalId)
    } catch {
      // A failed natural-exit cleanup remains tracked as a tombstone so a
      // later terminal cannot reuse the thread while descendants may exist.
    }
  }

  #get(terminalId: string): TerminalEntry {
    if (this.#closingById.has(terminalId)) {
      throw new Error(`terminal is closing: ${terminalId}`)
    }
    const entry = this.#byId.get(terminalId)
    if (!entry) throw new Error(`no such terminal: ${terminalId}`)
    return entry
  }
}

async function settleAll(waiters: Iterable<Promise<void>>, message: string): Promise<void> {
  const results = await Promise.allSettled(waiters)
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason)
  if (errors.length > 0) throw new AggregateError(errors, message)
}

export function platformShell(
  platform: NodeJS.Platform = globalThis.process.platform,
  environment: NodeJS.ProcessEnv = globalThis.process.env,
): string {
  if (platform === 'win32') return environment['ComSpec'] ?? environment['COMSPEC'] ?? 'cmd.exe'
  return environment['SHELL'] ?? '/bin/sh'
}

export function terminalEnvironment(
  environment: NodeJS.ProcessEnv = globalThis.process.env,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    PATH: desktopPath(environment.PATH ?? '', { env: environment }),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'TasteCode',
  }
}
