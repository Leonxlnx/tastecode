export type Shortcut = {
  key: string
  primary?: boolean
  shift?: boolean
  alt?: boolean
}

export const KEYBINDING_STORAGE_KEY = 'harness.keybindings.v1'

/** Hidden from the editable keybind list so it stays difficult to trigger by accident. */
export const DEBUG_SETTINGS_SHORTCUT: Shortcut = {
  key: 'd',
  primary: true,
  shift: true,
  alt: true,
}

export function matchesDebugSettingsShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): boolean {
  if (!event.metaKey && !event.ctrlKey) return false
  if (!event.altKey || !event.shiftKey) return false

  // Option changes event.key into a symbol on macOS. event.code keeps the
  // physical D key stable across that keyboard translation.
  return event.code === 'KeyD' || normalizeShortcutKey(event.key) === 'd'
}

/** Compact runtime roster. Labels and descriptions live with lazy settings. */
export const KEYBINDING_IDS = [
  'commandPalette',
  'settings',
  'keybindings',
  'toggleSidebar',
  'newChat',
  'searchSessions',
  'focusComposer',
  'interrupt',
  'previousChat',
  'nextChat',
  'toggleSessionPin',
  'archiveSession',
  'rollback',
  'switchProject',
  'newProject',
  'openPullRequests',
  'toggleTerminal',
  'toggleWorkspace',
  'expandWorkspace',
  'toggleFastMode',
  'toggleDesignMode',
  'toggleIsolatedSession',
] as const

export type KeybindingId = (typeof KEYBINDING_IDS)[number]
export type Keybindings = Record<KeybindingId, Shortcut | null>

export const DEFAULT_KEYBINDINGS = {
  commandPalette: { key: 'k', primary: true },
  settings: { key: ',', primary: true },
  keybindings: { key: '/', primary: true },
  toggleSidebar: { key: 'b', primary: true },
  newChat: { key: 'n', primary: true },
  searchSessions: { key: 'f', primary: true, shift: true },
  focusComposer: { key: 'l', primary: true },
  interrupt: { key: '.', primary: true },
  previousChat: { key: 'arrowup', primary: true, alt: true },
  nextChat: { key: 'arrowdown', primary: true, alt: true },
  toggleSessionPin: null,
  archiveSession: null,
  rollback: null,
  switchProject: { key: 'p', primary: true },
  newProject: { key: 'o', primary: true, shift: true },
  openPullRequests: { key: 'p', primary: true, shift: true },
  toggleTerminal: { key: 'j', primary: true },
  toggleWorkspace: { key: 'b', primary: true, shift: true },
  expandWorkspace: null,
  toggleFastMode: null,
  toggleDesignMode: null,
  toggleIsolatedSession: null,
} as const satisfies Keybindings

export function createDefaultKeybindings() {
  const keybindings = {} as Keybindings
  for (const id of KEYBINDING_IDS) {
    const shortcut = DEFAULT_KEYBINDINGS[id]
    keybindings[id] = shortcut ? { ...shortcut } : null
  }
  return keybindings
}

export function matchesShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  shortcut: Shortcut | null | undefined,
): boolean {
  if (!shortcut) return false
  return (
    (event.metaKey || event.ctrlKey) === Boolean(shortcut.primary) &&
    event.altKey === Boolean(shortcut.alt) &&
    event.shiftKey === Boolean(shortcut.shift) &&
    normalizeShortcutKey(event.key) === shortcut.key
  )
}

export function shortcutFromKeyboardEvent(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): Shortcut | undefined {
  const key = normalizeShortcutKey(event.key)
  if (!key || MODIFIER_KEYS.has(key)) return undefined

  const primary = event.metaKey || event.ctrlKey
  const functionKey = /^f(?:[1-9]|1[0-9]|2[0-4])$/.test(key)
  if (!primary && !event.altKey && !functionKey) return undefined

  const shortcut: Shortcut = { key }
  if (primary) shortcut.primary = true
  if (event.shiftKey) shortcut.shift = true
  if (event.altKey) shortcut.alt = true
  return shortcut
}

export function shortcutLabel(shortcut: Shortcut, macOS: boolean): string {
  const key = displayKey(shortcut.key)
  if (macOS) {
    return `${shortcut.primary ? '⌘' : ''}${shortcut.alt ? '⌥' : ''}${shortcut.shift ? '⇧' : ''}${key}`
  }
  return [
    shortcut.primary ? 'Ctrl' : undefined,
    shortcut.alt ? 'Alt' : undefined,
    shortcut.shift ? 'Shift' : undefined,
    key,
  ]
    .filter(Boolean)
    .join('+')
}

export function shortcutAria(shortcut: Shortcut | null | undefined): string | undefined {
  if (!shortcut) return undefined
  const key = ariaKey(shortcut.key)
  const suffix = [shortcut.alt ? 'Alt' : undefined, shortcut.shift ? 'Shift' : undefined, key]
    .filter(Boolean)
    .join('+')
  return shortcut.primary ? `Meta+${suffix} Control+${suffix}` : suffix
}

export function sameShortcut(
  left: Shortcut | null | undefined,
  right: Shortcut | null | undefined,
): boolean {
  if (!left || !right) return left === right
  return (
    left.key === right.key &&
    Boolean(left.primary) === Boolean(right.primary) &&
    Boolean(left.alt) === Boolean(right.alt) &&
    Boolean(left.shift) === Boolean(right.shift)
  )
}

export function readKeybindings(): Keybindings {
  const defaults = createDefaultKeybindings()
  let raw: string | null
  try {
    raw = localStorage.getItem(KEYBINDING_STORAGE_KEY)
  } catch {
    return defaults
  }
  if (!raw) return defaults

  try {
    const saved = parseStoredKeybindings(JSON.parse(raw))
    if (!saved) return defaults
    for (const id of KEYBINDING_IDS) {
      if (!Object.hasOwn(saved, id)) continue
      const candidate = saved[id]
      if (candidate === null) {
        defaults[id] = null
      } else if (candidate !== undefined) {
        defaults[id] = normalizedShortcut(candidate)
      }
    }
    return defaults
  } catch {
    return defaults
  }
}

export function writeKeybindings(keybindings: Keybindings): void {
  const defaults = createDefaultKeybindings()
  const bindings: Partial<Record<KeybindingId, Shortcut | null>> = {}
  for (const id of KEYBINDING_IDS) {
    const current = keybindings[id]
    if (!sameShortcut(current, defaults[id])) bindings[id] = current
  }

  try {
    if (Object.keys(bindings).length === 0) localStorage.removeItem(KEYBINDING_STORAGE_KEY)
    else localStorage.setItem(KEYBINDING_STORAGE_KEY, JSON.stringify({ version: 1, bindings }))
  } catch {
    // The active session keeps the choice when storage is blocked.
  }
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

function normalizeShortcutKey(key: string): string {
  const normalized = key.trim().toLowerCase()
  if (key === ' ') return 'space'
  if (normalized === 'esc') return 'escape'
  if (normalized === 'spacebar') return 'space'
  if (normalized === 'up') return 'arrowup'
  if (normalized === 'down') return 'arrowdown'
  if (normalized === 'left') return 'arrowleft'
  if (normalized === 'right') return 'arrowright'
  return normalized
}

function normalizedShortcut(shortcut: {
  key: string
  primary?: boolean | undefined
  shift?: boolean | undefined
  alt?: boolean | undefined
}): Shortcut {
  const normalized: Shortcut = { key: normalizeShortcutKey(shortcut.key) }
  if (shortcut.primary) normalized.primary = true
  if (shortcut.shift) normalized.shift = true
  if (shortcut.alt) normalized.alt = true
  return normalized
}

function displayKey(key: string): string {
  switch (key) {
    case 'arrowup':
      return '↑'
    case 'arrowdown':
      return '↓'
    case 'arrowleft':
      return '←'
    case 'arrowright':
      return '→'
    case 'backspace':
      return 'Backspace'
    case 'delete':
      return 'Delete'
    case 'enter':
      return 'Enter'
    case 'escape':
      return 'Esc'
    case 'space':
      return 'Space'
    case 'tab':
      return 'Tab'
    default:
      return key.length === 1 ? key.toUpperCase() : key.replace(/^f/, 'F')
  }
}

function ariaKey(key: string): string {
  switch (key) {
    case 'arrowup':
      return 'ArrowUp'
    case 'arrowdown':
      return 'ArrowDown'
    case 'arrowleft':
      return 'ArrowLeft'
    case 'arrowright':
      return 'ArrowRight'
    case 'backspace':
      return 'Backspace'
    case 'delete':
      return 'Delete'
    case 'enter':
      return 'Enter'
    case 'escape':
      return 'Escape'
    case 'space':
      return 'Space'
    case 'tab':
      return 'Tab'
    default:
      return key.toUpperCase()
  }
}

const MODIFIER_KEYS = new Set(['alt', 'altgraph', 'control', 'meta', 'shift'])

function parseStoredKeybindings(value: unknown): Record<string, Shortcut | null> | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['version', 'bindings'])) return undefined
  if (value['version'] !== 1 || !isRecord(value['bindings'])) return undefined

  const bindings: Record<string, Shortcut | null> = {}
  for (const [id, candidate] of Object.entries(value['bindings'])) {
    if (candidate === null) {
      bindings[id] = null
      continue
    }
    const shortcut = parseStoredShortcut(candidate)
    if (!shortcut) return undefined
    bindings[id] = shortcut
  }
  return bindings
}

function parseStoredShortcut(value: unknown): Shortcut | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['key', 'primary', 'shift', 'alt'])) return undefined
  const key = value['key']
  if (typeof key !== 'string' || key.length < 1 || key.length > 24) return undefined
  if (!isOptionalBoolean(value['primary'])) return undefined
  if (!isOptionalBoolean(value['shift'])) return undefined
  if (!isOptionalBoolean(value['alt'])) return undefined
  return {
    key,
    ...(value['primary'] === undefined ? {} : { primary: value['primary'] }),
    ...(value['shift'] === undefined ? {} : { shift: value['shift'] }),
    ...(value['alt'] === undefined ? {} : { alt: value['alt'] }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean'
}
