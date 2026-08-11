// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Transport } from '../transport.js'
import { McpSettings } from './McpSettings.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function client(request: (method: string, params: unknown) => Promise<unknown>): Transport {
  return {
    state: 'open',
    request: vi.fn(request),
    on: vi.fn(() => () => {}),
    onState: vi.fn(() => () => {}),
  } as unknown as Transport
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

  it('recovers inventory after the connection reopens', async () => {
    let onState: ((state: 'open' | 'reconnecting') => void) | undefined
    const transport = {
      state: 'open',
      request: vi
        .fn()
        .mockRejectedValueOnce(new Error('Connection to the server was lost.'))
        .mockResolvedValueOnce({
          capabilities: {
            inventory: true,
            add: false,
            update: false,
            remove: false,
            reload: false,
            startOAuth: false,
            cancelOAuth: false,
          },
          servers: [],
        }),
      on: vi.fn(() => () => {}),
      onState: vi.fn((listener: typeof onState) => {
        onState = listener
        return () => undefined
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

    expect(await screen.findByRole('alert')).toBeTruthy()
    act(() => onState?.('reconnecting'))
    act(() => onState?.('open'))

    expect(await screen.findByText('No MCP servers are configured for this project.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('refreshes when background MCP discovery finishes', async () => {
    const listeners = new Map<string, (value: never) => void>()
    const transport = {
      state: 'open',
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
      onState: vi.fn(() => () => {}),
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

  it('keeps the current inventory visible during a background refresh', async () => {
    const listeners = new Map<string, (value: never) => void>()
    let resolveRefresh: ((value: unknown) => void) | undefined
    const refresh = new Promise((resolve) => {
      resolveRefresh = resolve
    })
    const inventory = {
      capabilities: {
        inventory: true,
        add: false,
        update: false,
        remove: false,
        reload: false,
        startOAuth: false,
        cancelOAuth: false,
      },
      servers: [
        {
          id: 'docs',
          scope: 'global' as const,
          enabled: true,
          auth: { status: 'not_required' as const },
          startup: { state: 'ready' as const },
          tools: [],
          resources: [],
          resourceTemplates: [],
        },
      ],
    }
    let lists = 0
    const transport = {
      state: 'open',
      request: vi.fn(async (method: string) => {
        if (method === 'mcp.list') return lists++ === 0 ? inventory : refresh
        throw new Error(`unexpected ${method}`)
      }),
      on: vi.fn((channel: string, listener: (value: never) => void) => {
        listeners.set(channel, listener)
        return () => listeners.delete(channel)
      }),
      onState: vi.fn(() => () => {}),
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

    expect(await screen.findByText('docs')).toBeTruthy()
    act(() =>
      listeners.get('mcp.changed')?.({
        provider: 'codex',
        projectPath: '/work/project',
      } as never),
    )
    await waitFor(() => expect(transport.request).toHaveBeenCalledTimes(2))

    expect(screen.getByText('docs')).toBeTruthy()
    expect(screen.queryByText('Loading MCP servers…')).toBeNull()

    await act(async () => resolveRefresh?.(inventory))
  })

  it('keeps a blocked-popup notice and prevents duplicate OAuth attempts until completion', async () => {
    const listeners = new Map<string, (value: never) => void>()
    const transport = {
      state: 'open',
      request: vi.fn(async (method: string) => {
        if (method === 'mcp.list') {
          return {
            capabilities: {
              inventory: true,
              add: false,
              update: false,
              remove: false,
              reload: false,
              startOAuth: true,
              cancelOAuth: false,
            },
            servers: [
              {
                id: 'docs',
                scope: 'global',
                enabled: true,
                auth: { status: 'sign_in_required', method: 'oauth' },
                startup: { state: 'ready' },
                tools: [],
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
      }),
      on: vi.fn((channel: string, listener: (value: never) => void) => {
        listeners.set(channel, listener)
        return () => listeners.delete(channel)
      }),
      onState: vi.fn(() => () => {}),
    } as unknown as Transport
    vi.spyOn(window, 'open').mockImplementation(() => null)
    render(
      <McpSettings
        transport={transport}
        provider="codex"
        providerName="Codex"
        projectPath="/work/project"
        projectName="Project"
      />,
    )

    const signIn = await screen.findByRole('button', { name: 'Sign in' })
    fireEvent.click(signIn)

    expect(
      await screen.findByText(
        'Your browser blocked the sign-in window. Open it yourself: https://auth.example.test/',
      ),
    ).toBeTruthy()
    expect((signIn as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(signIn)
    expect(
      vi.mocked(transport.request).mock.calls.filter(([method]) => method === 'mcp.startOAuth'),
    ).toHaveLength(1)

    act(() =>
      listeners.get('mcp.oauth')?.({
        provider: 'codex',
        projectPath: '/work/project',
        serverId: 'docs',
        loginId: 'another-login',
        success: true,
        error: null,
      } as never),
    )
    expect((signIn as HTMLButtonElement).disabled).toBe(true)

    act(() =>
      listeners.get('mcp.oauth')?.({
        provider: 'codex',
        projectPath: '/work/project',
        serverId: 'docs',
        loginId: 'login-1',
        success: true,
        error: null,
      } as never),
    )
    expect(await screen.findByText('MCP sign-in completed.')).toBeTruthy()
    expect((signIn as HTMLButtonElement).disabled).toBe(false)
  })

  it('settles OAuth when completion arrives before the start response', async () => {
    const listeners = new Map<string, (value: never) => void>()
    let resolveStart: ((value: { loginId: string; authUrl: string }) => void) | undefined
    const start = new Promise<{ loginId: string; authUrl: string }>((resolve) => {
      resolveStart = resolve
    })
    const transport = {
      state: 'open',
      request: vi.fn(async (method: string) => {
        if (method === 'mcp.list') {
          return {
            capabilities: {
              inventory: true,
              add: false,
              update: false,
              remove: false,
              reload: false,
              startOAuth: true,
              cancelOAuth: false,
            },
            servers: [
              {
                id: 'docs',
                scope: 'global',
                enabled: true,
                auth: { status: 'sign_in_required', method: 'oauth' },
                startup: { state: 'ready' },
                tools: [],
                resources: [],
                resourceTemplates: [],
              },
            ],
          }
        }
        if (method === 'mcp.startOAuth') return start
        throw new Error(`unexpected ${method}`)
      }),
      on: vi.fn((channel: string, listener: (value: never) => void) => {
        listeners.set(channel, listener)
        return () => listeners.delete(channel)
      }),
      onState: vi.fn(() => () => {}),
    } as unknown as Transport
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

    const signIn = await screen.findByRole('button', { name: 'Sign in' })
    fireEvent.click(signIn)
    act(() =>
      listeners.get('mcp.oauth')?.({
        provider: 'codex',
        projectPath: '/work/project',
        serverId: 'docs',
        loginId: 'login-1',
        success: true,
        error: null,
      } as never),
    )
    expect((signIn as HTMLButtonElement).disabled).toBe(true)

    await act(async () =>
      resolveStart?.({ loginId: 'login-1', authUrl: 'https://auth.example.test/' }),
    )

    expect(await screen.findByText('MCP sign-in completed.')).toBeTruthy()
    expect((signIn as HTMLButtonElement).disabled).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('ignores a completed change after switching projects', async () => {
    let finishChange: (() => void) | undefined
    const change = new Promise<void>((resolve) => {
      finishChange = resolve
    })
    const inventory = (id: string) => ({
      capabilities: {
        inventory: true,
        add: true,
        update: false,
        remove: true,
        reload: false,
        startOAuth: false,
        cancelOAuth: false,
      },
      servers: [
        {
          id,
          scope: 'global',
          enabled: true,
          auth: { status: 'not_required' },
          startup: { state: 'ready' },
          tools: [],
          resources: [],
          resourceTemplates: [],
        },
      ],
    })
    const transport = client(async (method, params) => {
      const projectPath = (params as { projectPath: string }).projectPath
      if (method === 'mcp.list') return inventory(projectPath === '/work/alpha' ? 'alpha' : 'beta')
      if (method === 'mcp.add') return change
      throw new Error(`unexpected ${method}`)
    })
    const view = render(
      <McpSettings
        transport={transport}
        provider="codex"
        providerName="Codex"
        projectPath="/work/alpha"
        projectName="Alpha"
      />,
    )

    expect(await screen.findByText('alpha')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Disable alpha for this project' }))
    view.rerender(
      <McpSettings
        transport={transport}
        provider="codex"
        providerName="Codex"
        projectPath="/work/beta"
        projectName="Beta"
      />,
    )
    expect(await screen.findByText('beta')).toBeTruthy()

    await act(async () => finishChange?.())

    expect(screen.getByText('beta')).toBeTruthy()
    expect(
      vi
        .mocked(transport.request)
        .mock.calls.filter(
          ([method, params]) =>
            method === 'mcp.list' &&
            (params as { projectPath: string }).projectPath === '/work/alpha',
        ),
    ).toHaveLength(1)
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
