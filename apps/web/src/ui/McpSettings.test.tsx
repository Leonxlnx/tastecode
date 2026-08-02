// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Transport } from '../transport.js'
import { McpSettings } from './McpSettings.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function client(request: (method: string) => Promise<unknown>): Transport {
  return { request: vi.fn(request), on: vi.fn(() => () => {}) } as unknown as Transport
}

describe('MCP settings', () => {
  it('shows live inventory, failures, tools, and starts OAuth', async () => {
    const transport = client(async (method) => {
      if (method === 'mcp.list') {
        return {
          capabilities: {
            inventory: true,
            add: true,
            update: true,
            remove: true,
            reload: true,
            startOAuth: true,
            cancelOAuth: false,
          },
          servers: [
            {
              id: 'docs',
              displayName: 'Developer Docs',
              scope: 'global',
              enabled: true,
              auth: { status: 'sign_in_required', method: 'oauth' },
              startup: { state: 'failed', message: 'OAuth token expired' },
              tools: [
                {
                  name: 'search_docs',
                  description: 'Search official docs.',
                  inputSchema: { type: 'object' },
                },
              ],
              resources: [],
              resourceTemplates: [],
            },
          ],
        }
      }
      if (method === 'mcp.startOAuth') {
        return { loginId: 'login-1', authUrl: 'https://auth.example.test/' }
      }
      throw new Error(`unexpected ${method}`)
    })
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(
      <McpSettings
        transport={transport}
        provider="codex"
        providerName="Codex"
        projectPath="/work/project"
        projectName="Project"
      />,
    )

    expect(await screen.findByText('Developer Docs')).toBeTruthy()
    expect(screen.getByText('OAuth token expired')).toBeTruthy()
    fireEvent.click(screen.getByText(/1 tools/))
    expect(screen.getByText('search_docs')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('mcp.startOAuth', {
        provider: 'codex',
        projectPath: '/work/project',
        serverId: 'docs',
      })
      expect(open).toHaveBeenCalledWith(
        'https://auth.example.test/',
        '_blank',
        'noopener,noreferrer',
      )
    })
  })

  it('shows no controls for unsupported providers', async () => {
    const transport = client(async () => ({
      capabilities: {
        inventory: false,
        add: false,
        update: false,
        remove: false,
        reload: false,
        startOAuth: false,
        cancelOAuth: false,
      },
      servers: [],
    }))
    render(
      <McpSettings
        transport={transport}
        provider="claude-code"
        providerName="Claude Code"
        projectPath="/work/project"
        projectName="Project"
      />,
    )

    expect(await screen.findByText(/does not expose MCP servers/)).toBeTruthy()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})
