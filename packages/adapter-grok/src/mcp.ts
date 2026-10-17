import type { McpCapabilities } from '@harness/contracts'

/**
 * Grok reports the servers its own configuration loads (including the Claude
 * and Cursor settings it reads) once a session starts. TasteCode adds project
 * servers to MCP chats over ACP; inherited ones stay read-only, because ACP
 * cannot hide a server Grok loads itself.
 */
export const GROK_MCP_CAPABILITIES: McpCapabilities = {
  inventory: true,
  add: true,
  update: true,
  remove: true,
  reload: false,
  startOAuth: false,
  cancelOAuth: false,
  hideInherited: false,
}
