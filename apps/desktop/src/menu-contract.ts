export const NATIVE_MENU_ACTIONS = [
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

export type NativeMenuAction = (typeof NATIVE_MENU_ACTIONS)[number]

export type NativeMenuShortcut = {
  key: string
  primary?: boolean
  shift?: boolean
  alt?: boolean
}

export type NativeMenuShortcuts = Partial<Record<NativeMenuAction, NativeMenuShortcut | null>>

const nativeMenuActions = new Set<string>(NATIVE_MENU_ACTIONS)
const nativeMenuShortcutKeys = new Set(['key', 'primary', 'shift', 'alt'])

export function isNativeMenuAction(value: unknown): value is NativeMenuAction {
  return typeof value === 'string' && nativeMenuActions.has(value)
}

export function parseNativeMenuShortcuts(value: unknown): NativeMenuShortcuts | undefined {
  if (!isRecord(value)) return undefined
  const shortcuts: NativeMenuShortcuts = {}
  for (const [action, candidate] of Object.entries(value)) {
    if (!isNativeMenuAction(action)) return undefined
    if (candidate === null) {
      shortcuts[action] = null
      continue
    }
    if (!isRecord(candidate)) return undefined
    if (Object.keys(candidate).some((key) => !nativeMenuShortcutKeys.has(key))) return undefined
    const { key, primary, shift, alt } = candidate as Record<string, unknown>
    if (typeof key !== 'string' || key.length === 0 || key.length > 24) return undefined
    if (primary !== undefined && typeof primary !== 'boolean') return undefined
    if (shift !== undefined && typeof shift !== 'boolean') return undefined
    if (alt !== undefined && typeof alt !== 'boolean') return undefined
    shortcuts[action] = {
      key,
      ...(primary === undefined ? {} : { primary }),
      ...(shift === undefined ? {} : { shift }),
      ...(alt === undefined ? {} : { alt }),
    }
  }
  return shortcuts
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
