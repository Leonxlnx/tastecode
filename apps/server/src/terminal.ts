import { randomUUID } from 'node:crypto'
import { spawn, type IPty } from 'node-pty'

type TerminalEntry = {
  threadId: string
  process: IPty
}

export class TerminalManager {
  #byId = new Map<string, TerminalEntry>()
  #byThread = new Map<string, string>()
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
    const entry = { threadId: key, process }
    this.#byId.set(terminalId, entry)
    this.#byThread.set(key, terminalId)

    process.onData((data) => this.#onOutput(terminalId, data))
    process.onExit(({ exitCode }) => {
      if (this.#byId.get(terminalId) === entry) {
        this.#byId.delete(terminalId)
        this.#byThread.delete(key)
      }
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

  close(terminalId: string): void {
    const entry = this.#byId.get(terminalId)
    if (!entry) return
    this.#byId.delete(terminalId)
    // Only unmap the key if it still points at this terminal — closing a
    // stale id must not orphan a newer pty spawned under the same key.
    if (this.#byThread.get(entry.threadId) === terminalId) {
      this.#byThread.delete(entry.threadId)
    }
    entry.process.kill()
  }

  closeThread(threadId: string): void {
    const terminalId = this.#byThread.get(threadId)
    if (terminalId) this.close(terminalId)
  }

  closeAll(): void {
    for (const terminalId of [...this.#byId.keys()]) this.close(terminalId)
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
