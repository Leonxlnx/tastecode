import { IconMessage, IconMessageCirclePlus, type TablerIcon } from '@tabler/icons-react'

/**
 * A slash command TasteCode runs itself instead of sending it to the provider.
 * The composer catches it on send (`parseSideChatCommand`,
 * `parseFeedbackCommand`); this registry only puts it in the "/" menu, ahead
 * of the provider's commands and in place of any provider command with the
 * same name.
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
 * The commands that work right now: a side chat branches off a started chat,
 * and feedback needs this build's feedback service.
 */
export function appCommands(available: {
  sideChat: boolean
  feedback: boolean
}): readonly AppCommand[] {
  return [
    ...(available.sideChat ? [SIDE_CHAT_COMMAND] : []),
    ...(available.feedback ? [FEEDBACK_COMMAND] : []),
  ]
}
