/**
 * Browser keys for the in-app Browser tab while focus is inside its page.
 *
 * A focused <webview> guest receives every key press itself, so the
 * renderer's own handler for these keys (browserShortcut in
 * apps/web/src/ui/workspace/browser-shortcuts.ts, which this mirrors) never
 * sees them. The guest's before-input-event takes them first, keeps them from
 * the page and from the window menu, and tells the window which guest asked.
 */
export const BROWSER_SHORTCUT_ACTIONS = ['back', 'forward', 'reload', 'address', 'close'] as const

export type BrowserShortcutAction = (typeof BROWSER_SHORTCUT_ACTIONS)[number]

export type BrowserShortcutMessage = { guestId: number; action: BrowserShortcutAction }

export type BrowserShortcutInput = {
  type?: string
  key: string
  code?: string
  control: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  isAutoRepeat?: boolean
}

/**
 * Back Alt+Left, forward Alt+Right, reload Ctrl+R or F5, address Ctrl+L and
 * close tab Ctrl+W. macOS uses Cmd: Cmd+[ and Cmd+] for history, because
 * Option+Left and Cmd+Left move the caret in a text field there.
 */
export function browserShortcut(
  input: BrowserShortcutInput,
  platform: NodeJS.Platform,
): BrowserShortcutAction | undefined {
  const mac = platform === 'darwin'
  const key = input.key.toLowerCase()
  if (input.shift) return undefined
  const primary = mac ? input.meta && !input.control : input.control && !input.meta
  if (primary && !input.alt) {
    if (key === 'r') return 'reload'
    if (key === 'l') return 'address'
    if (key === 'w') return 'close'
    if (mac && (key === '[' || input.code === 'BracketLeft')) return 'back'
    if (mac && (key === ']' || input.code === 'BracketRight')) return 'forward'
    return undefined
  }
  if (mac || input.control || input.meta) return undefined
  if (input.alt && input.key === 'ArrowLeft') return 'back'
  if (input.alt && input.key === 'ArrowRight') return 'forward'
  if (!input.alt && input.key === 'F5') return 'reload'
  return undefined
}

const browserShortcutActions = new Set<string>(BROWSER_SHORTCUT_ACTIONS)

export function isBrowserShortcutMessage(value: unknown): value is BrowserShortcutMessage {
  if (!isRecord(value)) return false
  const { guestId, action } = value
  return (
    Object.keys(value).length === 2 &&
    typeof guestId === 'number' &&
    Number.isSafeInteger(guestId) &&
    guestId > 0 &&
    typeof action === 'string' &&
    browserShortcutActions.has(action)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

type BrowserGuest = {
  readonly id: number
  on(
    event: 'before-input-event',
    listener: (event: { preventDefault(): void }, input: BrowserShortcutInput) => void,
  ): unknown
}

type BrowserEmbedder = {
  isDestroyed(): boolean
  send(channel: 'harness:browserShortcut', message: BrowserShortcutMessage): void
}

/** Route the Browser keys pressed inside a guest page to the window that shows it. */
export function forwardBrowserShortcuts(
  guest: BrowserGuest,
  embedder: BrowserEmbedder,
  platform: NodeJS.Platform = process.platform,
): void {
  guest.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const action = browserShortcut(input, platform)
    if (!action) return
    // Neither the page nor the window menu gets the key: Ctrl+W would close
    // the app window and Ctrl+L would move focus to the chat composer.
    event.preventDefault()
    if (input.isAutoRepeat || embedder.isDestroyed()) return
    embedder.send('harness:browserShortcut', { guestId: guest.id, action })
  })
}
