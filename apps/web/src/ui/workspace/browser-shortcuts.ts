import type { BrowserShortcutAction } from '../../bridge.js'

type BrowserKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
>

/**
 * The browser keys a Browser tab answers while focus is in its toolbar or
 * address field: back Alt+Left, forward Alt+Right, reload Ctrl+R or F5,
 * address Ctrl+L and close tab Ctrl+W, with Cmd on macOS and Cmd+[ / Cmd+]
 * for history there. Mirrors browserShortcut in
 * apps/desktop/src/browser-shortcuts.ts, which forwards the same keys from
 * inside the page.
 */
export function browserShortcut(
  event: BrowserKeyEvent,
  macOS: boolean,
): BrowserShortcutAction | undefined {
  const key = event.key.toLowerCase()
  if (event.shiftKey) return undefined
  const primary = macOS ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (primary && !event.altKey) {
    if (key === 'r') return 'reload'
    if (key === 'l') return 'address'
    if (key === 'w') return 'close'
    if (macOS && (key === '[' || event.code === 'BracketLeft')) return 'back'
    if (macOS && (key === ']' || event.code === 'BracketRight')) return 'forward'
    return undefined
  }
  if (macOS || event.ctrlKey || event.metaKey) return undefined
  if (event.altKey && event.key === 'ArrowLeft') return 'back'
  if (event.altKey && event.key === 'ArrowRight') return 'forward'
  if (!event.altKey && event.key === 'F5') return 'reload'
  return undefined
}

type BrowserShortcutHint = { label: string; aria: string }

/** What the toolbar tooltips show and aria-keyshortcuts announces. */
export function browserShortcutHints(
  macOS: boolean,
): Record<'back' | 'forward' | 'reload' | 'address', BrowserShortcutHint> {
  return macOS
    ? {
        back: { label: '⌘[', aria: 'Meta+[' },
        forward: { label: '⌘]', aria: 'Meta+]' },
        reload: { label: '⌘R', aria: 'Meta+R' },
        address: { label: '⌘L', aria: 'Meta+L' },
      }
    : {
        back: { label: 'Alt+←', aria: 'Alt+ArrowLeft' },
        forward: { label: 'Alt+→', aria: 'Alt+ArrowRight' },
        reload: { label: 'Ctrl+R', aria: 'Control+R F5' },
        address: { label: 'Ctrl+L', aria: 'Control+L' },
      }
}
