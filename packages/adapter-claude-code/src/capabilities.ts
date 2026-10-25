import type {
  Capabilities,
  McpCapabilities,
  McpServerConfig,
  ProviderRuntimeOption,
} from '@harness/contracts'

/**
 * Claude reports the servers its own settings, plugins and claude.ai load.
 * TasteCode adds project servers to new sessions; inherited ones stay
 * read-only, because hiding one would change Claude's own configuration.
 */
export const CLAUDE_MCP_CAPABILITIES: McpCapabilities = {
  inventory: true,
  add: true,
  update: true,
  remove: true,
  reload: false,
  startOAuth: false,
  cancelOAuth: false,
  hideInherited: false,
}

/** Keep unsupported provider operations out of saved project configuration too. */
export function validateClaudeMcpServer(
  server: McpServerConfig,
): asserts server is Extract<McpServerConfig, { enabled: true }> {
  if (!server.enabled)
    throw new Error(
      'Claude Code cannot hide an inherited MCP server without changing its own configuration. Remove this project override and manage that server in Claude Code.',
    )
  // The SDK copies names into ordinary objects; this name cannot survive that copy.
  if (server.id === '__proto__')
    throw new Error('Claude Code cannot use the MCP server id "__proto__". Choose another id.')
  if (!/^[A-Za-z0-9_-]+$/.test(server.id))
    throw new Error(
      'Claude Code MCP server ids can contain only letters, numbers, hyphens, and underscores.',
    )
  if (server.transport.type === 'stdio' && server.transport.cwd)
    throw new Error(
      `Claude Code MCP server "${server.id}" cannot use a custom working directory. Remove it to use the project directory.`,
    )
}

/**
 * Both drive the same `claude` executable over its stream-json protocol, so a
 * session offers the same things through either. The SDK is the default.
 */
export const CLAUDE_RUNTIMES = [
  {
    id: 'sdk',
    label: 'Agent SDK',
    description: "Anthropic's Agent SDK starts Claude Code and speaks its protocol",
  },
  {
    id: 'cli',
    label: 'claude -p',
    description: 'TasteCode starts claude -p and speaks its stream-json protocol itself',
  },
] as const satisfies readonly ProviderRuntimeOption[]

export type ClaudeRuntime = (typeof CLAUDE_RUNTIMES)[number]['id']

export function isClaudeRuntime(value: string | undefined): value is ClaudeRuntime {
  return CLAUDE_RUNTIMES.some((runtime) => runtime.id === value)
}

export const CLAUDE_CAPABILITIES: Capabilities = {
  steer: true,
  fork: false,
  interrupt: true,
  reasoningItems: true,
  approvals: true,
  userInput: true,
  autoReview: true,
  images: true,
  // task_progress messages count each agent's tool calls and tokens while it runs.
  subagents: 'progress',
  // Every process can run in another CLAUDE_CONFIG_DIR, which holds that
  // account's sign-in, settings and transcripts (account-home.ts).
  multipleAccounts: true,
  runtimes: [...CLAUDE_RUNTIMES],
  // Claude Code compacts about 13K tokens short of a 200K window by default,
  // and ignores an override later than that. 1M applies only where the model
  // offers it.
  context: {
    windows: [200_000, 1_000_000],
    compaction: true,
    compactionOff: true,
    defaultCompactAt: 93,
    latestCompactAt: 93,
  },
}
