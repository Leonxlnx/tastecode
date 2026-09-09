import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import { activateClaudeMcpServers } from './mcp-bootstrap.js'

const bootstrap = { local: { type: 'http' as const, url: 'http://127.0.0.1:49152/bootstrap' } }
const configured = { local: { type: 'stdio' as const, command: 'node', args: ['fixture.mjs'] } }
const initial: McpServerStatus = {
  name: 'local',
  status: 'connected',
  config: bootstrap.local,
  tools: [],
}
const effective: McpServerStatus = {
  ...initial,
  config: configured.local,
  tools: [{ name: 'ping' }],
}

function controls(replies: McpServerStatus[][]) {
  return {
    mcpServerStatus: vi.fn(async () => (replies.length > 1 ? replies.shift()! : replies[0]!)),
    setMcpServers: vi.fn(async () => ({ added: ['local'], removed: [], errors: {} })),
  }
}

describe('Claude MCP bootstrap controls', () => {
  it('waits for real transport identity after a stale connected bootstrap response', async () => {
    const query = controls([[initial], [initial], [{ ...initial, status: 'pending' }], [effective]])
    await activateClaudeMcpServers(query, bootstrap, configured, new AbortController().signal)
    expect(query.mcpServerStatus).toHaveBeenCalledTimes(4)
    expect(query.setMcpServers).toHaveBeenCalledExactlyOnceWith(configured)
  })

  it.each([
    {
      label: 'tools',
      statuses: [{ ...initial, tools: [{ name: 'inherited-tool' }] }],
      message: 'could not reserve',
    },
    { label: 'duplicate id', statuses: [initial, initial], message: 'duplicate MCP server' },
    {
      label: 'failed server',
      statuses: [{ ...initial, status: 'failed' as const, error: 'cannot connect' }],
      message: 'cannot connect',
    },
  ])(
    'rejects unsafe bootstrap $label before sending real config',
    async ({ statuses, message }) => {
      const query = controls([statuses])
      await expect(
        activateClaudeMcpServers(query, bootstrap, configured, new AbortController().signal),
      ).rejects.toThrow(message)
      expect(query.setMcpServers).not.toHaveBeenCalled()
    },
  )

  it('rejects replacement errors before readiness', async () => {
    const query = controls([[initial]])
    query.setMcpServers.mockResolvedValue({
      added: [],
      removed: [],
      errors: { local: 'connection refused' },
    })
    await expect(
      activateClaudeMcpServers(query, bootstrap, configured, new AbortController().signal),
    ).rejects.toThrow('connection refused')
  })

  it.each(['missing', 'wrong identity'] as const)(
    'cancels a %s replacement instead of claiming readiness',
    async (state) => {
      const query = controls([[initial], state === 'missing' ? [] : [initial]])
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), 120)
      try {
        await expect(
          activateClaudeMcpServers(query, bootstrap, configured, abort.signal),
        ).rejects.toThrow()
        expect(query.setMcpServers).toHaveBeenCalledOnce()
        expect(query.mcpServerStatus.mock.calls.length).toBeGreaterThan(2)
      } finally {
        clearTimeout(timer)
      }
    },
  )
})
