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
  visible?: (context: SearchContext) => boolean
}

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
    description: 'Background approvals, questions, failures and finished chats.',
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
    description: 'Let agents use your other subscriptions when another model fits a task better.',
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
    visible: (c) => c.backgroundEffort,
  },
  { id: 'background-speed', section: 'models', title: 'Background speed', visible: () => false },
  {
    id: 'phone-access',
    section: 'phone',
    title: 'Phone access',
    keywords: 'pair mobile',
    visible: (c) => c.phone,
  },
  {
    id: 'diagnostics',
    section: 'data',
    title: 'Local diagnostics',
    description: 'Stores redacted app error text only on this device.',
    visible: (c) => c.desktop,
  },
  { id: 'reset-preferences', section: 'data', title: 'Reset app preferences' },
  { id: 'debug-onboarding', section: 'debug', title: 'Force onboarding', visible: (c) => c.debug },
  {
    id: 'debug-app-update',
    section: 'debug',
    title: 'Simulate app update',
    visible: (c) => c.debug,
  },
  {
    id: 'debug-provider-update',
    section: 'debug',
    title: 'Simulate provider updates',
    visible: (c) => c.debug,
  },
  { id: 'debug-usage', section: 'debug', title: 'Usage history index', visible: (c) => c.debug },
  { id: 'debug-avatar', section: 'debug', title: 'Avatar generator', visible: (c) => c.debug },
  { id: 'about-version', section: 'about', title: 'TasteCode version' },
  { id: 'about-updates', section: 'about', title: 'Updates' },
  { id: 'about-source', section: 'about', title: 'Source' },
]

export const SETTINGS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...STATIC_SETTINGS,
  ...(['light', 'dark'] as const).flatMap((mode) => [
    {
      id: `appearance:${mode}:accent`,
      section: 'appearance' as const,
      title: `${mode} accent`,
      keywords: 'color colour',
    },
    {
      id: `appearance:${mode}:background`,
      section: 'appearance' as const,
      title: `${mode} background`,
      keywords: 'color colour',
    },
    {
      id: `appearance:${mode}:interface-font`,
      section: 'appearance' as const,
      title: `${mode} interface font`,
      keywords: 'typography',
    },
    {
      id: `appearance:${mode}:sidebar-translucency`,
      section: 'appearance' as const,
      title: `${mode} sidebar translucency`,
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
        score: scores.includes(-1) ? Infinity : scores.reduce((sum, score) => sum + score, 0),
      }
    })
    .filter((result) => Number.isFinite(result.score))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((result) => result.entry)
}
