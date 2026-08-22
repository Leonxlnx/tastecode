import { sameShortcut, type KeybindingId, type Keybindings, type Shortcut } from './shortcuts.js'

export type KeybindingGroup = 'App' | 'Chats' | 'Projects' | 'Workspace'

/** Copy used only by settings and tests; the launch path keeps the compact id roster. */
export const KEYBINDING_DEFINITIONS = [
  {
    id: 'commandPalette',
    group: 'App',
    label: 'Command palette',
    description: 'Find any command, project, or chat.',
  },
  {
    id: 'settings',
    group: 'App',
    label: 'Open settings',
    description: 'Open or close app settings.',
  },
  {
    id: 'keybindings',
    group: 'App',
    label: 'Open keybinds',
    description: 'Open this keybind editor.',
  },
  {
    id: 'toggleSidebar',
    group: 'App',
    label: 'Toggle sidebar',
    description: 'Show or hide the project sidebar.',
  },
  {
    id: 'newChat',
    group: 'Chats',
    label: 'New chat',
    description: 'Start a chat in the current project.',
  },
  {
    id: 'searchSessions',
    group: 'Chats',
    label: 'Search chats',
    description: 'Search titles, messages, commands, and tool output.',
  },
  {
    id: 'focusComposer',
    group: 'Chats',
    label: 'Focus composer',
    description: 'Move the cursor to the prompt field.',
  },
  {
    id: 'interrupt',
    group: 'Chats',
    label: 'Stop response',
    description: 'Stop the active agent turn.',
  },
  {
    id: 'previousChat',
    group: 'Chats',
    label: 'Previous chat',
    description: 'Move to the previous chat in the sidebar.',
  },
  {
    id: 'nextChat',
    group: 'Chats',
    label: 'Next chat',
    description: 'Move to the next chat in the sidebar.',
  },
  {
    id: 'toggleSessionPin',
    group: 'Chats',
    label: 'Pin or unpin chat',
    description: 'Change the pinned state of the current chat.',
  },
  {
    id: 'archiveSession',
    group: 'Chats',
    label: 'Archive current chat',
    description: 'Archive the current chat after any required safety check.',
  },
  {
    id: 'rollback',
    group: 'Chats',
    label: 'Open restore points',
    description: 'Review checkpoints for the current chat.',
  },
  {
    id: 'switchProject',
    group: 'Projects',
    label: 'Switch project',
    description: 'Choose another project from the command palette.',
  },
  {
    id: 'newProject',
    group: 'Projects',
    label: 'Add project',
    description: 'Add a project folder to the sidebar.',
  },
  {
    id: 'openPullRequests',
    group: 'Projects',
    label: 'Open pull requests',
    description: 'Open the pull request inbox.',
  },
  {
    id: 'toggleTerminal',
    group: 'Workspace',
    label: 'Toggle terminal',
    description: 'Show or hide the preferred terminal for the current chat.',
  },
  {
    id: 'toggleWorkspace',
    group: 'Workspace',
    label: 'Toggle workspace tools',
    description: 'Show or hide files, review, browser, and side chat.',
  },
  {
    id: 'expandWorkspace',
    group: 'Workspace',
    label: 'Expand workspace tools',
    description: 'Open workspace tools or switch their full-width view.',
  },
  {
    id: 'toggleFastMode',
    group: 'Workspace',
    label: 'Toggle Fast mode',
    description: 'Toggle the fast service tier when the model supports it.',
  },
  {
    id: 'toggleDesignMode',
    group: 'Workspace',
    label: 'Toggle Design mode',
    description: 'Turn the design-first workflow on or off.',
  },
  {
    id: 'toggleIsolatedSession',
    group: 'Workspace',
    label: 'Toggle isolated checkout',
    description: 'Use a separate checkout for the next chat.',
  },
] as const satisfies ReadonlyArray<{
  id: KeybindingId
  group: KeybindingGroup
  label: string
  description: string
}>

export function findKeybindingConflict(
  keybindings: Keybindings,
  action: KeybindingId,
  shortcut: Shortcut,
): (typeof KEYBINDING_DEFINITIONS)[number] | undefined {
  return KEYBINDING_DEFINITIONS.find(
    (definition) => definition.id !== action && sameShortcut(keybindings[definition.id], shortcut),
  )
}
