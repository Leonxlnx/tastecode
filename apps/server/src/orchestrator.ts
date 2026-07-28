import { CodexAdapter, type StartOptions } from '@harness/adapter-codex'
import type { DomainEvent, Model, ProviderId, Thread } from '@harness/contracts'

/**
 * Owns every live agent session.
 *
 * Adapters are per-thread today. When a second provider lands (M2) this is
 * where the registry goes; the routing above it does not change, which is the
 * point of the adapter contract.
 */
export class Orchestrator {
  #threads = new Map<string, { thread: Thread; adapter: CodexAdapter }>()
  #onEvent: (threadId: string, event: DomainEvent) => void
  #onLog: (line: string) => void

  constructor(handlers: {
    onEvent: (threadId: string, event: DomainEvent) => void
    onLog: (line: string) => void
  }) {
    this.#onEvent = handlers.onEvent
    this.#onLog = handlers.onLog
  }

  /**
   * Listing models needs a live adapter but no thread, so it gets its own
   * short-lived one. Cheap enough, and it keeps model discovery available
   * before the user has started anything.
   */
  async listModels(provider: ProviderId): Promise<Model[]> {
    if (provider !== 'codex') return []
    const adapter = new CodexAdapter()
    try {
      await adapter.start()
      return await adapter.listModels()
    } finally {
      adapter.dispose()
    }
  }

  async startThread(
    provider: ProviderId,
    workspacePath: string,
    options: StartOptions = {},
  ): Promise<Thread> {
    if (provider !== 'codex') {
      throw new Error(`provider "${provider}" is not implemented yet`)
    }

    const adapter = new CodexAdapter()
    adapter.on('log', (line) => this.#onLog(line))
    await adapter.start()

    const thread = await adapter.startThread(workspacePath, options)
    this.#threads.set(thread.id, { thread, adapter })

    // Wired after startThread so the thread id exists before any event fires.
    adapter.on('event', (event) => this.#onEvent(thread.id, event))
    return thread
  }

  async sendTurn(threadId: string, text: string, attachments: string[] = []): Promise<string> {
    return this.#get(threadId).adapter.sendTurn(threadId, text, attachments)
  }

  async interrupt(threadId: string): Promise<void> {
    await this.#get(threadId).adapter.interrupt(threadId)
  }

  close(threadId: string): void {
    const entry = this.#threads.get(threadId)
    if (!entry) return
    entry.adapter.dispose()
    this.#threads.delete(threadId)
  }

  disposeAll(): void {
    for (const [, entry] of this.#threads) entry.adapter.dispose()
    this.#threads.clear()
  }

  #get(threadId: string) {
    const entry = this.#threads.get(threadId)
    if (!entry) throw new Error(`no such thread: ${threadId}`)
    return entry
  }
}
