import type { ApprovalMode, DomainEvent, Item } from './domain.js'

/** Local provider history. These server-only records never carry credentials. */
export type ProviderHistorySession = {
  id: string
  workspacePath: string
  title: string
  /** `title` is a name the provider or its user gave the session, not its first prompt. */
  named?: boolean
  createdAt: number
  updatedAt: number
  /** Changes whenever the saved transcript changes. */
  revision: string
  /** Provider-owned helper conversation; never import as a user-facing chat. */
  internal?: boolean
  archived?: boolean
  /** Provider-owned locator, interpreted only by its history adapter. */
  locator?: string
  /** The access level the session last ran with, when its transcript records one. */
  approval?: ApprovalMode
}

/**
 * Metadata the server keeps between refreshes and restarts, so a source can
 * skip re-reading transcripts that did not change. `locator` is a source-owned
 * key for one saved transcript, such as its file path; `revision` is the
 * source's own cheap fingerprint of it, such as size and modification time.
 * Both are opaque to the server.
 */
export type ProviderHistoryListOptions = {
  /**
   * The session the source reported for this locator at exactly this
   * revision, `null` when the source reported that it lists no session, or
   * `undefined` when nothing is known and the source must read it.
   */
  cached?(locator: string, revision: string): ProviderHistorySession | null | undefined
  /**
   * Record what the source computed for this locator and revision; `null`
   * means the transcript lists no session. After a list() call the server may
   * forget locators that neither callback named during it.
   */
  remember?(locator: string, revision: string, session: ProviderHistorySession | null): void
}

export type ProviderHistorySource = {
  /** Sources that ignore `options` keep working; they only re-read more. */
  list(options?: ProviderHistoryListOptions): Promise<ProviderHistorySession[]>
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
  /**
   * Read a native sub-agent's conversation without launching a provider. The server
   * supplies its stored parent item, never a client-provided path or transcript id.
   * Missing transcripts return an empty list; sources without this capability omit it.
   * It is asked again every few seconds while the sub-agent runs, so a source answers an
   * unchanged file from memory and replaces inline image data with a short placeholder.
   */
  readSubagentTranscript?(session: ProviderHistorySession, item: Item): Promise<Item[]>
  dispose?(): void | Promise<void>
}
