import {
  ChatAttention,
  NOTICE_TEXT,
  parseChatAttentionReport,
  type ChatNotification,
} from './chat-attention.js'

/** A notification the OS is showing or keeps in its notification centre. */
export type ShownNotification = { close: () => void }

/** What the notifier needs from Electron, so the rules can be tested without it. */
export type ChatNotifierHost = {
  /** True while the main window is not in front: unfocused, minimized or hidden. */
  isAway: () => boolean
  /** Shows one OS notification; `onClick` runs when the user clicks it. */
  show: (title: string, body: string, onClick: () => void) => ShownNotification | undefined
  /** Puts the count on the taskbar button or the Dock icon; zero removes it. */
  setBadge: (count: number) => void
  /** Brings the window to the front and opens the chat. */
  openChat: (chatId: string) => void
}

/**
 * Owns the OS side of chat notifications: the notifications on screen, one per
 * chat at most, and the badge. A newer state of a chat replaces its
 * notification; coming back to the window clears them all, because the
 * sidebar now shows everything they said.
 */
export class ChatNotifier {
  readonly #attention = new ChatAttention()
  readonly #shown = new Map<string, ShownNotification>()
  #badge = 0

  readonly #host: ChatNotifierHost

  constructor(host: ChatNotifierHost) {
    this.#host = host
  }

  /** A report from the renderer, validated here; a malformed one is dropped. */
  report(value: unknown): void {
    const report = parseChatAttentionReport(value)
    if (!report) return
    const change = this.#attention.report(report, this.#host.isAway())
    for (const chatId of change.stale) this.#close(chatId)
    if (report.mode === 'off') this.#closeAll()
    for (const notification of change.notify) this.#show(notification)
    this.#setBadge(change.badge)
  }

  /** The window came to the front. */
  windowFocused(): void {
    this.#attention.seen()
    this.#closeAll()
    this.#setBadge(0)
  }

  /** The renderer page was replaced; its first report is a baseline. */
  pageReplaced(): void {
    this.#attention.reset()
  }

  dispose(): void {
    this.#closeAll()
    this.#setBadge(0)
  }

  #show(notification: ChatNotification): void {
    this.#close(notification.chatId)
    const shown = this.#host.show(notification.title, NOTICE_TEXT[notification.notice], () => {
      // Windows keeps a clicked notification in its centre unless it is closed.
      this.#close(notification.chatId)
      this.#host.openChat(notification.chatId)
    })
    if (shown) this.#shown.set(notification.chatId, shown)
  }

  #close(chatId: string): void {
    const shown = this.#shown.get(chatId)
    if (!shown) return
    this.#shown.delete(chatId)
    shown.close()
  }

  #closeAll(): void {
    for (const chatId of this.#shown.keys()) this.#close(chatId)
  }

  #setBadge(count: number): void {
    if (count === this.#badge) return
    this.#badge = count
    this.#host.setBadge(count)
  }
}
