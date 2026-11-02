import {
  IconAdjustmentsHorizontal,
  IconBlocks,
  IconChartBar,
  IconEdit,
  IconMessage,
  IconMessageCirclePlus,
  IconNetwork,
  IconSearch,
  IconSettings,
  IconShieldCheck,
  IconUser,
  type TablerIcon,
} from '@tabler/icons-react'

/**
 * A slash command TasteCode runs itself instead of sending it to the provider.
 * The composer catches it on send (`parseSideChatCommand`,
 * `parseFeedbackCommand`, `parseAppActionCommand`); this registry only puts it
 * in the "/" menu, ahead of the provider's commands and in place of any
 * provider command with the same name.
 */
export type AppCommand = {
  name: string
  aliases?: readonly string[]
  description: string
  /** The argument is optional: the bare name runs on Enter as well. */
  argumentHint?: string
  /** The icon the same feature uses elsewhere in the app. */
  icon: TablerIcon
}

const SIDE_CHAT_COMMAND = {
  name: 'side',
  aliases: ['btw'],
  description: 'Ask a side question in a temporary chat',
  argumentHint: '[question]',
  icon: IconMessageCirclePlus,
} satisfies AppCommand

const FEEDBACK_COMMAND = {
  name: 'feedback',
  description: 'Send feedback to the TasteCode team',
  argumentHint: '[details]',
  icon: IconMessage,
} satisfies AppCommand

/**
 * CLI commands that own state TasteCode keeps itself. A CLI's `/clear` or
 * `/model` would change a session TasteCode no longer matches, so the same
 * words run TasteCode's own action instead, whichever provider the chat uses.
 */
const NEW_CHAT_COMMAND = {
  name: 'new',
  aliases: ['clear'],
  description: 'Start a new chat',
  icon: IconEdit,
} satisfies AppCommand

const MODEL_COMMAND = {
  name: 'model',
  description: 'Choose the model and reasoning level',
  icon: IconAdjustmentsHorizontal,
} satisfies AppCommand

const PERMISSIONS_COMMAND = {
  name: 'permissions',
  // Codex's earlier name and Claude Code's alias for the same picker.
  aliases: ['approvals', 'allowed-tools'],
  description: 'Choose what the agent may do without asking',
  icon: IconShieldCheck,
} satisfies AppCommand

/**
 * Screens a CLI opens in its terminal (`/resume`, `/config`, `/mcp`, ...) and
 * cannot open through TasteCode. The same words open TasteCode's own screen
 * for it, whichever provider the chat uses.
 */
export type AppScreen = 'resume' | 'settings' | 'mcp' | 'skills' | 'usage' | 'login'

const SCREEN_COMMANDS = [
  {
    screen: 'resume',
    name: 'resume',
    aliases: ['continue'],
    description: 'Find and open an earlier chat',
    icon: IconSearch,
  },
  {
    screen: 'settings',
    name: 'settings',
    aliases: ['config'],
    description: 'Open settings',
    icon: IconSettings,
  },
  { screen: 'mcp', name: 'mcp', description: 'Manage MCP servers', icon: IconNetwork },
  { screen: 'skills', name: 'skills', description: 'Browse and manage skills', icon: IconBlocks },
  {
    screen: 'usage',
    name: 'usage',
    aliases: ['status', 'cost', 'stats'],
    description: 'See plan usage and limits',
    icon: IconChartBar,
  },
  {
    screen: 'login',
    name: 'login',
    aliases: ['logout'],
    description: 'Sign in to or out of a provider',
    icon: IconUser,
  },
] as const satisfies ReadonlyArray<AppCommand & { screen: AppScreen }>

export type AppAction = 'new-chat' | 'model' | 'permissions' | { screen: AppScreen }

const ALL_APP_COMMANDS: readonly AppCommand[] = [
  NEW_CHAT_COMMAND,
  MODEL_COMMAND,
  PERMISSIONS_COMMAND,
  ...SCREEN_COMMANDS,
  SIDE_CHAT_COMMAND,
  FEEDBACK_COMMAND,
]

function named(command: AppCommand, name: string): boolean {
  return command.name === name || (command.aliases?.includes(name) ?? false)
}

/** The icon of TasteCode's own command by any of its names, so its chip matches its menu row. */
export function appCommandIcon(name: string): TablerIcon | undefined {
  const lowered = name.toLowerCase()
  return ALL_APP_COMMANDS.find((command) => named(command, lowered))?.icon
}

/**
 * `/new`, `/model`, `/permissions`, `/resume` and the other actions typed
 * alone. With anything after it the draft is not one of these and goes to the
 * provider as typed.
 */
export function parseAppActionCommand(text: string): AppAction | undefined {
  const match = /^\/([a-z][a-z-]*)$/i.exec(text.trim())
  const name = match?.[1]?.toLowerCase()
  if (!name) return undefined
  if (named(NEW_CHAT_COMMAND, name)) return 'new-chat'
  if (named(MODEL_COMMAND, name)) return 'model'
  if (named(PERMISSIONS_COMMAND, name)) return 'permissions'
  const screen = SCREEN_COMMANDS.find((command) => named(command, name))
  return screen ? { screen: screen.screen } : undefined
}

/**
 * The commands that work right now: a side chat branches off a started chat,
 * feedback needs this build's feedback service, and the actions need a
 * handler, a model picker or a permissions picker to open.
 */
export function appCommands(available: {
  sideChat: boolean
  feedback: boolean
  newChat?: boolean
  model?: boolean
  permissions?: boolean
  screens?: boolean
}): readonly AppCommand[] {
  return [
    ...(available.newChat ? [NEW_CHAT_COMMAND] : []),
    ...(available.model ? [MODEL_COMMAND] : []),
    ...(available.permissions ? [PERMISSIONS_COMMAND] : []),
    ...(available.screens ? SCREEN_COMMANDS.map(({ screen: _screen, ...command }) => command) : []),
    ...(available.sideChat ? [SIDE_CHAT_COMMAND] : []),
    ...(available.feedback ? [FEEDBACK_COMMAND] : []),
  ]
}
