import { CodexAdapter } from '@harness/adapter-codex'
import {
  providerRuntime,
  type AgentSession,
  type ProviderRuntime,
  type StartOptions,
  type TurnOptions,
} from './adapters.js'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { changedSince, restoreSnapshot, takeSnapshot } from './checkpoint.js'
import type { Store, StoredCheckpoint } from './store.js'
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
  PanicStopResult,
  ProviderId,
  QueuedTurn,
  Thread,
} from '@harness/contracts'

type QueuedTurnEntry = QueuedTurn & { options: TurnOptions }
type QueueState = { items: QueuedTurn[]; canSteer: boolean }
const PANIC_STOP_TIMEOUT_MS = 5_000

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
  #activeTurns = new Set<string>()
  #startingTurns = new Set<string>()
  #queuedTurns = new Map<string, QueuedTurnEntry[]>()
  #drainingQueues = new Set<string>()
  #panicGeneration = 0
  #panicStopping = false
  #store: Store
  #worktreeRoot: string
  #onEvent: (threadId: string, event: DomainEvent, seq: number) => void
  #onQueue: (threadId: string, state: QueueState) => void
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
      onQueue?: (threadId: string, state: QueueState) => void
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
    this.#onQueue = handlers.onQueue ?? (() => {})
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

  async usageLimits(
    provider: ProviderId,
  ): Promise<Array<{ label: string; usedPercent: number; resetsAt?: number | undefined }>> {
    if (provider !== 'codex') return []
    return (await this.#controlAdapter()).rateLimits()
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

  async sendTurn(
    threadId: string,
    text: string,
    attachments: string[] = [],
    options: TurnOptions = {},
  ): Promise<string> {
    if (this.#panicStopping) throw new Error('turn cancelled by panic stop')
    const panicGeneration = this.#panicGeneration
    this.#startingTurns.add(threadId)
    try {
      // Before the agent writes, not after. A checkpoint taken afterwards would
      // record the damage rather than the state worth returning to.
      await this.#checkpoint(threadId, text)
      if (panicGeneration !== this.#panicGeneration) {
        throw new Error('turn cancelled by panic stop')
      }
      return await this.#get(threadId).session.sendTurn(threadId, text, attachments, options)
    } finally {
      this.#startingTurns.delete(threadId)
    }
  }

  /** Send now when idle, otherwise put the prompt behind the active turn. */
  async submitTurn(
    threadId: string,
    text: string,
    attachments: string[] = [],
    options: TurnOptions = {},
  ): Promise<{ queued: false; turnId: string } | { queued: true; queuedTurn: QueuedTurn }> {
    const queue = this.#queuedTurns.get(threadId) ?? []
    if (this.#activeTurns.has(threadId) || this.#startingTurns.has(threadId) || queue.length > 0) {
      const queuedTurn: QueuedTurnEntry = {
        id: crypto.randomUUID(),
        text,
        attachments,
        createdAt: Date.now(),
        options,
      }
      queue.push(queuedTurn)
      this.#queuedTurns.set(threadId, queue)
      this.#notifyQueue(threadId)
      if (!this.#activeTurns.has(threadId) && !this.#startingTurns.has(threadId)) {
        void this.#drainQueue(threadId)
      }
      return { queued: true, queuedTurn: this.#publicQueuedTurn(queuedTurn) }
    }

    const turnId = await this.sendTurn(threadId, text, attachments, options)
    this.#activeTurns.add(threadId)
    return { queued: false, turnId }
  }

  queue(threadId: string): QueueState {
    const session = this.#get(threadId).session
    return {
      items: (this.#queuedTurns.get(threadId) ?? []).map((item) => this.#publicQueuedTurn(item)),
      canSteer: session.capabilities.steer && session.steer !== undefined,
    }
  }

  deleteQueuedTurn(threadId: string, queuedTurnId: string): void {
    const queue = this.#queuedTurns.get(threadId) ?? []
    const index = queue.findIndex((item) => item.id === queuedTurnId)
    if (index < 0) return
    queue.splice(index, 1)
    this.#notifyQueue(threadId)
  }

  async steerQueuedTurn(threadId: string, queuedTurnId: string): Promise<void> {
    const session = this.#get(threadId).session
    if (!this.#activeTurns.has(threadId)) throw new Error('there is no running turn to steer')
    if (!session.capabilities.steer || !session.steer) {
      throw new Error('this agent does not support steering a running turn')
    }

    const queue = this.#queuedTurns.get(threadId) ?? []
    const index = queue.findIndex((item) => item.id === queuedTurnId)
    if (index < 0) throw new Error('queued prompt not found')
    const [item] = queue.splice(index, 1)
    if (!item) return
    this.#notifyQueue(threadId)
    try {
      await session.steer(threadId, item.text, item.attachments)
    } catch (error) {
      queue.splice(index, 0, item)
      this.#notifyQueue(threadId)
      throw error
    }
  }

  /**
   * Log first, then broadcast.
   *
   * A client that reconnects mid-turn catches up from the log. An event that
   * went out but was never recorded would be one it can never get back, so the
   * write has to happen first even though it is the slower half.
   */
  #record(threadId: string, event: DomainEvent): void {
    if (event.type === 'turn.started') this.#activeTurns.add(threadId)
    if (event.type === 'turn.completed' || event.type === 'thread.error') {
      this.#activeTurns.delete(threadId)
    }
    const seq = this.#store.append(threadId, event)
    this.#onEvent(threadId, event, seq)
    if (event.type === 'turn.completed') void this.#drainQueue(threadId)
  }

  /** A thread's history, for a client opening or reattaching to it. */
  history(threadId: string, afterSeq = 0): Array<{ seq: number; event: DomainEvent }> {
    return this.#store.history(threadId, afterSeq)
  }

  /** Whether a session is still live, as opposed to merely on record. */
  isRunning(threadId: string): boolean {
    return this.#threads.has(threadId)
  }

  /** Whether the agent is inside a turn, rather than merely attached to the session. */
  isTurnRunning(threadId: string): boolean {
    return this.#activeTurns.has(threadId) || this.#startingTurns.has(threadId)
  }

  async #drainQueue(threadId: string): Promise<void> {
    if (
      this.#drainingQueues.has(threadId) ||
      this.#activeTurns.has(threadId) ||
      this.#startingTurns.has(threadId)
    ) {
      return
    }
    const queue = this.#queuedTurns.get(threadId)
    const next = queue?.shift()
    if (!queue || !next) return

    this.#drainingQueues.add(threadId)
    this.#notifyQueue(threadId)
    try {
      await this.sendTurn(threadId, next.text, next.attachments, next.options)
      this.#activeTurns.add(threadId)
    } catch (error) {
      queue.unshift(next)
      this.#notifyQueue(threadId)
      this.#onLog(
        `could not start queued turn: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      this.#drainingQueues.delete(threadId)
    }
  }

  #notifyQueue(threadId: string): void {
    if (!this.#threads.has(threadId)) return
    this.#onQueue(threadId, this.queue(threadId))
  }

  #publicQueuedTurn(item: QueuedTurnEntry): QueuedTurn {
    return {
      id: item.id,
      text: item.text,
      attachments: item.attachments,
      createdAt: item.createdAt,
    }
  }

  /** Where the working tree stood before a turn. Silent when there is no repo. */
  async #checkpoint(threadId: string, label: string): Promise<void> {
    const stored = this.#store.thread(threadId)
    if (!stored) return
    const repoPath = stored.worktreePath ?? stored.projectPath

    try {
      const snapshot = await takeSnapshot(repoPath)
      this.#store.addCheckpoint({
        threadId,
        seq: this.#store.lastSeq(threadId),
        commit: snapshot.commit,
        label: label.trim().slice(0, 60) || 'Turn',
      })
    } catch {
      // A folder that is not a repository is a normal case. Failing the turn
      // over a backup the user never asked for would be the wrong trade.
    }
  }

  checkpoints(threadId: string): StoredCheckpoint[] {
    return this.#store.checkpoints(threadId)
  }

  /**
   * Put a session back to a checkpoint — files and conversation together.
   *
   * Returns where the replaced state was saved, because restoring is itself an
   * action someone can regret. Nothing reachable this way is unrecoverable.
   */
  async restoreCheckpoint(threadId: string, checkpointId: number): Promise<{ undo: string }> {
    if (this.#activeTurns.has(threadId)) throw new Error('cannot restore during a running turn')
    const stored = this.#store.thread(threadId)
    const checkpoint = this.#store.checkpoint(checkpointId)
    if (!stored || !checkpoint || checkpoint.threadId !== threadId) {
      throw new Error('no such checkpoint')
    }

    const repoPath = stored.worktreePath ?? stored.projectPath
    const replaced = await restoreSnapshot(repoPath, checkpoint.commit)

    // Rolling the files back without this would leave the transcript
    // describing work that no longer exists on disk.
    try {
      return { undo: this.#store.saveRestoreUndo(threadId, checkpoint.seq, replaced.commit) }
    } catch (error) {
      await restoreSnapshot(repoPath, replaced.commit)
      throw error
    }
  }

  /** Reverse the latest restore, including both files and conversation. */
  async undoRestore(threadId: string, token: string): Promise<void> {
    if (this.#activeTurns.has(threadId)) throw new Error('cannot restore during a running turn')
    const stored = this.#store.thread(threadId)
    const undo = this.#store.restoreUndo(threadId, token)
    if (!stored || !undo) throw new Error('restore can no longer be undone')

    const repoPath = stored.worktreePath ?? stored.projectPath
    const replaced = await restoreSnapshot(repoPath, undo.commit)
    try {
      this.#store.applyRestoreUndo(threadId, token)
    } catch (error) {
      await restoreSnapshot(repoPath, replaced.commit)
      throw error
    }
  }

  /** What the agent has changed since a checkpoint, so a restore is informed. */
  async changedSinceCheckpoint(threadId: string, checkpointId: number): Promise<string[]> {
    const stored = this.#store.thread(threadId)
    const checkpoint = this.#store.checkpoint(checkpointId)
    if (!stored || !checkpoint || checkpoint.threadId !== threadId) return []
    return changedSince(stored.worktreePath ?? stored.projectPath, checkpoint.commit).catch(
      () => [],
    )
  }

  respondToApproval(threadId: string, approvalId: string, decision: ApprovalDecision): void {
    this.#get(threadId).session.respondToApproval(approvalId, decision)
  }

  async interrupt(threadId: string): Promise<void> {
    await this.#get(threadId).session.interrupt(threadId)
  }

  async panicStop(): Promise<PanicStopResult> {
    const sessions = [...this.#threads.entries()]
    this.#panicStopping = true
    this.#panicGeneration += 1
    for (const [threadId] of sessions) {
      if (this.#queuedTurns.delete(threadId)) this.#notifyQueue(threadId)
    }

    try {
      return {
        sessions: await Promise.all(
          sessions.map(async ([threadId, entry]) => {
            let timeout: NodeJS.Timeout | undefined
            try {
              await Promise.race([
                entry.session.interrupt(threadId),
                new Promise<never>((_, reject) => {
                  timeout = setTimeout(
                    () => reject(new Error('interrupt timed out; session was force-stopped')),
                    PANIC_STOP_TIMEOUT_MS,
                  )
                }),
              ])
              return { threadId, status: 'interrupted' as const }
            } catch (error) {
              this.close(threadId)
              return {
                threadId,
                status: 'failed' as const,
                error: (error instanceof Error ? error.message : String(error)) || 'Unknown error',
              }
            } finally {
              if (timeout) clearTimeout(timeout)
            }
          }),
        ),
      }
    } finally {
      this.#panicStopping = false
    }
  }

  close(threadId: string): void {
    const entry = this.#threads.get(threadId)
    if (!entry) return
    entry.session.dispose()
    this.#threads.delete(threadId)
    this.#activeTurns.delete(threadId)
    this.#startingTurns.delete(threadId)
    this.#queuedTurns.delete(threadId)
    this.#drainingQueues.delete(threadId)
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
    this.#activeTurns.clear()
    this.#startingTurns.clear()
    this.#queuedTurns.clear()
    this.#drainingQueues.clear()
    this.#control?.dispose()
    this.#control = undefined
  }

  #get(threadId: string) {
    const entry = this.#threads.get(threadId)
    if (!entry) throw new Error(`no such thread: ${threadId}`)
    return entry
  }
}
