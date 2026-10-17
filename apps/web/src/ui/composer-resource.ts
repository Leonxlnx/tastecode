/**
 * `skill` and `mcp` become chips whose token is sent ahead of the prompt.
 * `command` is typed into the draft as `/name `, which the provider expands.
 */
type ComposerResourceKind = 'skill' | 'mcp' | 'command'

export type ComposerResource = {
  key: string
  kind: ComposerResourceKind
  id: string
  name: string
  description: string
  scope: string
  token: string
  available: boolean
  unavailableReason?: string | undefined
  /** Commands only: whether the provider calls it a skill, which picks its icon. */
  commandKind?: 'command' | 'skill' | undefined
  /** Commands only: other names typed after the slash that run the same command. */
  aliases?: readonly string[] | undefined
  /** Commands only: placeholder for the text the command takes after its name. */
  argumentHint?: string | undefined
  /** Commands only: Enter on the exactly typed name sends it instead of completing it. */
  runsAsTyped?: boolean | undefined
}

export type ComposerResourceMarker = '/' | '$' | '@'

export type ComposerResourceTrigger = {
  marker: ComposerResourceMarker
  query: string
  start: number
  end: number
}

export type ComposerResourcePickerHandle = {
  move: (direction: 1 | -1) => boolean
  /**
   * `selected` when the active row was taken, `run` when the draft already is
   * that command exactly and Enter should send it, `false` when there is
   * nothing to take.
   */
  selectActive: (key?: 'Enter' | 'Tab') => 'selected' | 'run' | false
}

export const COMPOSER_RESOURCE_LIST_ID = 'composer-resource-list'

/** The list's accessible name and its loading announcement. */
export type ComposerResourceListLabel = { label: string; loading: string }

/** What each marker lists: `/` commands and skills, `$` skills, `@` MCP servers. */
const LIST_LABELS = {
  '/': { label: 'Commands and skills', loading: 'Loading commands and skills…' },
  $: { label: 'Skills', loading: 'Loading skills…' },
  '@': { label: 'MCP servers', loading: 'Loading MCP servers…' },
} satisfies Record<ComposerResourceMarker, ComposerResourceListLabel>

export function composerResourceListLabel(
  marker: ComposerResourceMarker,
): ComposerResourceListLabel {
  return LIST_LABELS[marker]
}
