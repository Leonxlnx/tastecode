import type { McpServerStatus, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { McpServer, McpStartupStatus, ProviderCommand } from '@harness/contracts'

/**
 * Built-ins that change state TasteCode owns (the chat, model, effort, settings
 * and account), internal handoffs, and retired stubs claude 2.1.296 still
 * lists. A user can still type any of them in full.
 */
export const CLAUDE_HIDDEN_COMMANDS: ReadonlySet<string> = new Set([
  'clear',
  'model',
  'effort',
  'fast',
  'config',
  'color',
  'focus',
  'rename',
  'resume',
  'exit',
  'login',
  'logout',
  'advisor',
  'output-style',
  'autocompact',
  'heapdump',
  'workflow-launch-exec',
  // "Renamed to /usage-credits" and "(removed) …" in 2.1.296.
  'extra-usage',
  'agents',
])

/**
 * What claude 2.1.296 flags in system/init `terminal_slash_commands`. That
 * frame arrives only with the first prompt, so this answers until it does.
 */
export const CLAUDE_TERMINAL_COMMANDS: ReadonlySet<string> = new Set([
  'doctor',
  'color',
  'focus',
  'reload-plugins',
])

export type ClaudeCommandHints = {
  /** system/init `skills`; some are listed by a command's alias, such as "anthropic-skills:pdf". */
  skills?: ReadonlySet<string> | undefined
  /** system/init `terminal_slash_commands`; absent means the captured default. */
  terminal?: ReadonlySet<string> | undefined
}

const MAX_HINT = 200
const MAX_ALIASES = 20

function commandName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 200 &&
    /^[^/\s]\S*$/.test(value) &&
    !value.startsWith('__')
  )
}

/** Claude's commands and skills as the composer offers them, without the ones it must not. */
export function mapClaudeCommands(
  commands: readonly SlashCommand[],
  hints: ClaudeCommandHints = {},
): ProviderCommand[] {
  const terminal = hints.terminal ?? CLAUDE_TERMINAL_COMMANDS
  const seen = new Set<string>()
  const mapped: ProviderCommand[] = []
  for (const command of commands) {
    const name = command.name
    if (!commandName(name) || seen.has(name)) continue
    if (CLAUDE_HIDDEN_COMMANDS.has(name) || terminal.has(name)) continue
    seen.add(name)
    const aliases = [
      ...new Set((command.aliases ?? []).filter((alias) => commandName(alias) && alias !== name)),
    ].slice(0, MAX_ALIASES)
    const hint = typeof command.argumentHint === 'string' ? command.argumentHint.trim() : ''
    const skill = hints.skills && [name, ...aliases].some((entry) => hints.skills!.has(entry))
    mapped.push({
      name,
      description: typeof command.description === 'string' ? command.description : '',
      ...(hint
        ? { argumentHint: hint.length > MAX_HINT ? `${hint.slice(0, MAX_HINT - 1)}…` : hint }
        : {}),
      ...(aliases.length ? { aliases } : {}),
      ...(skill ? { kind: 'skill' as const } : {}),
    })
  }
  return mapped
}

const PLUGIN_SERVER = /^plugin:([^:]+):(.+)$/
const CLAUDE_AI_SERVER = 'claude.ai '

/** Where Claude loaded a server from, in the words Settings shows under its name. */
function sourceLabel(scope: string | undefined, plugin: string | undefined): string | undefined {
  switch (scope) {
    case 'user':
      return 'Claude Code user settings'
    case 'project':
      return 'Project .mcp.json'
    case 'local':
      return 'Local project settings'
    case 'dynamic':
      // TasteCode passes its project servers to the SDK; plugins add the rest.
      return plugin ? `Plugin ${plugin}` : 'Added by TasteCode'
    case 'claudeai':
      return 'claude.ai connector'
    case 'managed':
    case 'enterprise':
      return 'Managed'
    default:
      return undefined
  }
}

function startup(status: McpServerStatus, redact: (text: string) => string): McpStartupStatus {
  switch (status.status) {
    case 'connected':
      return { state: 'ready' }
    case 'pending':
      return { state: 'starting' }
    case 'failed':
      return {
        state: 'failed',
        message: redact(status.error?.trim() || 'MCP server failed to start'),
      }
    default:
      // A disabled server and one waiting for a sign-in are both not running.
      return { state: 'stopped' }
  }
}

/**
 * One entry of `mcpServerStatus()`. The transport stays out: inherited
 * configs can carry tokens in arguments or URLs, and Claude owns them.
 */
export function mapClaudeMcpServer(
  status: McpServerStatus,
  redact: (text: string) => string = (text) => text,
): McpServer {
  const plugin = PLUGIN_SERVER.exec(status.name)
  const displayName = plugin
    ? plugin[2]
    : status.name.startsWith(CLAUDE_AI_SERVER)
      ? status.name.slice(CLAUDE_AI_SERVER.length).trim()
      : undefined
  const description = sourceLabel(status.scope, plugin?.[1])
  const version = status.serverInfo?.version
  return {
    id: status.name,
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
    scope: 'global',
    enabled: status.status !== 'disabled',
    auth:
      status.status === 'needs-auth'
        ? { status: 'sign_in_required', method: 'oauth' }
        : { status: 'not_required' },
    startup: startup(status, redact),
    // The status list carries no input schemas.
    tools: (status.tools ?? []).flatMap((tool) =>
      typeof tool.name === 'string' && tool.name
        ? [
            {
              name: tool.name,
              ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
              inputSchema: {},
            },
          ]
        : [],
    ),
    resources: [],
    resourceTemplates: [],
  }
}

/** The whole status list in Claude's order, one row per name. */
export function mapClaudeMcpServers(
  statuses: readonly McpServerStatus[],
  redact?: (text: string) => string,
): McpServer[] {
  const seen = new Set<string>()
  return statuses.flatMap((status) => {
    if (typeof status.name !== 'string' || !status.name || seen.has(status.name)) return []
    seen.add(status.name)
    return [mapClaudeMcpServer(status, redact)]
  })
}
