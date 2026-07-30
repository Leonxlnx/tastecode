import { CodexAdapter } from '@harness/adapter-codex'
import {
  providerRuntime,
  type AgentSession,
  type ProviderRuntime,
  type StartOptions,
} from './adapters.js'
import type { Store } from './store.js'
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
  #threads = new Map<string, { thread: Thread; session: AgentSession }>()
  #store: Store
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
    },
  ) {
    this.#store = store
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
    const runtime = this.#runtimeFor(provider, this.#onLog)
    const { thread, session } = await runtime.start(workspacePath, options)
    this.#threads.set(thread.id, { thread, session })

    this.#store.addProject(workspacePath)
    this.#store.addThread({
      id: thread.id,
      projectPath: workspacePath,
      provider,
      ...(options.agent ? { agent: options.agent } : {}),
      title: 'New session',
      createdAt: thread.createdAt,
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
    this.#store.closeThread(threadId)
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
