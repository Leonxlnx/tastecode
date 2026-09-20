import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  acceleratorMatches,
  autoHidesMenuBar,
  createApplicationMenuTemplate,
  dispatchMenuRole,
  electronAccelerator,
  menuItemForKeyInput,
  roleAccelerator,
  type MenuKeyInput,
  type MenuRoleTarget,
} from './app-menu.js'
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

  it.each([
    ['linux', true],
    ['win32', false],
    ['darwin', false],
  ] as const)('autoHidesMenuBar(%s) -> %s', (platform, expected) => {
    expect(autoHidesMenuBar(platform)).toBe(expected)
  })

  it('matches accelerators against before-input-event keys', () => {
    const key = (partial: Partial<MenuKeyInput>): MenuKeyInput => ({
      key: '',
      control: false,
      alt: false,
      shift: false,
      meta: false,
      ...partial,
    })

    expect(acceleratorMatches('Ctrl+Q', key({ key: 'q', control: true }), 'linux')).toBe(true)
    expect(acceleratorMatches('Ctrl+Q', key({ key: 'w', control: true }), 'linux')).toBe(false)
    expect(acceleratorMatches('Ctrl+Q', key({ key: 'q' }), 'linux')).toBe(false)
    // CommandOrControl resolves to the platform's primary modifier.
    expect(
      acceleratorMatches(
        'CommandOrControl+Shift+S',
        key({ key: 's', control: true, shift: true }),
        'linux',
      ),
    ).toBe(true)
    expect(acceleratorMatches('CommandOrControl+S', key({ key: 's', meta: true }), 'darwin')).toBe(
      true,
    )
    // Extra modifiers must not match.
    expect(acceleratorMatches('Ctrl+Q', key({ key: 'q', control: true, alt: true }), 'linux')).toBe(
      false,
    )
    expect(acceleratorMatches('F11', key({ key: 'F11' }), 'linux')).toBe(true)
    // Electron accelerator and DOM key spellings converge.
    expect(
      acceleratorMatches(
        'CommandOrControl+Down',
        key({ key: 'ArrowDown', control: true }),
        'linux',
      ),
    ).toBe(true)
    expect(acceleratorMatches('Alt+Esc', key({ key: 'Escape', alt: true }), 'linux')).toBe(true)
    expect(acceleratorMatches(undefined, key({ key: 'q', control: true }), 'linux')).toBe(false)
  })

  it('derives role accelerators per platform', () => {
    expect(roleAccelerator('quit', 'linux')).toBe('Ctrl+Q')
    expect(roleAccelerator('close', 'linux')).toBe('Ctrl+W')
    expect(roleAccelerator('togglefullscreen', 'linux')).toBe('F11')
    expect(roleAccelerator('quit', 'darwin')).toBe('Cmd+Q')
    expect(roleAccelerator('about', 'linux')).toBeUndefined()
    expect(roleAccelerator(undefined, 'linux')).toBeUndefined()
  })

  it('finds the menu item for a Linux key event', () => {
    const template = createApplicationMenuTemplate({
      appName: 'Taste Code',
      isMacOS: false,
      isDevelopment: false,
      shortcuts: { newChat: { key: 'n', primary: true, shift: true } },
      onAction: vi.fn(),
      onZoom: vi.fn(),
      onOpenDiagnostics: vi.fn(),
    })
    const key = (partial: Partial<MenuKeyInput>): MenuKeyInput => ({
      key: '',
      control: false,
      alt: false,
      shift: false,
      meta: false,
      ...partial,
    })

    expect(menuItemForKeyInput(template, key({ key: 'q', control: true }), 'linux')?.role).toBe(
      'quit',
    )
    expect(menuItemForKeyInput(template, key({ key: 'w', control: true }), 'linux')?.role).toBe(
      'close',
    )
    expect(menuItemForKeyInput(template, key({ key: 'F11' }), 'linux')?.role).toBe(
      'togglefullscreen',
    )
    expect(
      menuItemForKeyInput(template, key({ key: 'n', control: true, shift: true }), 'linux')?.label,
    ).toBe('New Chat')
    // Custom accelerators resolve to the platform's real modifier.
    expect(
      menuItemForKeyInput(template, key({ key: 'n', meta: true, shift: true }), 'darwin')?.label,
    ).toBe('New Chat')
    // Unbound keys hit nothing; disabled items are skipped.
    expect(menuItemForKeyInput(template, key({ key: 'j', control: true }), 'linux')).toBeUndefined()
    expect(
      menuItemForKeyInput(
        [{ label: 'X', accelerator: 'Ctrl+X', enabled: false }],
        key({ key: 'x', control: true }),
        'linux',
      ),
    ).toBeUndefined()
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

describe('dispatchMenuRole', () => {
  function targetDouble() {
    return {
      quit: vi.fn(),
      window: {
        close: vi.fn(),
        isFullScreen: vi.fn(() => false),
        isMaximized: vi.fn(() => false),
        maximize: vi.fn(),
        minimize: vi.fn(),
        setFullScreen: vi.fn(),
        unmaximize: vi.fn(),
      },
      contents: {
        copy: vi.fn(),
        cut: vi.fn(),
        paste: vi.fn(),
        pasteAndMatchStyle: vi.fn(),
        redo: vi.fn(),
        reload: vi.fn(),
        reloadIgnoringCache: vi.fn(),
        selectAll: vi.fn(),
        toggleDevTools: vi.fn(),
        undo: vi.fn(),
      },
    } satisfies MenuRoleTarget
  }

  it('maps window roles to the matching window call', () => {
    const target = targetDouble()

    expect(dispatchMenuRole('quit', target)).toBe(true)
    expect(target.quit).toHaveBeenCalledOnce()
    expect(dispatchMenuRole('close', target)).toBe(true)
    expect(target.window.close).toHaveBeenCalledOnce()
    expect(dispatchMenuRole('minimize', target)).toBe(true)
    expect(target.window.minimize).toHaveBeenCalledOnce()
    expect(dispatchMenuRole('togglefullscreen', target)).toBe(true)
    expect(target.window.setFullScreen).toHaveBeenCalledWith(true)
  })

  it('maps edit and devtools roles to the matching webContents call', () => {
    const target = targetDouble()

    for (const [role, call] of [
      ['reload', 'reload'],
      ['forceReload', 'reloadIgnoringCache'],
      ['toggleDevTools', 'toggleDevTools'],
      ['undo', 'undo'],
      ['redo', 'redo'],
      ['cut', 'cut'],
      ['copy', 'copy'],
      ['paste', 'paste'],
      ['pasteAndMatchStyle', 'pasteAndMatchStyle'],
      ['selectAll', 'selectAll'],
    ] as const) {
      expect(dispatchMenuRole(role, target)).toBe(true)
      expect(target.contents[call]).toHaveBeenCalledOnce()
    }
  })

  it('returns false for roles without a dispatched equivalent', () => {
    const target = targetDouble()

    expect(dispatchMenuRole('about', target)).toBe(false)
    expect(dispatchMenuRole(undefined, target)).toBe(false)
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
