import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MAX_LOG_BYTES = 512 * 1024
const MAX_ENTRY_BYTES = 4 * 1024
const PRIVATE_KEY =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/g
const STANDALONE_SECRET =
  /\b(?:sk-(?:proj-|ant-api\d{2}-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})\b/g

export function localDiagnosticsDirectory(userDataDirectory: string): string {
  return path.join(userDataDirectory, 'diagnostics', 'text')
}

/** Whether an enabled flag file holds 'true', or undefined when it is absent. */
async function enabledFlagSet(file: string): Promise<boolean | undefined> {
  try {
    return (await readFile(file, 'utf8')).trim() === 'true'
  } catch {
    return undefined
  }
}

export class LocalDiagnostics {
  readonly directory: string
  readonly #enabledFile: string
  readonly #legacyEnabledFile: string
  readonly #logFile: string
  readonly #previousLogFile: string
  #enabled = false
  #generation = 0
  #operations = Promise.resolve()

  constructor(directory: string) {
    this.directory = directory
    this.#enabledFile = path.join(directory, 'enabled')
    // The directory used to be the parent itself: <userData>/diagnostics held
    // the flag beside the native crash dumps until the text logs moved into
    // text/. A flag left there is still the user's opt-in — ignoring it
    // silently turns diagnostics off for everyone who enabled them.
    this.#legacyEnabledFile = path.join(path.dirname(directory), 'enabled')
    this.#logFile = path.join(directory, 'errors.log')
    this.#previousLogFile = path.join(directory, 'errors.previous.log')
  }

  async initialize(): Promise<void> {
    const [current, legacy] = await Promise.all([
      enabledFlagSet(this.#enabledFile),
      enabledFlagSet(this.#legacyEnabledFile),
    ])
    this.#enabled = (current ?? legacy) === true
    this.#generation += 1
    if (legacy === undefined) return
    try {
      // Persist the adopted opt-in before consuming the stale flag — losing it
      // on a failed write would silently turn diagnostics off again.
      if (this.#enabled && current === undefined) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        await writeFile(this.#enabledFile, 'true', { mode: 0o600 })
      }
      await rm(this.#legacyEnabledFile, { force: true })
    } catch {
      // A failed migration retries on the next start; the in-memory flag
      // already applies to this run.
    }
  }

  isEnabled(): boolean {
    return this.#enabled
  }

  setEnabled(enabled: boolean): Promise<boolean> {
    const generation = ++this.#generation
    this.#enabled = enabled
    return this.#enqueue(async () => {
      if (generation !== this.#generation) return this.#enabled
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      try {
        if (enabled) await writeFile(this.#enabledFile, 'true', { mode: 0o600 })
        else {
          // The legacy flag goes too: an orphaned 'true' must not resurrect
          // the opt-in on the next start after the user disabled it.
          await rm(this.#enabledFile, { force: true })
          await rm(this.#legacyEnabledFile, { force: true })
        }
      } catch (error) {
        if (generation === this.#generation) {
          this.#enabled = false
          this.#generation += 1
        }
        throw error
      }
      return this.#enabled
    })
  }

  record(source: string, cause: unknown): Promise<void> {
    if (!this.#enabled) return Promise.resolve()
    const generation = this.#generation
    return this.#enqueue(async () => {
      if (!this.#enabled || generation !== this.#generation) return
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        const message = cause instanceof Error ? cause.stack || cause.message : String(cause)
        const entry = boundedEntry(
          `${new Date().toISOString()} [${scrub(source)}] ${scrub(message)}`,
        )
        const size = await stat(this.#logFile).then(
          (current) => current.size,
          () => 0,
        )
        if (!this.#enabled || generation !== this.#generation) return
        if (size + Buffer.byteLength(entry) > MAX_LOG_BYTES) {
          await rm(this.#previousLogFile, { force: true })
          if (!this.#enabled || generation !== this.#generation) return
          if (size <= MAX_LOG_BYTES) await rename(this.#logFile, this.#previousLogFile)
          else await rm(this.#logFile, { force: true })
        }
        if (!this.#enabled || generation !== this.#generation) return
        await appendFile(this.#logFile, entry, { encoding: 'utf8', mode: 0o600 })
      } catch {
        // Diagnostics must never become a second app failure.
      }
    })
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation)
    this.#operations = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

function boundedEntry(value: string): string {
  const bytes = Buffer.from(value)
  if (bytes.length < MAX_ENTRY_BYTES) return `${value}\n`
  return `${bytes
    .subarray(0, MAX_ENTRY_BYTES - 1)
    .toString('utf8')
    .replace(/\uFFFD$/u, '')}\n`
}

export function scrub(value: string): string {
  return value
    .replace(PRIVATE_KEY, '[redacted]')
    .replace(STANDALONE_SECRET, '[redacted]')
    .replace(/\b[A-Z]:\\Users\\[^\\\r\n]+/gi, '[home]')
    .replace(/\/(?:Users|home)\/[^/\r\n]+/g, '[home]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[email]')
    .replace(/\b(bearer|token|api[_-]?key)(\s*[:=]?\s*)\S+/gi, '$1$2[redacted]')
}
