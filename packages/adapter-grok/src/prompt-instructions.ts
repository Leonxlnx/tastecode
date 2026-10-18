/**
 * The Grok CLI takes no separate system prompt, so a session's first prompt
 * carries TasteCode's instructions ahead of what the user typed. History
 * replays that prompt as the user's message; the block is taken off again
 * there, so the transcript shows what the user sent and matches the turn
 * TasteCode stored for it.
 */
const OPEN = '<system-instructions>\n'
const CLOSE = '\n</system-instructions>\n\n'

export function withInstructions(text: string, instructions: string): string {
  return `${OPEN}${instructions}${CLOSE}${text}`
}

/** The user's own text, without a leading instructions block. */
export function withoutInstructions(text: string): string {
  if (!text.startsWith(OPEN)) return text
  const end = text.indexOf(CLOSE, OPEN.length)
  return end === -1 ? text : text.slice(end + CLOSE.length)
}
