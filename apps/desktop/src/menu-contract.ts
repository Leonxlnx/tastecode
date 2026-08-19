import { z } from 'zod'

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
const NativeMenuShortcutSchema = z
  .object({
    key: z.string().min(1).max(24),
    primary: z.boolean().optional(),
    shift: z.boolean().optional(),
    alt: z.boolean().optional(),
  })
  .strict()
const NativeMenuShortcutsSchema = z.record(z.string(), NativeMenuShortcutSchema.nullable())

export function isNativeMenuAction(value: unknown): value is NativeMenuAction {
  return typeof value === 'string' && nativeMenuActions.has(value)
}

export function parseNativeMenuShortcuts(value: unknown): NativeMenuShortcuts | undefined {
  const parsed = NativeMenuShortcutsSchema.safeParse(value)
  if (!parsed.success || Object.keys(parsed.data).some((key) => !isNativeMenuAction(key))) {
    return undefined
  }
  return parsed.data
}
