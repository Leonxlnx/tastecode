import { stat } from 'node:fs/promises'
import { commandVersion, invalidateCommandCache, locateCommand } from '@harness/proc/cli'
import { expireWindowsPath } from '@harness/proc/desktop-path'

/**
 * One answer to "is this CLI installed, and which version is it" for every
 * caller: the startup scan, providers.list and providers.updates.
 *
 * Finding the binary is an in-process PATH lookup. Its version needs the CLI
 * itself: `--version` took 0.7-6.7 s here, and minutes for an agy that had just
 * updated itself. So a version is read once per binary. Concurrent callers
 * share the read, the answer is kept while the file's size and mtime stay the
 * same, and an old answer is refreshed in the background.
 */
export type CliProbeSystem = {
  locate(command: string): Promise<string | undefined>
  /** Changes whenever the file is replaced; undefined when it is gone. */
  stamp(file: string): Promise<string | undefined>
  version(command: string): Promise<string | undefined>
}

const REAL_SYSTEM: CliProbeSystem = {
  locate: (command) => locateCommand(command),
  stamp: (file) =>
    stat(file).then(
      (entry) => `${file}\0${entry.size}\0${entry.mtimeMs}`,
      () => undefined,
    ),
  version: (command) => commandVersion(command),
}

/** How long a version is trusted before it is read again in the background. */
const VERSION_TTL_MS = 5 * 60_000
/** A CLI that would not say its version is asked again sooner. */
const MISSING_VERSION_TTL_MS = 60_000

type Entry = { stamp: string; version: string | undefined; readAt: number }
type Read = { stamp: string; generation: number; version: Promise<string | undefined> }

export class CliProbe {
  #entries = new Map<string, Entry>()
  #reads = new Map<string, Read>()
  #generations = new Map<string, number>()
  #beforeRead: (() => Promise<void>) | undefined

  constructor(private readonly system: CliProbeSystem = REAL_SYSTEM) {}

  /**
   * Starting a CLI for its version blocks the event loop for a moment. The
   * server passes a wait that holds the background re-read of a known version
   * while a turn streams. A first read, which a listing or an update check is
   * waiting for, and a read that checks a finished update (`fresh`) never wait.
   */
  waitBeforeReads(wait: (() => Promise<void>) | undefined): void {
    this.#beforeRead = wait
  }

  async installed(command: string): Promise<boolean> {
    return (await this.system.locate(command)) !== undefined
  }

  /**
   * The installed version, or undefined when the CLI is missing or will not
   * say. `waitMs` bounds the wait for a read that has to start the CLI; that
   * read goes on, and a later call gets its answer. `fresh` ignores what is
   * known and any read already under way, for checking a finished update.
   */
  async version(
    command: string,
    options: { waitMs?: number; fresh?: boolean } = {},
  ): Promise<string | undefined> {
    if (options.fresh) this.invalidate(command)
    const file = await this.system.locate(command)
    const stamp = file && (await this.system.stamp(file))
    if (!stamp) return undefined
    const entry = this.#entries.get(command)
    const known = entry?.stamp === stamp ? entry : undefined
    const ttl = known?.version === undefined ? MISSING_VERSION_TTL_MS : VERSION_TTL_MS
    if (known && Date.now() - known.readAt < ttl) return known.version
    // Only a refresh of a known answer is background work; a first read is awaited.
    const read = this.#read(command, stamp, known ? this.#beforeRead : undefined)
    // The same binary answered before: serve that while it is asked again.
    if (known) return known.version
    return options.waitMs === undefined ? read : within(read, options.waitMs)
  }

  /** Forget one command, or everything, for example after an install finished. */
  invalidate(command?: string): void {
    const commands = command === undefined ? [...this.#generations.keys()] : [command]
    for (const name of commands) {
      this.#generations.set(name, this.#generation(name) + 1)
      this.#entries.delete(name)
      this.#reads.delete(name)
    }
  }

  #generation(command: string): number {
    return this.#generations.get(command) ?? 0
  }

  #read(
    command: string,
    stamp: string,
    beforeRead: (() => Promise<void>) | undefined,
  ): Promise<string | undefined> {
    const generation = this.#generation(command)
    this.#generations.set(command, generation)
    const current = this.#reads.get(command)
    if (current?.stamp === stamp && current.generation === generation) return current.version
    const started = beforeRead
      ? beforeRead().then(() => this.system.version(command))
      : this.system.version(command)
    const version = started.then(
      (value) => value,
      () => undefined,
    )
    const read = { stamp, generation, version }
    this.#reads.set(command, read)
    void version.then((value) => {
      // A read that began before an invalidation must not answer for after it.
      if (this.#generation(command) === generation) {
        this.#entries.set(command, { stamp, version: value, readAt: Date.now() })
      }
      if (this.#reads.get(command) === read) this.#reads.delete(command)
    })
    return version
  }
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    void promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

/** The probe every provider listing and update check in this server shares. */
export const cliProbe = new CliProbe()

/**
 * The machine may have changed: an install, update or sign-in terminal ended.
 * Read the PATH again, look every command up again and read every version again.
 */
export function invalidateCliProbes(): void {
  expireWindowsPath()
  invalidateCommandCache()
  cliProbe.invalidate()
}
