import type { ProviderCommand } from '@harness/contracts'

/**
 * ACP `available_commands_update` entries as the composer offers them.
 *
 * Written against grok 1.0.62 `agent stdio` (fixtures/available-commands-grok-1.0.62.json):
 * `{ name, description, input: { hint } | null, _meta? }`. Entries are read one
 * by one, so a malformed entry drops only itself, never the agent's whole list.
 */

const COMMAND_NAME = /^[^/\s]\S*$/
const MAX_NAME = 200
const MAX_HINT = 200

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** A skill is a command whose definition is a SKILL.md file. */
export function acpCommandSkillPath(entry: unknown): string | undefined {
  const path = record(record(entry)?._meta)?.path
  return typeof path === 'string' && /(?:^|[\\/])SKILL\.md$/i.test(path) ? path : undefined
}

/** The name the agent runs when a message starts with `/name`, or undefined when unusable. */
export function acpCommandName(entry: unknown): string | undefined {
  const raw = record(entry)?.name
  if (typeof raw !== 'string') return undefined
  // The spec names commands without the slash; tolerate an agent that sends one.
  const name = raw.trim().replace(/^\//, '')
  return name.length <= MAX_NAME && COMMAND_NAME.test(name) ? name : undefined
}

export function mapAcpCommands(entries: readonly unknown[]): ProviderCommand[] {
  const seen = new Set<string>()
  const commands: ProviderCommand[] = []
  for (const entry of entries) {
    const name = acpCommandName(entry)
    if (!name || seen.has(name)) continue
    seen.add(name)
    const fields = record(entry)!
    const input = record(fields.input)
    const hint = typeof input?.hint === 'string' ? input.hint.trim() : ''
    commands.push({
      name,
      description: typeof fields.description === 'string' ? fields.description : '',
      ...(hint
        ? { argumentHint: hint.length > MAX_HINT ? `${hint.slice(0, MAX_HINT - 1)}…` : hint }
        : {}),
      ...(acpCommandSkillPath(entry) ? { kind: 'skill' as const } : {}),
    })
  }
  return commands
}
