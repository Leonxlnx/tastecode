import { watch as watchFolder, type FSWatcher } from 'node:fs'

/** A folder watched without recursion, and the entries in it that matter (all when absent). */
export type InventoryWatchTarget = { directory: string; names?: readonly string[] | undefined }

export type FolderWatch = (
  directory: string,
  listener: (event: string, filename: string | null) => void,
) => Pick<FSWatcher, 'close' | 'on'>

type Project = {
  expires: number
  generation: number
  watchers: Array<Pick<FSWatcher, 'close'>>
  debounce?: ReturnType<typeof setTimeout> | undefined
}

export type InventoryWatcherOptions = {
  /** The provider's folders for one project. */
  targets: (projectPath: string) => InventoryWatchTarget[] | Promise<InventoryWatchTarget[]>
  onChange: (projectPath: string) => void
  /** A lease lasts this long unless a visible view renews it. */
  ttlMs: number
  /** Editors and Windows report one save as several events. */
  debounceMs?: number
  watch?: FolderWatch
}

/**
 * Watches the configuration folders a provider reads its commands, skills
 * and MCP servers from, only while someone looks at that inventory. One
 * change (or a burst of them) reports once; the folders are then watched
 * again, so one that was missing and has appeared is covered from then on.
 */
export class InventoryWatcher {
  readonly #options: InventoryWatcherOptions
  readonly #projects = new Map<string, Project>()
  readonly #debounceMs: number
  readonly #watch: FolderWatch
  #expiry: ReturnType<typeof setTimeout> | undefined

  constructor(options: InventoryWatcherOptions) {
    this.#options = options
    this.#debounceMs = options.debounceMs ?? 500
    this.#watch = options.watch ?? ((directory, listener) => watchFolder(directory, listener))
  }

  lease(projectPath: string): void {
    const expires = Date.now() + this.#options.ttlMs
    const project = this.#projects.get(projectPath)
    if (project) project.expires = expires
    else {
      const created: Project = { expires, generation: 0, watchers: [] }
      this.#projects.set(projectPath, created)
      void this.#arm(projectPath, created)
    }
    this.#scheduleExpiry()
  }

  forget(projectPath: string): void {
    const project = this.#projects.get(projectPath)
    if (!project) return
    this.#close(project)
    this.#projects.delete(projectPath)
    this.#scheduleExpiry()
  }

  clear(): void {
    for (const project of this.#projects.values()) this.#close(project)
    this.#projects.clear()
    clearTimeout(this.#expiry)
    this.#expiry = undefined
  }

  async #arm(projectPath: string, project: Project): Promise<void> {
    const generation = ++project.generation
    for (const watcher of project.watchers.splice(0)) watcher.close()
    let targets: InventoryWatchTarget[]
    try {
      targets = await this.#options.targets(projectPath)
    } catch {
      return
    }
    if (this.#projects.get(projectPath) !== project || project.generation !== generation) return
    for (const target of targets) {
      const names = target.names && new Set(target.names.map(entryKey))
      try {
        const watcher = this.#watch(target.directory, (_event, filename) => {
          if (names && filename && !names.has(entryKey(filename))) return
          this.#changed(projectPath, project)
        })
        // A watched folder that is deleted errors on some systems; its parent reports it.
        watcher.on('error', () => watcher.close())
        project.watchers.push(watcher)
      } catch {
        // A folder that does not exist yet is reported by its parent's watch.
      }
    }
  }

  #changed(projectPath: string, project: Project): void {
    clearTimeout(project.debounce)
    project.debounce = setTimeout(() => {
      project.debounce = undefined
      if (this.#projects.get(projectPath) !== project) return
      void this.#arm(projectPath, project)
      this.#options.onChange(projectPath)
    }, this.#debounceMs)
    project.debounce.unref?.()
  }

  #close(project: Project): void {
    project.generation += 1
    clearTimeout(project.debounce)
    project.debounce = undefined
    for (const watcher of project.watchers.splice(0)) watcher.close()
  }

  #scheduleExpiry(): void {
    clearTimeout(this.#expiry)
    this.#expiry = undefined
    const now = Date.now()
    let next: number | undefined
    for (const [projectPath, project] of this.#projects) {
      if (project.expires <= now) {
        this.#close(project)
        this.#projects.delete(projectPath)
      } else next = Math.min(next ?? project.expires, project.expires)
    }
    if (next === undefined) return
    this.#expiry = setTimeout(() => this.#scheduleExpiry(), Math.max(1, next - now))
    this.#expiry.unref?.()
  }
}

/** Windows and macOS compare file names without case by default. */
function entryKey(name: string): string {
  return process.platform === 'linux' ? name : name.toLowerCase()
}
