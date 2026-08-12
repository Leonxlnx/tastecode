export type SideChatCommand = { prompt: string }

/** `/btw` is Codex's shorter alias for the same ephemeral fork. */
export function parseSideChatCommand(text: string): SideChatCommand | undefined {
  const match = /^\/(?:side|btw)(?:\s+([\s\S]*))?$/i.exec(text.trimStart())
  if (!match) return undefined
  return { prompt: (match[1] ?? '').trim() }
}
