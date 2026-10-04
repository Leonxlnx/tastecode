import type { DomainEvent } from './domain.js'

/** Local provider history. These server-only records never carry credentials. */
export type ProviderHistorySession = {
  id: string
  workspacePath: string
  title: string
  createdAt: number
  updatedAt: number
  /** Changes whenever the saved transcript changes. */
  revision: string
  /** Provider-owned helper conversation; never import as a user-facing chat. */
  internal?: boolean
  archived?: boolean
  /** Provider-owned locator, interpreted only by its history adapter. */
  locator?: string
}

export type ProviderHistorySource = {
  list(): Promise<ProviderHistorySession[]>
  /** Resolve older adapter thread IDs to the native saved-session identity. */
  resolveSessionId?(threadId: string): string
  /**
   * Use session.id as the thread id; the server maps it to its stable local id.
   * `localTurnIds` names native turns already in the local log. The server drops
   * their echoes, so a source may leave out their items instead of parsing them.
   */
  read(
    session: ProviderHistorySession,
    options?: { localTurnIds?: ReadonlySet<string> },
  ): Promise<DomainEvent[]>
  dispose?(): void | Promise<void>
}
