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

  it('replaces the loading state with a retryable error', async () => {
    const transport = client(async () => {
      throw new Error('Codex did not respond')
    })
    render(
      <McpSettings
        transport={transport}
        provider="codex"
        providerName="Codex"
        projectPath="/work/project"
        projectName="Project"
      />,
    )

    expect((await screen.findByRole('alert')).textContent).toContain('Codex did not respond')
    expect(screen.queryByText('Loading MCP servers…')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(transport.request).toHaveBeenCalledTimes(2))
  })

  it('refreshes when background MCP discovery finishes', async () => {
    const listeners = new Map<string, (value: never) => void>()
    const transport = {
      request: vi.fn(async () => ({
        capabilities: {
          inventory: true,
          add: true,
          update: true,
          remove: true,
          reload: true,
          startOAuth: true,
          cancelOAuth: false,
        },
        servers: [],
      })),
      on: vi.fn((channel: string, listener: (value: never) => void) => {
        listeners.set(channel, listener)
        return () => listeners.delete(channel)
      }),
    } as unknown as Transport
    render(
      <McpSettings
        transport={transport}
        provider="codex"
        providerName="Codex"
        projectPath="/work/project"
        projectName="Project"
      />,
    )

    await waitFor(() => expect(transport.request).toHaveBeenCalledTimes(1))
    listeners.get('mcp.changed')?.({ provider: 'codex', projectPath: '/work/project' } as never)
    await waitFor(() => expect(transport.request).toHaveBeenCalledTimes(2))
  })

  it('adds a project server and disables an inherited server', async () => {
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
              id: 'github',
              scope: 'global',
              enabled: true,
              auth: { status: 'not_required' },
              startup: { state: 'ready' },
              tools: [],
              resources: [],
              resourceTemplates: [],
            },
          ],
        }
      }
      if (method === 'mcp.add' || method === 'mcp.reload') return {}
      throw new Error(`unexpected ${method}`)
    })
    render(
      <McpSettings
        transport={transport}
        provider="codex"
        providerName="Codex"
        projectPath="/work/project"
        projectName="Project"
      />,
    )

    expect(await screen.findByText('github')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    fireEvent.change(screen.getByLabelText('Server ID'), { target: { value: 'docs' } })
    fireEvent.change(screen.getByLabelText('Transport JSON', { exact: false }), {
      target: { value: '{"type":"http","url":"https://docs.example.test/mcp"}' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save server' }))

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('mcp.add', {
        provider: 'codex',
        projectPath: '/work/project',
        server: {
          id: 'docs',
          enabled: true,
          transport: { type: 'http', url: 'https://docs.example.test/mcp' },
        },
      })
    })

    fireEvent.click(screen.getByRole('switch', { name: 'Disable github for this project' }))
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('mcp.add', {
        provider: 'codex',
        projectPath: '/work/project',
        server: { id: 'github', enabled: false },
      })
    })
  })
})
