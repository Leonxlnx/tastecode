import type { MenuItemConstructorOptions } from 'electron'
import type { NativeMenuAction, NativeMenuShortcut, NativeMenuShortcuts } from './menu-contract.js'

type AppMenuOptions = {
  appName: string
  isMacOS: boolean
  isDevelopment: boolean
  shortcuts: NativeMenuShortcuts
  onAction: (action: NativeMenuAction) => void
  onZoom: (action: 'in' | 'out' | 'reset') => void
  onOpenDiagnostics: () => void
}

type MenuItem = MenuItemConstructorOptions

export function createApplicationMenuTemplate(options: AppMenuOptions): MenuItem[] {
  const action = (label: string, id: NativeMenuAction): MenuItem => {
    const accelerator = electronAccelerator(options.shortcuts[id])
    return {
      label,
      ...(accelerator ? { accelerator } : {}),
      click: () => options.onAction(id),
    }
  }
  const separator: MenuItem = { type: 'separator' }

  return [
    ...(options.isMacOS
      ? [
          {
            label: options.appName,
            submenu: [
              { role: 'about' },
              separator,
              action('Settings…', 'settings'),
              action('Keyboard Shortcuts…', 'keybindings'),
              separator,
              { role: 'services' },
              separator,
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              separator,
              { role: 'quit' },
            ],
          } satisfies MenuItem,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        action('New Chat', 'newChat'),
        action('Add Project…', 'newProject'),
        action('Switch Project…', 'switchProject'),
        action('Open Pull Requests', 'openPullRequests'),
        separator,
        ...(options.isMacOS
          ? [{ role: 'close' } satisfies MenuItem]
          : [action('Settings…', 'settings'), separator, { role: 'quit' } satisfies MenuItem]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        separator,
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(options.isMacOS ? [{ role: 'pasteAndMatchStyle' } satisfies MenuItem] : []),
        { role: 'delete' },
        separator,
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        action('Command Palette…', 'commandPalette'),
        action('Search Chats…', 'searchSessions'),
        separator,
        action('Toggle Sidebar', 'toggleSidebar'),
        action('Toggle Terminal', 'toggleTerminal'),
        action('Toggle Workspace Tools', 'toggleWorkspace'),
        separator,
        {
          label: 'Actual Size',
          accelerator: 'CommandOrControl+0',
          click: () => options.onZoom('reset'),
        },
        {
          label: 'Zoom In',
          accelerator: 'CommandOrControl+=',
          click: () => options.onZoom('in'),
        },
        {
          label: 'Zoom Out',
          accelerator: 'CommandOrControl+-',
          click: () => options.onZoom('out'),
        },
        separator,
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Chat',
      submenu: [
        action('Focus Composer', 'focusComposer'),
        action('Stop Response', 'interrupt'),
        separator,
        action('Previous Chat', 'previousChat'),
        action('Next Chat', 'nextChat'),
        separator,
        action('Pin or Unpin Chat', 'toggleSessionPin'),
        action('Archive Current Chat…', 'archiveSession'),
        action('Open Restore Points…', 'rollback'),
      ],
    },
    {
      label: 'Workspace',
      submenu: [
        action('Toggle Fast Mode', 'toggleFastMode'),
        action('Toggle Design Mode', 'toggleDesignMode'),
        action('Toggle Isolated Checkout', 'toggleIsolatedSession'),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(options.isMacOS
          ? [separator, { role: 'front' } satisfies MenuItem]
          : [{ role: 'close' } satisfies MenuItem]),
      ],
    },
    {
      role: 'help',
      submenu: [
        ...(!options.isMacOS ? [action('Keyboard Shortcuts…', 'keybindings')] : []),
        {
          label: 'Open Diagnostics Folder',
          click: options.onOpenDiagnostics,
        },
        ...(options.isDevelopment
          ? [
              separator,
              { role: 'reload' } satisfies MenuItem,
              { role: 'toggleDevTools' } satisfies MenuItem,
            ]
          : []),
      ],
    },
  ]
}

/**
 * A frameless Linux window never creates the views menu bar. autoHideMenuBar
 * keeps that true even if a later Electron change starts creating one — the
 * bar stays hidden until Alt. Accelerators are wired separately through
 * `menuItemForKeyInput`; macOS shows the app menu in the system bar and
 * Windows keeps its own handling, so neither changes.
 */
export function autoHidesMenuBar(platform: NodeJS.Platform): boolean {
  return platform === 'linux'
}

/**
 * before-input-event fields needed to match a menu accelerator. The shape is
 * structural so tests do not need an Electron `Input` object.
 */
export type MenuKeyInput = {
  key: string
  control: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

/**
 * Accelerators Electron assigns to menu roles that spell none in the
 * template, per platform. Covers every role our menu uses on Linux and
 * Windows; macOS entries exist for completeness and tests.
 */
const ROLE_ACCELERATORS = {
  quit: { linux: 'Ctrl+Q', win32: 'Ctrl+Q', darwin: 'Cmd+Q' },
  close: { linux: 'Ctrl+W', win32: 'Ctrl+W', darwin: 'Cmd+W' },
  minimize: { linux: 'Ctrl+M', win32: 'Ctrl+M', darwin: 'Cmd+M' },
  togglefullscreen: { linux: 'F11', win32: 'F11', darwin: 'Ctrl+Cmd+F' },
  reload: { linux: 'Ctrl+R', win32: 'Ctrl+R', darwin: 'Cmd+R' },
  forceReload: { linux: 'Shift+Ctrl+R', win32: 'Shift+Ctrl+R', darwin: 'Shift+Cmd+R' },
  toggleDevTools: { linux: 'Ctrl+Shift+I', win32: 'Ctrl+Shift+I', darwin: 'Alt+Cmd+I' },
  undo: { linux: 'Ctrl+Z', win32: 'Ctrl+Z', darwin: 'Cmd+Z' },
  redo: { linux: 'Shift+Ctrl+Z', win32: 'Shift+Ctrl+Z', darwin: 'Shift+Cmd+Z' },
  cut: { linux: 'Ctrl+X', win32: 'Ctrl+X', darwin: 'Cmd+X' },
  copy: { linux: 'Ctrl+C', win32: 'Ctrl+C', darwin: 'Cmd+C' },
  paste: { linux: 'Ctrl+V', win32: 'Ctrl+V', darwin: 'Cmd+V' },
  pasteAndMatchStyle: {
    linux: 'Shift+Ctrl+V',
    win32: 'Shift+Ctrl+V',
    darwin: 'Shift+Cmd+V',
  },
  selectAll: { linux: 'Ctrl+A', win32: 'Ctrl+A', darwin: 'Cmd+A' },
}

export function roleAccelerator(
  role: MenuItem['role'],
  platform: NodeJS.Platform,
): string | undefined {
  if (!role || !(role in ROLE_ACCELERATORS)) return undefined
  const perPlatform = ROLE_ACCELERATORS[role as keyof typeof ROLE_ACCELERATORS]
  return perPlatform[platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'win32' : 'linux']
}

const MODIFIER_ALIASES = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  altgr: 'alt',
  shift: 'shift',
  meta: 'meta',
  super: 'meta',
} as const

const KEY_ALIASES = {
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  escape: 'esc',
  ' ': 'space',
  spacebar: 'space',
  plus: '+',
} as const

function canonicalKey(key: string): string {
  const normalized = key.trim().toLowerCase()
  return normalized in KEY_ALIASES
    ? KEY_ALIASES[normalized as keyof typeof KEY_ALIASES]
    : normalized
}

/**
 * Whether a `before-input-event` key event equals an Electron accelerator
 * string like `CommandOrControl+Shift+S`. `CommandOrControl` resolves to the
 * platform's primary modifier, matching Electron.
 */
export function acceleratorMatches(
  accelerator: string | undefined,
  input: MenuKeyInput,
  platform: NodeJS.Platform,
): boolean {
  if (!accelerator) return false
  // '+' is itself a valid accelerator key ('Ctrl++'): take it before splitting.
  const endsOnKey = accelerator.endsWith('+')
  const tokens = (endsOnKey ? accelerator.slice(0, -1) : accelerator).split('+')
  const key = endsOnKey ? '+' : tokens.pop()
  if (!key || canonicalKey(key) !== canonicalKey(input.key)) return false
  const modifiers = new Set<string>()
  for (const token of tokens) {
    const name = token.trim().toLowerCase()
    if (name === 'commandorcontrol' || name === 'cmdorctrl') {
      modifiers.add(platform === 'darwin' ? 'meta' : 'ctrl')
    } else if (name === 'command' || name === 'cmd') {
      modifiers.add('meta')
    } else {
      const alias =
        name in MODIFIER_ALIASES
          ? MODIFIER_ALIASES[name as keyof typeof MODIFIER_ALIASES]
          : undefined
      if (alias) modifiers.add(alias)
    }
  }
  return (
    modifiers.has('ctrl') === input.control &&
    modifiers.has('alt') === input.alt &&
    modifiers.has('shift') === input.shift &&
    modifiers.has('meta') === input.meta
  )
}

function submenuItems(item: MenuItem): readonly MenuItem[] {
  // Our menu templates only ever use array submenus.
  return Array.isArray(item.submenu) ? item.submenu : []
}

/**
 * First enabled, visible leaf whose explicit or role-derived accelerator
 * matches the key event. Used on Linux, where a frameless window has no
 * views menu bar and Electron never registers these accelerators.
 */
export function menuItemForKeyInput(
  items: readonly MenuItem[],
  input: MenuKeyInput,
  platform: NodeJS.Platform,
): MenuItem | undefined {
  for (const item of items) {
    if (item.type === 'separator') continue
    const accelerator = item.accelerator ?? roleAccelerator(item.role, platform)
    if (
      item.enabled !== false &&
      item.visible !== false &&
      acceleratorMatches(accelerator, input, platform)
    )
      return item
    const hit = menuItemForKeyInput(submenuItems(item), input, platform)
    if (hit) return hit
  }
  return undefined
}

export function electronAccelerator(
  shortcut: NativeMenuShortcut | null | undefined,
): string | undefined {
  if (!shortcut) return undefined
  const key = acceleratorKey(shortcut.key)
  if (!key) return undefined
  return [
    shortcut.primary ? 'CommandOrControl' : undefined,
    shortcut.alt ? 'Alt' : undefined,
    shortcut.shift ? 'Shift' : undefined,
    key,
  ]
    .filter(Boolean)
    .join('+')
}

function acceleratorKey(key: string): string | undefined {
  const normalized = key.trim().toLowerCase()
  if (normalized === 'arrowup') return 'Up'
  if (normalized === 'arrowdown') return 'Down'
  if (normalized === 'arrowleft') return 'Left'
  if (normalized === 'arrowright') return 'Right'
  if (normalized === 'space') return 'Space'
  if (normalized === 'escape') return 'Esc'
  if (normalized === 'delete') return 'Delete'
  if (normalized === 'backspace') return 'Backspace'
  if (normalized === 'enter') return 'Enter'
  if (normalized === 'tab') return 'Tab'
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(normalized)) return normalized.toUpperCase()
  return normalized.length === 1 ? normalized.toUpperCase() : undefined
}
