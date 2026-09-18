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
  archived?: boolean
  /** Provider-owned locator, interpreted only by its history adapter. */
  locator?: string
}

export type ProviderHistorySource = {
  list(): Promise<ProviderHistorySession[]>
  /** Resolve older adapter thread IDs to the native saved-session identity. */
  resolveSessionId?(threadId: string): string
  /** Use session.id as the thread id; the server maps it to its stable local id. */
  read(session: ProviderHistorySession): Promise<DomainEvent[]>
  dispose?(): void | Promise<void>
}
