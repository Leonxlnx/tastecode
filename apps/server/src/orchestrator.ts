import { CodexAdapter } from '@harness/adapter-codex'
import { providerRuntime, type AgentSession, type StartOptions } from './adapters.js'
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
 * Adapters are per-thread today. When a second provider lands (M2) this is
 * where the registry goes; the routing above it does not change, which is the
 * point of the adapter contract.
 */
export class Orchestrator {
  #threads = new Map<string, { thread: Thread; session: AgentSession }>()
  #onEvent: (threadId: string, event: DomainEvent) => void
  #onLog: (line: string) => void
  #onLogin: (
    provider: ProviderId,
    result: { loginId: string | null; success: boolean; error: string | null },
  ) => void

  constructor(handlers: {
    onEvent: (threadId: string, event: DomainEvent) => void
    onLog: (line: string) => void
    onLogin: (
      provider: ProviderId,
      result: { loginId: string | null; success: boolean; error: string | null },
    ) => void
  }) {
    this.#onEvent = handlers.onEvent
    this.#onLog = handlers.onLog
    this.#onLogin = handlers.onLogin
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
    const runtime = providerRuntime(provider, this.#onLog)
    const { thread, session } = await runtime.start(workspacePath, options)
    this.#threads.set(thread.id, { thread, session })

    // Wired after start so the thread id exists before any event fires.
    session.on('event', (event) => this.#onEvent(thread.id, event))
    return thread
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
