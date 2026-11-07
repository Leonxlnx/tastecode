import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import type {
  ChatImportChat,
  ChatImportFolder,
  ChatImportJob,
  ChatImportScan,
  ChatImportSource,
  DomainEvent,
  ProviderHistorySession,
  ProviderId,
} from '@harness/contracts'
import { createOpenCodeHistorySource } from '@harness/adapter-opencode/history'
import { importedEvents, ProjectFolders, type ProviderHistory } from './provider-history.js'
import type { Store } from './store.js'

/** A chat another app saved, in the shape provider history already uses. */
export type SavedChat = ProviderHistorySession & {
  /** The provider that continues it. */
  provider: ProviderId
  /** The session this chat runs on in that provider's own history, when it has one. */
  nativeSession?: string
  /** That provider can resume `id` itself, so the chat needs no copy of its context. */
  resumes?: boolean
}

/** An app's own store of chats. A reader only ever reads it. */
export type ChatImportReader = {
  id: string
  name: string
  /** Set when the app is also a provider, for its mark. */
  provider?: ProviderId
  /** Whether the app's store is on this computer at all. */
  present(): boolean
  list(): Promise<SavedChat[]>
  read(chat: SavedChat): Promise<DomainEvent[]>
}

/** Where a listed chat comes from: a provider's saved session, an app's own copy, or both. */
type Listed = {
  chat: ChatImportChat
  session?: ProviderHistorySession
  saved?: SavedChat
  reader?: ChatImportReader
}

type Dependencies = {
  store: Store
  history(): Promise<ProviderHistory>
  /** Names of the providers whose saved sessions provider history reads. */
  providerNames: ReadonlyMap<ProviderId, string>
  readers: readonly ChatImportReader[]
  changed(threadIds: string[]): void
  progress(job: ChatImportJob): void
  log(message: string): void
}

/** How often a running import reports. Each report repaints a progress bar. */
const REPORT_EVERY_MS = 120

export function importedThreadId(sourceId: string, chatId: string): string {
  return `imported:${sourceId}:${chatId}`
}

/**
 * Lists what other apps saved on this computer and turns chosen chats into
 * chats here. Nothing it reads is written to. A chat a provider can pick up
 * joins provider history, so it stays one conversation; any other chat is
 * copied, and its next prompt hands the transcript to a new session.
 */
export class ChatImportService {
  #listed = new Map<string, Listed>()
  #job: ChatImportJob | undefined
  #closed = false

  constructor(private deps: Dependencies) {}

  async scan(): Promise<ChatImportScan> {
    const { store } = this.deps
    const history = await this.deps.history().catch(() => undefined)
    const sources: ChatImportSource[] = []
    const listed = new Map<string, Listed>()
    const saved = new Map<ProviderId, Map<string, ProviderHistorySession>>()
    for (const [provider, name] of this.deps.providerNames) {
      const sessions = history?.providers().includes(provider)
        ? history.savedSessions(provider)
        : undefined
      if (!sessions) {
        const unavailable = !history || history.listFailed(provider)
        sources.push({ id: provider, name, provider, state: unavailable ? 'failed' : 'scanning' })
        continue
      }
      if (sessions.length) sources.push({ id: provider, name, provider, state: 'ready' })
      saved.set(provider, new Map(sessions.map(({ session }) => [session.id, session])))
      for (const { session, imported } of sessions) {
        listed.set(`${provider}:${session.id}`, {
          session,
          chat: {
            id: `${provider}:${session.id}`,
            source: provider,
            title: session.title,
            folder: session.workspacePath,
            provider,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            continuation: 'session',
            imported,
            ...(session.archived ? { archived: true } : {}),
          },
        })
      }
    }
    for (const reader of this.deps.readers) {
      if (!reader.present()) continue
      const base = { id: reader.id, name: reader.name }
      const named = reader.provider ? { ...base, provider: reader.provider } : base
      const chats = await reader.list().catch(() => {
        // Never log what a malformed store held.
        this.deps.log(`${reader.name} chats could not be listed`)
        return undefined
      })
      if (!chats) {
        sources.push({ ...named, state: 'failed' })
        continue
      }
      if (chats.length) sources.push({ ...named, state: 'ready' })
      for (const saved_ of chats) {
        const id = `${reader.id}:${saved_.id}`
        const mirrored = saved_.nativeSession
          ? `${saved_.provider}:${saved_.nativeSession}`
          : undefined
        const native = mirrored ? listed.get(mirrored) : undefined
        if (native) listed.delete(mirrored!)
        // A session that ran in a checkout of its own cannot resume from the project folder.
        const sameFolder =
          native?.session !== undefined &&
          samePath(native.session.workspacePath, saved_.workspacePath)
        listed.set(id, {
          saved: saved_,
          reader,
          ...(sameFolder ? { session: native.session! } : {}),
          chat: {
            id,
            source: reader.id,
            ...(native ? { alsoIn: [saved_.provider] } : {}),
            title: saved_.title,
            folder: saved_.workspacePath,
            provider: saved_.provider,
            createdAt: saved_.createdAt,
            updatedAt: saved_.updatedAt,
            continuation: sameFolder || saved_.resumes ? 'session' : 'copy',
            imported:
              store.thread(importedThreadId(reader.id, saved_.id)) !== undefined ||
              (native?.chat.imported ?? false),
            ...(saved_.archived ? { archived: true } : {}),
          },
        })
      }
    }
    this.#listed = listed
    const chats = [...listed.values()].map(({ chat }) => chat)
    return {
      sources,
      chats,
      folders: folderList(store, chats),
      ...(this.#job ? { job: this.#job } : {}),
    }
  }

  start(ids: readonly string[]): ChatImportJob {
    if (this.#job?.state === 'running') throw new Error('An import is already running.')
    const chosen = [...new Set(ids)].flatMap((id) => {
      const listed = this.#listed.get(id)
      return listed && !listed.chat.imported ? [listed] : []
    })
    if (!chosen.length) throw new Error('Those chats are no longer listed. Scan again.')
    const job: ChatImportJob = {
      state: 'running',
      done: 0,
      total: chosen.length,
      imported: 0,
      failed: 0,
      projects: [],
    }
    this.#job = job
    void this.#run(chosen, job)
    return { ...job }
  }

  close(): void {
    this.#closed = true
  }

  async #run(chosen: Listed[], job: ChatImportJob): Promise<void> {
    try {
      const history = await this.deps.history()
      // A folder that becomes a project must not bring in what was left unchosen,
      // and only a finished scan can say what was saved in it.
      await Promise.all(history.providers().map((provider) => history.scanned(provider)))
      this.#adoptFolders(chosen, job, history)
      let reported = Date.now()
      for (const listed of chosen) {
        if (this.#closed) break
        try {
          await this.#importChat(listed, history)
          job.imported += 1
        } catch (error) {
          job.failed += 1
          this.deps.log(`a ${listed.chat.source} chat could not be imported: ${describe(error)}`)
        }
        job.done += 1
        if (Date.now() - reported >= REPORT_EVERY_MS) {
          reported = Date.now()
          this.deps.progress({ ...job })
        }
        // A large import must not hold every open chat's streaming behind it.
        await nextTurn()
      }
    } catch (error) {
      job.failed += job.total - job.done
      job.done = job.total
      this.deps.log(`chat import stopped: ${describe(error)}`)
    }
    job.state = 'finished'
    this.deps.progress({ ...job })
  }

  /** Runs in one turn, so a scan never sees a new project before its hold-backs. */
  #adoptFolders(chosen: Listed[], job: ChatImportJob, history: ProviderHistory): void {
    const { store } = this.deps
    const folders = new ProjectFolders(store)
    const added = new Set<string>()
    for (const { chat } of chosen) {
      if (folders.project(chat.folder) !== undefined || added.has(chat.folder)) continue
      added.add(chat.folder)
    }
    const chosenSessions = new Set(chosen.flatMap(({ session }) => (session ? [session.id] : [])))
    for (const folder of added) store.addProject(folder)
    job.projects = [...added]
    // Asked again, so a session saved with another spelling of a new folder counts too.
    const projects = new ProjectFolders(store)
    for (const provider of history.providers()) {
      for (const { session, imported } of history.savedSessions(provider) ?? []) {
        if (imported || chosenSessions.has(session.id)) continue
        if (added.has(projects.project(session.workspacePath) ?? '')) {
          history.holdBack(provider, session)
        }
      }
    }
  }

  async #importChat({ chat, session, saved, reader }: Listed, history: ProviderHistory) {
    const { store } = this.deps
    const projectPath = new ProjectFolders(store).project(chat.folder) ?? chat.folder
    if (session) {
      const threadId = history.adopt(
        chat.provider,
        session,
        projectPath,
        saved ? chat.title : undefined,
      )
      try {
        // Read now, so a transcript that cannot be read fails here and not on opening.
        await history.load(threadId)
      } catch (error) {
        store.deleteThread(threadId)
        throw error
      }
      this.deps.changed([threadId])
      return
    }
    if (!saved || !reader) throw new Error('This chat has no readable source.')
    const threadId = importedThreadId(reader.id, saved.id)
    if (store.thread(threadId)) return
    const events = await reader.read(saved)
    if (!events.length) throw new Error('This chat has nothing to import.')
    store.addImportedThread(threadId, saved.provider, {
      title: saved.title,
      projectPath,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
      archived: saved.archived,
      ...(saved.resumes ? { providerSessionId: saved.id } : {}),
    })
    store.mergeProviderHistory(threadId, saved.revision, importedEvents(events, threadId, []))
    if (!saved.resumes) store.rearmThreadHandover(threadId)
    this.deps.changed([threadId])
  }
}

/** OpenCode keeps its session, so an imported chat resumes it rather than carrying a copy. */
export function openCodeChatReader(options: { root?: string } = {}): ChatImportReader {
  const source = createOpenCodeHistorySource(options)
  return {
    id: 'opencode',
    name: 'OpenCode',
    provider: 'opencode',
    present: () => source.present(),
    list: async () =>
      (await source.list()).map((session) => ({
        ...session,
        provider: 'opencode',
        resumes: true,
      })),
    read: (chat) => source.read(chat),
  }
}

function folderList(store: Store, chats: ChatImportChat[]): ChatImportFolder[] {
  const projects = new ProjectFolders(store)
  const folders = new Map<string, ChatImportFolder>()
  for (const { folder } of chats) {
    if (folders.has(folder)) continue
    folders.set(folder, {
      path: folder,
      name: path.basename(folder) || folder,
      label: folderLabel(folder),
      isProject: projects.project(folder) !== undefined,
      missing: !existsSync(folder),
    })
  }
  return [...folders.values()]
}

function folderLabel(folder: string, home = os.homedir()): string {
  const relative = path.relative(home, folder)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return folder
  return path.join('~', relative)
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
