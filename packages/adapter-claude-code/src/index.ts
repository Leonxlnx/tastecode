export {
  ClaudeCodeAdapter,
  CLAUDE_CAPABILITIES,
  claudeContextEnvironment,
  type ClaudeStartOptions,
} from './adapter.js'
export { CLAUDE_MCP_CAPABILITIES } from './capabilities.js'
export {
  CLAUDE_HIDDEN_COMMANDS,
  CLAUDE_TERMINAL_COMMANDS,
  mapClaudeCommands,
  mapClaudeMcpServer,
  mapClaudeMcpServers,
  type ClaudeCommandHints,
} from './inventory.js'
export {
  discoverClaudeProject,
  type ClaudeProjectDiscoveryOptions,
  type ClaudeProjectInventory,
} from './discovery.js'
export { claudeInventoryWatchPaths, type ClaudeInventoryWatch } from './watch-paths.js'
export { claudeAccount, parseClaudeAccount, signOutClaude, startClaudeLogin } from './auth.js'
export { claudeLimitSource, type ClaudeLimitSource } from './limits.js'
export { toDomainEvents, toUsage, type ClaudeEvent } from './events.js'
export { CLAUDE_USAGE_HISTORY, readClaudeUsageHistory } from './usage-history.js'
export { createClaudeHistorySource, type ClaudeHistoryOptions } from './history.js'
