import { z } from 'zod'

export type Shortcut = {
  key: string
  primary?: boolean
  shift?: boolean
  alt?: boolean
}

export const KEYBINDING_STORAGE_KEY = 'harness.keybindings.v1'

/**
 * App-wide actions that are safe to expose as keybinds. Destructive or
 * context-specific actions start unassigned, but users can still opt in.
 */
export const KEYBINDING_DEFINITIONS = [
  {
    id: 'commandPalette',
    group: 'App',
    label: 'Command palette',
    description: 'Find any command, project, or chat.',
    defaultShortcut: { key: 'k', primary: true },
  },
  {
    id: 'settings',
    group: 'App',
    label: 'Open settings',
    description: 'Open or close app settings.',
    defaultShortcut: { key: ',', primary: true },
  },
  {
    id: 'keybindings',
    group: 'App',
    label: 'Open keybinds',
    description: 'Open this keybind editor.',
    defaultShortcut: { key: '/', primary: true },
  },
  {
    id: 'toggleSidebar',
    group: 'App',
    label: 'Toggle sidebar',
    description: 'Show or hide the project sidebar.',
    defaultShortcut: { key: 'b', primary: true },
  },
  {
    id: 'newChat',
    group: 'Chats',
    label: 'New chat',
    description: 'Start a chat in the current project.',
    defaultShortcut: { key: 'n', primary: true },
  },
  {
    id: 'searchSessions',
    group: 'Chats',
    label: 'Search chats',
    description: 'Search titles, messages, commands, and tool output.',
    defaultShortcut: { key: 'f', primary: true, shift: true },
  },
  {
    id: 'focusComposer',
    group: 'Chats',
    label: 'Focus composer',
    description: 'Move the cursor to the prompt field.',
    defaultShortcut: { key: 'l', primary: true },
  },
  {
    id: 'interrupt',
    group: 'Chats',
    label: 'Stop response',
    description: 'Stop the active agent turn.',
    defaultShortcut: { key: '.', primary: true },
  },
  {
    id: 'previousChat',
    group: 'Chats',
    label: 'Previous chat',
    description: 'Move to the previous chat in the sidebar.',
    defaultShortcut: { key: 'arrowup', primary: true, alt: true },
  },
  {
    id: 'nextChat',
    group: 'Chats',
    label: 'Next chat',
    description: 'Move to the next chat in the sidebar.',
    defaultShortcut: { key: 'arrowdown', primary: true, alt: true },
  },
  {
    id: 'toggleSessionPin',
    group: 'Chats',
    label: 'Pin or unpin chat',
    description: 'Change the pinned state of the current chat.',
    defaultShortcut: null,
  },
  {
    id: 'archiveSession',
    group: 'Chats',
    label: 'Archive current chat',
    description: 'Archive the current chat after any required safety check.',
    defaultShortcut: null,
  },
  {
    id: 'rollback',
    group: 'Chats',
    label: 'Open restore points',
    description: 'Review checkpoints for the current chat.',
    defaultShortcut: null,
  },
  {
    id: 'switchProject',
    group: 'Projects',
    label: 'Switch project',
    description: 'Choose another project from the command palette.',
    defaultShortcut: { key: 'p', primary: true },
  },
  {
    id: 'newProject',
    group: 'Projects',
    label: 'Add project',
    description: 'Add a project folder to the sidebar.',
    defaultShortcut: { key: 'o', primary: true, shift: true },
  },
  {
    id: 'openPullRequests',
    group: 'Projects',
    label: 'Open pull requests',
    description: 'Open the pull request inbox.',
    defaultShortcut: { key: 'p', primary: true, shift: true },
  },
  {
    id: 'toggleTerminal',
    group: 'Workspace',
    label: 'Toggle terminal',
    description: 'Show or hide the preferred terminal for the current chat.',
    defaultShortcut: { key: 'j', primary: true },
  },
  {
    id: 'toggleWorkspace',
    group: 'Workspace',
    label: 'Toggle workspace tools',
    description: 'Show or hide files, review, browser, and side chat.',
    defaultShortcut: { key: 'b', primary: true, shift: true },
  },
  {
    id: 'expandWorkspace',
    group: 'Workspace',
    label: 'Expand workspace tools',
    description: 'Open workspace tools or switch their full-width view.',
    defaultShortcut: null,
  },
  {
    id: 'toggleFastMode',
    group: 'Workspace',
    label: 'Toggle Fast mode',
    description: 'Toggle the fast service tier when the model supports it.',
    defaultShortcut: null,
  },
  {
    id: 'toggleDesignMode',
    group: 'Workspace',
    label: 'Toggle Design mode',
    description: 'Turn the design-first workflow on or off.',
    defaultShortcut: null,
  },
  {
    id: 'toggleIsolatedSession',
    group: 'Workspace',
    label: 'Toggle isolated checkout',
    description: 'Use a separate checkout for the next chat.',
    defaultShortcut: null,
  },
] as const

export type KeybindingId = (typeof KEYBINDING_DEFINITIONS)[number]['id']
export type KeybindingGroup = (typeof KEYBINDING_DEFINITIONS)[number]['group']
export type Keybindings = Record<KeybindingId, Shortcut | null>

export function createDefaultKeybindings(): Keybindings {
  // SAFETY: Definitions contain one unique entry for every KeybindingId, so
  // Object.fromEntries produces the complete Keybindings record.
  return Object.fromEntries(
    KEYBINDING_DEFINITIONS.map((definition) => [
      definition.id,
      definition.defaultShortcut ? { ...definition.defaultShortcut } : null,
    ]),
  ) as Keybindings
}

export const DEFAULT_KEYBINDINGS = createDefaultKeybindings()

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

export function findKeybindingConflict(
  keybindings: Keybindings,
  action: KeybindingId,
  shortcut: Shortcut,
): (typeof KEYBINDING_DEFINITIONS)[number] | undefined {
  return KEYBINDING_DEFINITIONS.find(
    (definition) => definition.id !== action && sameShortcut(keybindings[definition.id], shortcut),
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
    const parsed = StoredKeybindingsSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return defaults
    const saved = parsed.data.bindings
    for (const definition of KEYBINDING_DEFINITIONS) {
      if (!Object.hasOwn(saved, definition.id)) continue
      const candidate = saved[definition.id]
      if (candidate === null) {
        defaults[definition.id] = null
      } else if (candidate !== undefined) {
        defaults[definition.id] = normalizedShortcut(candidate)
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
  for (const definition of KEYBINDING_DEFINITIONS) {
    const current = keybindings[definition.id]
    if (!sameShortcut(current, defaults[definition.id])) bindings[definition.id] = current
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

const ShortcutSchema = z
  .object({
    key: z.string().min(1).max(24),
    primary: z.boolean().optional(),
    shift: z.boolean().optional(),
    alt: z.boolean().optional(),
  })
  .strict()

const StoredKeybindingsSchema = z
  .object({
    version: z.literal(1),
    bindings: z.record(z.string(), ShortcutSchema.nullable()),
  })
  .strict()
