import path from 'node:path'
import type {
  McpCapabilities,
  McpServer,
  McpStartupStatus,
  ProviderCommand,
  Skill,
} from '@harness/contracts'
import { z } from 'zod'

/**
 * OpenCode's commands, skills and MCP status as TasteCode shows them.
 *
 * Read from the documented `GET /command`, `GET /skill` and `GET /mcp` routes
 * of `opencode serve` (1.18.13; see its served OpenAPI at `/doc`), scoped with
 * `?directory=`. Captured: fixtures/inventory-opencode-1.18.13.json. The v2
 * `/api/command` answered an empty list on the same server, so it is not used.
 * Command templates and skill bodies are prompts, never passed on.
 */

/**
 * TasteCode adds project servers through `OPENCODE_CONFIG_CONTENT`, and the
 * same layer turns an inherited server off (captured: a project server set to
 * `enabled: false` there reported `disabled`).
 */
export const OPENCODE_MCP_CAPABILITIES: McpCapabilities = {
  inventory: true,
  add: true,
  update: true,
  remove: true,
  reload: false,
  startOAuth: false,
  cancelOAuth: false,
  hideInherited: true,
}

const COMMAND_NAME = /^[^/\s]\S*$/
const MAX_TEXT = 300

const CommandSchema = z.object({
  name: z.string(),
  description: z.string().nullish(),
  source: z.string().nullish(),
  hints: z.array(z.string()).nullish(),
})
const SkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullish(),
  location: z.string().min(1),
})
const McpStatusSchema = z.object({ status: z.string(), error: z.string().nullish() })

/** `$ARGUMENTS` takes the rest of the message; `$1`, `$2` take one word each. */
function argumentHint(hints: readonly string[]): string | undefined {
  const parts = hints.flatMap((hint) =>
    hint === '$ARGUMENTS' ? ['[arguments]'] : /^\$\d+$/.test(hint) ? [`[arg${hint.slice(1)}]`] : [],
  )
  return parts.length ? [...new Set(parts)].join(' ') : undefined
}

/** `GET /command`: commands, skills (`source: 'skill'`) and MCP prompts, one per name. */
export function mapOpenCodeCommands(value: unknown): ProviderCommand[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const commands: ProviderCommand[] = []
  for (const entry of value) {
    const parsed = CommandSchema.safeParse(entry)
    if (!parsed.success) continue
    const { name, description, source, hints } = parsed.data
    if (name.length > 200 || !COMMAND_NAME.test(name) || seen.has(name)) continue
    seen.add(name)
    const hint = argumentHint(hints ?? [])
    commands.push({
      name,
      description: description ?? '',
      ...(hint ? { argumentHint: hint } : {}),
      ...(source === 'skill' ? { kind: 'skill' as const } : {}),
    })
  }
  return commands
}

/** OpenCode reports paths in its own platform's style, whatever the reader runs on. */
function pathsOf(location: string): typeof path.posix {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(location) ? path.win32 : path.posix
}

/** `GET /skill`: a skill inside the project is the project's; `<built-in>` is OpenCode's own. */
export function mapOpenCodeSkills(value: unknown, projectPath: string): Skill[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const skills: Skill[] = []
  for (const entry of value) {
    const parsed = SkillSchema.safeParse(entry)
    if (!parsed.success) continue
    const { name, description, location } = parsed.data
    const paths = pathsOf(location)
    const file = paths.isAbsolute(location) ? location : undefined
    const id = file ?? `opencode:${name}`
    if (seen.has(id)) continue
    seen.add(id)
    const relative = file ? paths.relative(projectPath, file) : '..'
    const inProject = relative !== '' && !relative.startsWith('..') && !paths.isAbsolute(relative)
    skills.push({
      id,
      name,
      description: description ?? '',
      source: file ? { type: 'folder', path: paths.dirname(file) } : { type: 'provider' },
      scope: !file ? 'system' : inProject ? 'project' : 'user',
      enabled: true,
      dependencyErrors: [],
    })
  }
  return skills
}

function startup(status: string, error: string | undefined): McpStartupStatus {
  switch (status) {
    case 'connected':
      return { state: 'ready' }
    case 'disabled':
    case 'needs_auth':
      return { state: 'stopped' }
    default: {
      const message = (error ?? '').replace(/\s+/g, ' ').trim()
      return {
        state: 'failed',
        message: message
          ? message.length > MAX_TEXT
            ? `${message.slice(0, MAX_TEXT - 1)}…`
            : message
          : 'MCP server failed to start',
      }
    }
  }
}

/**
 * `GET /mcp`: `{ [name]: { status, error? } }`. The status carries no tools
 * and no transport; inherited configs can hold tokens, so none is guessed.
 */
export function mapOpenCodeMcpServers(value: unknown): McpServer[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  return Object.entries(value).flatMap(([id, entry]) => {
    const parsed = McpStatusSchema.safeParse(entry)
    if (!id || !parsed.success) return []
    const { status, error } = parsed.data
    const signIn = status === 'needs_auth' || status === 'needs_client_registration'
    return [
      {
        id,
        scope: 'global' as const,
        enabled: status !== 'disabled',
        auth: signIn
          ? { status: 'sign_in_required' as const, method: 'oauth' as const }
          : { status: 'not_required' as const },
        startup: startup(status, error ?? undefined),
        tools: [],
        resources: [],
        resourceTemplates: [],
      },
    ]
  })
}
