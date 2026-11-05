import type { ComposerChipKind } from './ui/composer-chips.js'
import type { KnownChipTokens } from './ui/message-chips.js'

/**
 * The tokens this device sent as chips, so the transcript can draw a `$skill`
 * or `@server` in the middle of a prompt as a chip without guessing at every
 * dollar sign. Losing it only means such a token shows as text.
 */
const CHIP_TOKENS_KEY = 'harness.composerChipTokens'
const CHIP_TOKENS_LIMIT = 200
const KINDS: ReadonlySet<string> = new Set<ComposerChipKind>(['skill', 'mcp', 'command'])

let remembered: Map<string, ComposerChipKind> | undefined

function load(): Map<string, ComposerChipKind> {
  if (remembered) return remembered
  remembered = new Map()
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(CHIP_TOKENS_KEY) ?? '[]')
    if (Array.isArray(saved)) {
      for (const entry of saved) {
        if (
          Array.isArray(entry) &&
          typeof entry[0] === 'string' &&
          typeof entry[1] === 'string' &&
          KINDS.has(entry[1])
        ) {
          remembered.set(entry[0], entry[1] as ComposerChipKind)
        }
      }
    }
  } catch {
    // Blocked or unreadable storage: start empty.
  }
  return remembered
}

export function rememberedChipTokens(): KnownChipTokens {
  return load()
}

export function rememberChipTokens(
  chips: ReadonlyArray<{ token: string; kind: ComposerChipKind }>,
): void {
  if (chips.length === 0) return
  const tokens = load()
  for (const { token, kind } of chips) {
    if (kind === 'browser') continue
    // Most recent last, so the oldest token is the one that falls out.
    tokens.delete(token)
    tokens.set(token, kind)
  }
  for (const token of tokens.keys()) {
    if (tokens.size <= CHIP_TOKENS_LIMIT) break
    tokens.delete(token)
  }
  try {
    localStorage.setItem(CHIP_TOKENS_KEY, JSON.stringify([...tokens]))
  } catch {
    // A token that is not remembered still sends; it only shows as text later.
  }
}

/** Tests start from an empty memory. */
export function resetRememberedChipTokens(): void {
  remembered = undefined
}
