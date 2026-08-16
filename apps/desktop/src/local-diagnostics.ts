import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MAX_LOG_BYTES = 512 * 1024

export class LocalDiagnostics {
  readonly directory: string
  readonly #enabledFile: string
  readonly #logFile: string
  readonly #onEnable: () => void
  #enabled = false
  #started = false

  constructor(directory: string, onEnable: () => void) {
    this.directory = directory
    this.#enabledFile = path.join(directory, 'enabled')
    this.#logFile = path.join(directory, 'errors.log')
    this.#onEnable = onEnable
  }

  async initialize(): Promise<void> {
    try {
      this.#enabled = (await readFile(this.#enabledFile, 'utf8')).trim() === 'true'
    } catch {
      this.#enabled = false
    }
    if (this.#enabled) {
      try {
        this.#start()
      } catch {
        this.#enabled = false
      }
    }
  }

  isEnabled(): boolean {
    return this.#enabled
  }

  async setEnabled(enabled: boolean): Promise<boolean> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    this.#enabled = enabled
    if (enabled) {
      await writeFile(this.#enabledFile, 'true', { mode: 0o600 })
      try {
        this.#start()
      } catch (error) {
        this.#enabled = false
        await rm(this.#enabledFile, { force: true })
        throw error
      }
    } else {
      await rm(this.#enabledFile, { force: true })
    }
    return enabled
  }

  async record(source: string, cause: unknown): Promise<void> {
    if (!this.#enabled) return
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const size = await stat(this.#logFile).then(
        (entry) => entry.size,
        () => 0,
      )
      if (size >= MAX_LOG_BYTES) await rm(this.#logFile, { force: true })
      const message = cause instanceof Error ? cause.stack || cause.message : String(cause)
      await appendFile(
        this.#logFile,
        `${new Date().toISOString()} [${scrub(source)}] ${scrub(message)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
    } catch {
      // Diagnostics must never become a second app failure.
    }
  }

  #start(): void {
    if (this.#started) return
    this.#started = true
    this.#onEnable()
  }
}

export function scrub(value: string): string {
  return value
    .replace(/\b[A-Z]:\\Users\\[^\\\r\n]+/gi, '[home]')
    .replace(/\/(?:Users|home)\/[^/\r\n]+/g, '[home]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[email]')
    .replace(/\b(bearer|token|api[_-]?key)(\s*[:=]?\s*)\S+/gi, '$1$2[redacted]')
    .slice(0, 4_000)
}
