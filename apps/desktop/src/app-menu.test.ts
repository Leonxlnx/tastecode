import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { createApplicationMenuTemplate, electronAccelerator } from './app-menu.js'
import {
  NATIVE_MENU_ACTIONS,
  parseNativeMenuShortcuts,
  type NativeMenuAction,
} from './menu-contract.js'

describe('application menu', () => {
  it.each(['macOS', 'Windows', 'Linux'])('exposes every renderer action on %s', (platform) => {
    const onAction = vi.fn()
    const template = createApplicationMenuTemplate({
      appName: 'Taste Code',
      isMacOS: platform === 'macOS',
      isDevelopment: false,
      shortcuts: {},
      onAction,
      onZoom: vi.fn(),
      onOpenDiagnostics: vi.fn(),
    })

    for (const item of menuItems(template))
      item.click?.(item as never, undefined, undefined as never)

    expect(new Set(onAction.mock.calls.map(([action]) => action))).toEqual(
      new Set<NativeMenuAction>(NATIVE_MENU_ACTIONS),
    )
    expect(template.map((item) => item.label ?? item.role)).toEqual([
      ...(platform === 'macOS' ? ['Taste Code'] : []),
      'File',
      'Edit',
      'View',
      'Chat',
      'Workspace',
      'Window',
      'help',
    ])
  })

  it('uses current custom shortcuts and leaves unassigned actions free', () => {
    const template = createApplicationMenuTemplate({
      appName: 'Taste Code',
      isMacOS: false,
      isDevelopment: false,
      shortcuts: {
        toggleSidebar: { key: 's', primary: true, alt: true },
        toggleTerminal: null,
      },
      onAction: vi.fn(),
      onZoom: vi.fn(),
      onOpenDiagnostics: vi.fn(),
    })

    expect(findLabel(template, 'Toggle Sidebar')?.accelerator).toBe('CommandOrControl+Alt+S')
    expect(findLabel(template, 'Toggle Terminal')?.accelerator).toBeUndefined()
    expect(findLabel(template, 'Settings…')).toBeDefined()
    expect(findRole(template, 'quit')).toBeDefined()
  })

  it('converts supported browser shortcut keys to Electron accelerators', () => {
    expect(electronAccelerator({ key: 'arrowdown', primary: true, shift: true })).toBe(
      'CommandOrControl+Shift+Down',
    )
    expect(electronAccelerator({ key: 'f8' })).toBe('F8')
    expect(electronAccelerator({ key: 'not-a-key', primary: true })).toBeUndefined()
  })

  it('rejects malformed or unknown shortcut updates from the renderer', () => {
    expect(parseNativeMenuShortcuts({ toggleSidebar: { key: 'b', primary: true } })).toEqual({
      toggleSidebar: { key: 'b', primary: true },
    })
    expect(parseNativeMenuShortcuts({ launchAnything: { key: 'x' } })).toBeUndefined()
    expect(parseNativeMenuShortcuts({ toggleSidebar: { key: 'b', command: true } })).toBeUndefined()
    expect(parseNativeMenuShortcuts(new Date())).toBeUndefined()
    expect(parseNativeMenuShortcuts(new Map())).toBeUndefined()
  })
})

function menuItems(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? menuItems(item.submenu) : []),
  ])
}

function findLabel(
  items: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions | undefined {
  return menuItems(items).find((item) => item.label === label)
}

function findRole(
  items: MenuItemConstructorOptions[],
  role: MenuItemConstructorOptions['role'],
): MenuItemConstructorOptions | undefined {
  return menuItems(items).find((item) => item.role === role)
}
