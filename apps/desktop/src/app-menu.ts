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
        action('Expand Workspace Tools', 'expandWorkspace'),
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
