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
    const currentId = this.#byThread.get(threadId)
    if (currentId) {
      this.resize(currentId, columns, rows)
      return currentId
    }

    const terminalId = randomUUID()
    const process = spawn(platformShell(), [], {
      name: 'xterm-256color',
      cols: columns,
      rows,
      cwd,
      env: globalThis.process.env,
    })
    const entry = { threadId, process }
    this.#byId.set(terminalId, entry)
    this.#byThread.set(threadId, terminalId)

    process.onData((data) => this.#onOutput(terminalId, data))
    process.onExit(({ exitCode }) => {
      if (this.#byId.get(terminalId) === entry) {
        this.#byId.delete(terminalId)
        this.#byThread.delete(threadId)
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
    this.#byThread.delete(entry.threadId)
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
