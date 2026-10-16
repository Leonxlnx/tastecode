export type FeedbackCommand = { text: string }

/**
 * `/feedback [text]` opens TasteCode's feedback dialog. It is never sent to a
 * provider, so it is caught before every provider and project gate: people
 * want to report a problem exactly when a provider is broken. Only a draft
 * that starts with the command counts; `/feedbacks` or a sentence that merely
 * mentions it still goes to the agent.
 */
export function parseFeedbackCommand(text: string): FeedbackCommand | undefined {
  const match = /^\/feedback(?:\s+([\s\S]*))?$/i.exec(text.trim())
  if (!match) return undefined
  return { text: (match[1] ?? '').trim() }
}
