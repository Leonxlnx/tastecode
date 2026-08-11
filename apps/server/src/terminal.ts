import { randomUUID } from 'node:crypto'
import { spawn, type IPty } from 'node-pty'

type TerminalEntry = {
  threadId: string
  process: IPty
  output: { dispose(): void }
  exited: Promise<void>
}

export class TerminalManager {
  #byId = new Map<string, TerminalEntry>()
  #byThread = new Map<string, string>()
  #closing = new Set<Promise<void>>()
  #onOutput: (terminalId: string, data: string) => void
  #onExit: (terminalId: string, exitCode: number | null) => void

  constructor(handlers: {
    onOutput: (terminalId: string, data: string) => void
    onExit: (terminalId: string, exitCode: number | null) => void
  }) {
    this.#onOutput = handlers.onOutput
    this.#onExit = handlers.onExit
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
    const currentId = this.#byThread.get(key)
    if (currentId) {
      this.resize(currentId, columns, rows)
      return currentId
    }

    const terminalId = randomUUID()
    const process = spawn(platformShell(), args, {
      name: 'xterm-256color',
      cols: columns,
      rows,
      cwd,
      env: globalThis.process.env,
    })
    const output = process.onData((data) => this.#onOutput(terminalId, data))
    let resolveExited: () => void = () => {}
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve
    })
    const entry = { threadId: key, process, output, exited }
    this.#byId.set(terminalId, entry)
    this.#byThread.set(key, terminalId)

    process.onExit(({ exitCode }) => {
      if (this.#byId.get(terminalId) === entry) {
        this.#byId.delete(terminalId)
        this.#byThread.delete(key)
      }
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
    const entry = this.#byId.get(terminalId)
    if (!entry) return Promise.resolve()
    this.#byId.delete(terminalId)
    // Only unmap the key if it still points at this terminal — closing a
    // stale id must not orphan a newer pty spawned under the same key.
    if (this.#byThread.get(entry.threadId) === terminalId) {
      this.#byThread.delete(entry.threadId)
    }
    // node-pty flushes buffered output after kill(); the client tore this
    // pane down, so those late chunks must not be broadcast for its id.
    entry.output.dispose()
    this.#closing.add(entry.exited)
    void entry.exited.then(() => this.#closing.delete(entry.exited))
    try {
      entry.process.kill()
    } catch (error) {
      this.#closing.delete(entry.exited)
      throw error
    }
    return entry.exited
  }

  closeThread(threadId: string): Promise<void> {
    const terminalId = this.#byThread.get(threadId)
    return terminalId ? this.close(terminalId) : Promise.resolve()
  }

  async closeAll(): Promise<void> {
    for (const terminalId of [...this.#byId.keys()]) void this.close(terminalId)
    await Promise.all([...this.#closing])
  }

  #get(terminalId: string): TerminalEntry {
    const entry = this.#byId.get(terminalId)
    if (!entry) throw new Error(`no such terminal: ${terminalId}`)
    return entry
  }
}

export function platformShell(
  platform: NodeJS.Platform = globalThis.process.platform,
  environment: NodeJS.ProcessEnv = globalThis.process.env,
): string {
  if (platform === 'win32') return environment['ComSpec'] ?? environment['COMSPEC'] ?? 'cmd.exe'
  return environment['SHELL'] ?? '/bin/sh'
}
