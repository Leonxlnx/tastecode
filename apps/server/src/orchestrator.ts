import { CodexAdapter } from '@harness/adapter-codex'
import {
  providerRuntime,
  type AgentSession,
  type ProviderRuntime,
  type StartOptions,
} from './adapters.js'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Store } from './store.js'
import {
  createWorktree,
  hasUncommittedChanges,
  pruneWorktrees,
  removeWorktree,
  type Worktree,
} from './worktree.js'
import type {
  Account,
  ApprovalDecision,
  DomainEvent,
  Model,
  ProviderId,
  Thread,
} from '@harness/contracts'

/**
 * Owns every live agent session.
 *
 * Sessions are independent: each has its own adapter and child process, and a
 * turn running in one does not block another. The only thing they share is
 * this map and the store.
 *
 * Every event is written to the log before it is broadcast. That ordering
 * matters — a client that reconnects mid-turn replays from the log, and an
 * event that went out but was never recorded would be one the client can never
 * get back.
 */
export class Orchestrator {
  #threads = new Map<string, { thread: Thread; session: AgentSession; worktree?: Worktree }>()
  #store: Store
  #worktreeRoot: string
  #onEvent: (threadId: string, event: DomainEvent, seq: number) => void
  #onLog: (line: string) => void
  #onLogin: (
    provider: ProviderId,
    result: { loginId: string | null; success: boolean; error: string | null },
  ) => void

  /**
   * How a provider is turned into a running session. Injectable so the
   * concurrency behaviour can be tested without spawning real agents — the
   * property worth protecting is that sessions do not block or cross-wire each
   * other, and that is about this class, not about any vendor.
   */
  #runtimeFor: (provider: ProviderId, onLog: (line: string) => void) => ProviderRuntime

  constructor(
    store: Store,
    handlers: {
      onEvent: (threadId: string, event: DomainEvent, seq: number) => void
      onLog: (line: string) => void
      onLogin: (
        provider: ProviderId,
        result: { loginId: string | null; success: boolean; error: string | null },
      ) => void
      runtimeFor?: (provider: ProviderId, onLog: (line: string) => void) => ProviderRuntime
      /** Where isolated checkouts live. Outside any repository, on purpose. */
      worktreeRoot?: string
    },
  ) {
    this.#store = store
    this.#worktreeRoot = handlers.worktreeRoot ?? path.join(os.tmpdir(), 'personal-harness-trees')
    this.#onEvent = handlers.onEvent
    this.#onLog = handlers.onLog
    this.#onLogin = handlers.onLogin
    this.#runtimeFor = handlers.runtimeFor ?? providerRuntime
  }

  /**
   * A single long-lived adapter for everything that is not a thread: models,
   * account, sign-in. It has to outlive a request because the OAuth completion
   * arrives as a notification minutes later, on the same connection that
   * started the flow.
   */
  #control: CodexAdapter | undefined

  async #controlAdapter(): Promise<CodexAdapter> {
    if (this.#control) return this.#control
    const adapter = new CodexAdapter()
    adapter.on('log', (line) => this.#onLog(line))
    adapter.on('login', (result) => this.#onLogin('codex', result))
    await adapter.start()
    this.#control = adapter
    return adapter
  }

  async listModels(provider: ProviderId): Promise<Model[]> {
    // Codex has a control adapter already running; everything else asks its
    // own runtime, which is free to answer with nothing.
    if (provider === 'codex') return (await this.#controlAdapter()).listModels()
    return providerRuntime(provider, this.#onLog).listModels()
  }

  async account(provider: ProviderId): Promise<Account> {
    if (provider !== 'codex') return { signedIn: false }
    return (await this.#controlAdapter()).account()
  }

  async startLogin(provider: ProviderId): Promise<{ loginId: string; authUrl: string }> {
    if (provider !== 'codex') throw new Error(`provider "${provider}" cannot sign in yet`)
    return (await this.#controlAdapter()).startLogin()
  }

  async cancelLogin(provider: ProviderId, loginId: string): Promise<void> {
    if (provider !== 'codex') return
    await (await this.#controlAdapter()).cancelLogin(loginId)
  }

  async useApiKey(provider: ProviderId, apiKey: string): Promise<Account> {
    if (provider !== 'codex') throw new Error(`provider "${provider}" cannot sign in yet`)
    return (await this.#controlAdapter()).useApiKey(apiKey)
  }

  async signOut(provider: ProviderId): Promise<void> {
    if (provider !== 'codex') return
    await (await this.#controlAdapter()).signOut()
  }

  async startThread(
    provider: ProviderId,
    workspacePath: string,
    options: StartOptions = {},
  ): Promise<Thread> {
    // The id has to exist before the worktree, and the worktree before the
    // agent — it is the directory the agent will be spawned in.
    const threadId = `${provider}-${crypto.randomUUID()}`
    const worktree = options.isolate
      ? await createWorktree(workspacePath, threadId, this.#worktreeRoot)
      : undefined

    const runtime = this.#runtimeFor(provider, this.#onLog)
    let started
    try {
      started = await runtime.start(worktree?.path ?? workspacePath, options)
    } catch (error) {
      // A worktree for a session that never started is litter, and the next
      // attempt would trip over it.
      if (worktree) await removeWorktree(worktree, true).catch(() => undefined)
      throw error
    }

    const { thread, session } = started
    this.#threads.set(thread.id, { thread, session, ...(worktree ? { worktree } : {}) })

    this.#store.addProject(workspacePath)
    this.#store.addThread({
      id: thread.id,
      // The project is the repository, not the private checkout. A session
      // still belongs to the folder the user chose.
      projectPath: workspacePath,
      provider,
      ...(options.agent ? { agent: options.agent } : {}),
      title: 'New session',
      createdAt: thread.createdAt,
      ...(worktree ? { worktreePath: worktree.path, worktreeBranch: worktree.branch } : {}),
    })

    // Wired after start so the thread id exists before any event fires.
    session.on('event', (event) => this.#record(thread.id, event))
    return thread
  }

  /**
   * Log first, then broadcast.
   *
   * A client that reconnects mid-turn catches up from the log. An event that
   * went out but was never recorded would be one it can never get back, so the
   * write has to happen first even though it is the slower half.
   */
  #record(threadId: string, event: DomainEvent): void {
    const seq = this.#store.append(threadId, event)
    this.#onEvent(threadId, event, seq)
  }

  /** A thread's history, for a client opening or reattaching to it. */
  history(threadId: string, afterSeq = 0): Array<{ seq: number; event: DomainEvent }> {
    return this.#store.history(threadId, afterSeq)
  }

  /** Whether a session is still live, as opposed to merely on record. */
  isRunning(threadId: string): boolean {
    return this.#threads.has(threadId)
  }

  async sendTurn(threadId: string, text: string, attachments: string[] = []): Promise<string> {
    return this.#get(threadId).session.sendTurn(threadId, text, attachments)
  }

  respondToApproval(threadId: string, approvalId: string, decision: ApprovalDecision): void {
    this.#get(threadId).session.respondToApproval(approvalId, decision)
  }

  async interrupt(threadId: string): Promise<void> {
    await this.#get(threadId).session.interrupt(threadId)
  }

  close(threadId: string): void {
    const entry = this.#threads.get(threadId)
    if (!entry) return
    entry.session.dispose()
    this.#threads.delete(threadId)
    // Marked closed, not deleted. Ending the process is not the same as
    // wanting the transcript gone.
    //
    // The worktree deliberately survives: it may hold work the agent did not
    // commit, and closing a session is not a statement about that work.
    this.#store.closeThread(threadId)
  }

  /**
   * Whether a session's private checkout still holds work nobody has seen.
   *
   * Asked before offering to discard it, so the choice is put to the user in
   * terms of what they would lose rather than as a routine tidy-up.
   */
  async hasUnsavedWork(threadId: string): Promise<boolean> {
    const stored = this.#store.thread(threadId)
    if (!stored?.worktreePath) return false
    return hasUncommittedChanges(stored.worktreePath)
  }

  /**
   * Remove a session's private checkout.
   *
   * Refuses when the agent left uncommitted work unless `force` — which is the
   * user answering "yes, discard it", never a default. The branch is kept
   * either way; it holds whatever was committed.
   */
  async discardWorktree(threadId: string, force = false): Promise<void> {
    const stored = this.#store.thread(threadId)
    if (!stored?.worktreePath || !stored.worktreeBranch) return

    await removeWorktree(
      { path: stored.worktreePath, branch: stored.worktreeBranch, repoPath: stored.projectPath },
      force,
    )
    this.#store.forgetWorktree(threadId)
  }

  /**
   * Clear up after a crash.
   *
   * A process killed mid-session leaves git believing in checkouts that are
   * gone, and the next session on that path fails with a message about a path
   * being "already registered" — our leftovers, reported to someone who did
   * nothing wrong. Only worktrees whose directory has already vanished are
   * forgotten; anything still on disk may hold work.
   */
  async recoverWorktrees(): Promise<void> {
    const repos = new Set(this.#store.worktrees().map((entry) => entry.repoPath))
    for (const repo of repos) {
      await pruneWorktrees(repo).catch(() => undefined)
    }

    for (const entry of this.#store.worktrees()) {
      if (!existsSync(entry.path)) this.#store.forgetWorktree(entry.threadId)
    }
  }

  disposeAll(): void {
    for (const [, entry] of this.#threads) entry.session.dispose()
    this.#threads.clear()
    this.#control?.dispose()
    this.#control = undefined
  }

  #get(threadId: string) {
    const entry = this.#threads.get(threadId)
    if (!entry) throw new Error(`no such thread: ${threadId}`)
    return entry
  }
}
