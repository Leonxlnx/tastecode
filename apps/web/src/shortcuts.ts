export type Shortcut = {
  key: string
  shift?: boolean
}

export const SHORTCUTS = {
  commandPalette: { key: 'k' },
  newChat: { key: 'n' },
  switchProject: { key: 'p' },
  newProject: { key: 'o', shift: true },
  settings: { key: ',' },
  focusComposer: { key: 'l' },
  toggleSidebar: { key: 'b' },
  panicStop: { key: '.', shift: true },
  searchSessions: { key: 'f', shift: true },
} satisfies Record<string, Shortcut>

export function matchesShortcut(event: KeyboardEvent, shortcut: Shortcut): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    event.shiftKey === Boolean(shortcut.shift) &&
    event.key.toLowerCase() === shortcut.key
  )
}

export function shortcutLabel(shortcut: Shortcut, macOS: boolean): string {
  const key = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key
  if (macOS) return `⌘${shortcut.shift ? '⇧' : ''}${key}`
  return `Ctrl${shortcut.shift ? ' Shift' : ''} ${key}`
}

export function shortcutAria(shortcut: Shortcut): string {
  const key = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key
  const suffix = `${shortcut.shift ? 'Shift+' : ''}${key}`
  return `Meta+${suffix} Control+${suffix}`
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  )
}
