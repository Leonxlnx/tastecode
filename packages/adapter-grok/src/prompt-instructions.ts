/**
 * The Grok CLI takes no separate system prompt, so a session's first prompt
 * carries TasteCode's instructions ahead of what the user typed.
 */
const OPEN = '<system-instructions>\n'
const CLOSE = '\n</system-instructions>\n\n'

export function withInstructions(text: string, instructions: string): string {
  return `${OPEN}${instructions}${CLOSE}${text}`
}
