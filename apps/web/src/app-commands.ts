import {
  IconAdjustmentsHorizontal,
  IconEdit,
  IconMessage,
  IconMessageCirclePlus,
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

export type AppAction = 'new-chat' | 'model'

/**
 * `/new`, `/clear` or `/model` typed alone. With anything after it the draft
 * is not one of these and goes to the provider as typed.
 */
export function parseAppActionCommand(text: string): AppAction | undefined {
  const match = /^\/([a-z]+)$/i.exec(text.trim())
  const name = match?.[1]?.toLowerCase()
  if (name === NEW_CHAT_COMMAND.name || NEW_CHAT_COMMAND.aliases.includes(name ?? ''))
    return 'new-chat'
  if (name === MODEL_COMMAND.name) return 'model'
  return undefined
}

/**
 * The commands that work right now: a side chat branches off a started chat,
 * feedback needs this build's feedback service, and the actions need a
 * handler or a model picker to open.
 */
export function appCommands(available: {
  sideChat: boolean
  feedback: boolean
  newChat?: boolean
  model?: boolean
}): readonly AppCommand[] {
  return [
    ...(available.newChat ? [NEW_CHAT_COMMAND] : []),
    ...(available.model ? [MODEL_COMMAND] : []),
    ...(available.sideChat ? [SIDE_CHAT_COMMAND] : []),
    ...(available.feedback ? [FEEDBACK_COMMAND] : []),
  ]
}
