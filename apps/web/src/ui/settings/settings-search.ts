import { KEYBINDING_DEFINITIONS } from '../../shortcuts.js'
import type { SettingsSection } from '../Settings.js'

export type SearchContext = {
  phone: boolean
  debug: boolean
  desktop: boolean
  notifications: boolean
  haptics: boolean
  fontSmoothing: boolean
  backgroundMode: string
  backgroundImage: boolean
  material: boolean
  backgroundEffort: boolean
  backgroundSpeed: boolean
}
export type SettingsSearchEntry = {
  id: string
  section: SettingsSection
  title: string
  description?: string
  keywords?: string
  /** A whole category: choosing it opens the page, with no row to jump to. */
  page?: boolean
  visible?: (context: SearchContext) => boolean
}

/** The categories themselves, so that searching for one never reports no matches. */
export const SETTINGS_PAGES: SettingsSearchEntry[] = [
  { id: 'page:workflows', section: 'workflows', title: 'General', page: true },
  { id: 'page:profile', section: 'profile', title: 'Profile', page: true },
  { id: 'page:appearance', section: 'appearance', title: 'Appearance', page: true },
  { id: 'page:keybinds', section: 'keybinds', title: 'Keybinds', page: true },
  { id: 'page:providers', section: 'providers', title: 'Providers', page: true },
  { id: 'page:models', section: 'models', title: 'Models', page: true },
  { id: 'page:mcp', section: 'mcp', title: 'MCP servers', page: true },
  { id: 'page:skills', section: 'skills', title: 'Skills', page: true },
  { id: 'page:usage', section: 'usage', title: 'Usage', page: true },
  { id: 'page:phone', section: 'phone', title: 'Phone', page: true, visible: (c) => c.phone },
  {
    id: 'page:import',
    section: 'import',
    title: 'Import chats',
    keywords: 'threads history migrate move t3 code claude codex grok opencode',
    page: true,
  },
  { id: 'page:data', section: 'data', title: 'Data & privacy', page: true },
  { id: 'page:debug', section: 'debug', title: 'Debug', page: true, visible: (c) => c.debug },
  { id: 'page:about', section: 'about', title: 'About', page: true },
]

export const STATIC_SETTINGS: SettingsSearchEntry[] = [
  {
    id: 'general-sidebar',
    section: 'workflows',
    title: 'Sidebar',
    description: 'Classic files chats under their projects. Inbox lines them up by last activity.',
    keywords: 'inbox settle',
  },
  {
    id: 'general-terminal',
    section: 'workflows',
    title: 'Terminal',
    description: 'Where the Toggle terminal shortcut opens a terminal.',
  },
  {
    id: 'general-model-picker',
    section: 'workflows',
    title: 'Model picker',
    description:
      'Rail picks a provider first, then its models. List shows every model in one scroll.',
  },
  {
    id: 'general-notifications',
    section: 'workflows',
    title: 'Notifications',
    description:
      'While TasteCode is in the background, for approvals, questions and failures, or also when a chat finishes.',
    visible: (c) => c.notifications,
  },
  {
    id: 'profile-identity',
    section: 'profile',
    title: 'Profile identity',
    keywords: 'name avatar photo picture',
  },
  { id: 'theme', section: 'appearance', title: 'Theme', keywords: 'dark mode light system' },
  {
    id: 'font-smoothing',
    section: 'appearance',
    title: 'Font smoothing',
    visible: (c) => c.fontSmoothing,
  },
  {
    id: 'haptics',
    section: 'appearance',
    title: 'Trackpad haptics',
    description:
      'Feel responsive detents while resizing, choosing effort, and placing dragged chats.',
    visible: (c) => c.haptics,
  },
  {
    id: 'window-style',
    section: 'appearance',
    title: 'Window background style',
    keywords: 'transparent image effect',
  },
  {
    id: 'window-material',
    section: 'appearance',
    title: 'Window material',
    visible: (c) => c.backgroundMode === 'transparent' && c.material,
  },
  {
    id: 'window-image',
    section: 'appearance',
    title: 'Window background image',
    visible: (c) => c.backgroundMode === 'image',
  },
  {
    id: 'window-effect',
    section: 'appearance',
    title: 'Window background effect',
    visible: (c) => c.backgroundMode === 'effect',
  },
  {
    id: 'window-dim',
    section: 'appearance',
    title: 'Window background dim',
    visible: (c) =>
      c.backgroundMode === 'effect' || (c.backgroundMode === 'image' && c.backgroundImage),
  },
  {
    id: 'window-blur',
    section: 'appearance',
    title: 'Window background blur',
    visible: (c) => c.backgroundMode === 'image' && c.backgroundImage,
  },
  {
    id: 'model-subagents',
    section: 'models',
    title: 'Sub-agents on other providers',
    description:
      "Let agents use your other subscriptions when another model fits a task better. When off, sub-agents run on the chat's provider unless your message asks for another one.",
  },
  {
    id: 'background-model',
    section: 'models',
    title: 'Background work model',
    description: 'Used for session titles, commit-message drafts, and other short writing.',
  },
  {
    id: 'background-effort',
    section: 'models',
    title: 'Background reasoning effort',
    description: 'Choose the effort used for background writing.',
    visible: (c) => c.backgroundEffort,
  },
  {
    id: 'background-speed',
    section: 'models',
    title: 'Background speed',
    description: 'Choose the speed used for background writing.',
    visible: (c) => c.backgroundSpeed,
  },
  {
    id: 'phone-access',
    section: 'phone',
    title: 'Phone access',
    description:
      "Phones reach this computer over your Wi-Fi or Tailscale. Every link is end-to-end encrypted and pinned to this computer's key; nothing passes through a server.",
    keywords: 'pair mobile',
    visible: (c) => c.phone,
  },
  {
    id: 'diagnostics',
    section: 'data',
    title: 'Local diagnostics',
    description:
      'Off by default. Stores redacted app error text only on this device. Nothing is uploaded. New entries stop immediately when turned off.',
    visible: (c) => c.desktop,
  },
  {
    id: 'reset-preferences',
    section: 'data',
    title: 'Reset app preferences',
    description: 'Clears appearance, layout and model choices.',
  },
  { id: 'debug-onboarding', section: 'debug', title: 'Force onboarding', visible: (c) => c.debug },
  {
    id: 'debug-app-update',
    section: 'debug',
    title: 'Simulate app update',
    description:
      'Plays a fake release through the sidebar button and About. Nothing is downloaded; restarting reloads the window.',
    visible: (c) => c.debug,
  },
  {
    id: 'debug-provider-update',
    section: 'debug',
    title: 'Simulate provider updates',
    description:
      'Pops the update notice with made-up releases one step past what is installed. Update plays the whole run without touching a CLI; dismissing the notice ends it.',
    visible: (c) => c.debug,
  },
  {
    id: 'debug-usage',
    section: 'debug',
    title: 'Usage history index',
    description:
      'Clears the generated cache and reparses every local provider history. Sessions and Harness data are not deleted.',
    visible: (c) => c.debug,
  },
  {
    id: 'debug-avatar',
    section: 'debug',
    title: 'Avatar generator',
    description:
      'The picture a profile gets from its name when no photo is uploaded. Same name, same picture, on every provider.',
    visible: (c) => c.debug,
  },
  { id: 'about-version', section: 'about', title: 'TasteCode version' },
  { id: 'about-updates', section: 'about', title: 'Updates' },
  { id: 'about-source', section: 'about', title: 'Source' },
]

const APPEARANCE_MODES = [
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
] as const

export const SETTINGS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...SETTINGS_PAGES,
  ...STATIC_SETTINGS,
  ...APPEARANCE_MODES.flatMap(({ mode, label }) => [
    {
      id: `appearance:${mode}:accent`,
      section: 'appearance' as const,
      title: `${label} accent`,
      keywords: 'color colour',
    },
    {
      id: `appearance:${mode}:background`,
      section: 'appearance' as const,
      title: `${label} background`,
      keywords: 'color colour',
    },
    {
      id: `appearance:${mode}:interface-font`,
      section: 'appearance' as const,
      title: `${label} interface font`,
      keywords: 'typography',
    },
    {
      id: `appearance:${mode}:sidebar-translucency`,
      section: 'appearance' as const,
      title: `${label} sidebar translucency`,
      keywords: 'glass opacity',
    },
  ]),
  ...KEYBINDING_DEFINITIONS.map((definition) => ({
    id: `keybind:${definition.id}`,
    section: 'keybinds' as const,
    title: definition.label,
    description: definition.description,
    keywords: 'shortcut keyboard keybind',
  })),
]

export function searchSettings(
  query: string,
  entries: readonly SettingsSearchEntry[],
): SettingsSearchEntry[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return entries
    .map((entry, index) => {
      const fields = [entry.title, entry.keywords ?? '', entry.description ?? ''].map((value) =>
        value.toLocaleLowerCase(),
      )
      const scores = words.map((word) => fields.findIndex((field) => field.includes(word)))
      return {
        entry,
        index,
        matched: !scores.includes(-1),
        titleMatches: scores.filter((score) => score === 0).length,
        keywordMatches: scores.filter((score) => score === 1).length,
      }
    })
    .filter((result) => result.matched)
    .sort(
      (a, b) =>
        b.titleMatches - a.titleMatches || b.keywordMatches - a.keywordMatches || a.index - b.index,
    )
    .map((result) => result.entry)
}
