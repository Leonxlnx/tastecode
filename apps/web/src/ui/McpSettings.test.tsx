// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { methods, type ResultOf } from '@harness/contracts'
import { TestTransport, type TestRequestResolver } from '../test-transport.js'
import { requiredInstance } from '../test-dom.js'
import { McpSettings } from './McpSettings.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function client(request: TestRequestResolver): TestTransport {
  return new TestTransport(request)
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
              scope: 'project',
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
    expect(screen.getByText('Codex · MCP inventory available')).toBeTruthy()
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite')
    expect(screen.queryByText('Available in Project')).toBeNull()
    expect(screen.getByText('OAuth token expired')).toBeTruthy()
    fireEvent.click(screen.getByText(/1 tools/))
    expect(screen.getByText('search_docs')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(transport.requests).toContainEqual({
        method: 'mcp.startOAuth',
        params: {
          provider: 'codex',
          projectPath: '/work/project',
          serverId: 'docs',
        },
      })
      expect(open).toHaveBeenCalledWith(
        'https://auth.example.test/',
        '_blank',
        'noopener,noreferrer',
      )
    })
  })

  it('keeps rendering when a legacy live server has no auth or startup status', async () => {
    const transport = client(async () => ({
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
          id: 'legacy-server',
          scope: 'project',
          enabled: true,
          tools: [],
          resources: [],
          resourceTemplates: [],
        },
      ],
    }))
    render(
      <McpSettings
        transport={transport}
        provider="codex"
        providerName="Codex"
        projectPath="/work/project"
        projectName="Project"
      />,
    )

    expect(await screen.findByText('legacy-server')).toBeTruthy()
    expect(screen.getByText('status unavailable')).toBeTruthy()
  })

  it('starts empty when the provider only reports global servers', async () => {
    const transport = client(async () => ({
      capabilities: {
        inventory: true,
        add: true,
        update: true,
        remove: true,
        reload: false,
        startOAuth: false,
        cancelOAuth: false,
      },
      servers: [
        {
          id: 'provider-global',
          scope: 'global',
          enabled: true,
          auth: { status: 'not_required' },
          startup: { state: 'ready' },
          tools: [],
          resources: [],
          resourceTemplates: [],
        },
      ],
    }))
    render(
      <McpSettings
        transport={transport}
        provider="codex"
        providerName="Codex"
        projectPath="/work/project"
        projectName="Project"
      />,
    )

    expect(await screen.findByText('No MCP servers have been added to this project.')).toBeTruthy()
    expect(screen.queryByText('provider-global')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add server' })).toBeTruthy()
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

    expect(await screen.findByText(/Provider-global inventory is unavailable/)).toBeTruthy()
    expect(screen.getByText('Claude Code · MCP inventory unavailable')).toBeTruthy()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('switches providers before adding a project server', async () => {
    const transport = client(async (method, params) => {
      if (method === 'mcp.list') {
        const { provider } = methods['mcp.list'].params.parse(params)
        return {
          capabilities: {
            inventory: provider === 'codex',
            add: true,
            update: true,
            remove: true,
            reload: provider === 'codex',
            startOAuth: provider === 'codex',
            cancelOAuth: false,
          },
          servers: [],
        }
      }
      if (method === 'mcp.add') return {}
      if (method === 'mcp.reload') return {}
      throw new Error(`unexpected ${method}`)
    })
    render(
      <McpSettings
        transport={transport}
        provider="codex"
        providerName="Codex"
        providers={[
          { provider: 'codex', providerName: 'Codex' },
          { provider: 'grok', providerName: 'Grok' },
        ]}
        projectPath="/work/project"
        projectName="Project"
      />,
    )

    const picker = await screen.findByRole('combobox', { name: 'MCP provider' })
    expect(picker.textContent).toContain('Codex')
    fireEvent.click(picker)
    fireEvent.click(await screen.findByRole('option', { name: 'Grok' }))

    expect(await screen.findByText('Grok · MCP inventory unavailable')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Server ID' }), {
      target: { value: 'test-tools' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save server' }))

    await waitFor(() =>
      expect(transport.requests).toContainEqual({
        method: 'mcp.add',
        params: {
          provider: 'grok',
          projectPath: '/work/project',
          server: {
            id: 'test-tools',
            enabled: true,
            transport: { type: 'http', url: 'https://example.com/mcp' },
          },
        },
      }),
    )
    expect(transport.requests).not.toContainEqual({
      method: 'mcp.reload',
      params: expect.objectContaining({ provider: 'grok' }),
    })
  })

  it('reports inventory separately when configuration remains available', async () => {
    const transport = client(async () => ({
      capabilities: {
        inventory: false,
        add: true,
        update: true,
        remove: true,
        reload: false,
        startOAuth: false,
        cancelOAuth: false,
      },
      servers: [],
    }))
    render(
      <McpSettings
        transport={transport}
        provider="opencode"
        providerName="OpenCode"
        projectPath="/work/project"
        projectName="Project"
      />,
    )

    expect(await screen.findByText('OpenCode · MCP inventory unavailable')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add server' })).toBeTruthy()
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
    expect(screen.getByText('Codex · MCP inventory status unavailable')).toBeTruthy()
    expect(screen.queryByText('Loading MCP servers…')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(transport.requests).toHaveLength(2))
  })

  it('recovers inventory after the connection reopens', async () => {
    let attempts = 0
    const transport = client(async (method) => {
      if (method !== 'mcp.list') throw new Error(`unexpected ${method}`)
      attempts += 1
      if (attempts === 1) throw new Error('Connection to the server was lost.')
      return {
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
      }
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

    expect(await screen.findByRole('alert')).toBeTruthy()
    act(() => transport.emitState('reconnecting'))
    act(() => transport.emitState('open'))

    expect(await screen.findByText('No MCP servers have been added to this project.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('refreshes when background MCP discovery finishes', async () => {
    const transport = client(async () => ({
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
    }))
    render(
      <McpSettings
        transport={transport}
        provider="codex"
        providerName="Codex"
        projectPath="/work/project"
        projectName="Project"
      />,
    )

    await waitFor(() => expect(transport.requests).toHaveLength(1))
    transport.emit('mcp.changed', { provider: 'codex', projectPath: '/work/project' })
    await waitFor(() => expect(transport.requests).toHaveLength(2))
  })

  it('keeps the current inventory visible during a background refresh', async () => {
    let resolveRefresh: ((value: ResultOf<'mcp.list'>) => void) | undefined
    const refresh = new Promise<ResultOf<'mcp.list'>>((resolve) => {
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
          scope: 'project' as const,
          enabled: true,
          auth: { status: 'not_required' as const },
          startup: { state: 'ready' as const },
          tools: [],
          resources: [],
          resourceTemplates: [],
        },
      ],
    } satisfies ResultOf<'mcp.list'>
    let lists = 0
    const transport = client(async (method) => {
      if (method === 'mcp.list') return lists++ === 0 ? inventory : refresh
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

    expect(await screen.findByText('docs')).toBeTruthy()
    act(() =>
      transport.emit('mcp.changed', {
        provider: 'codex',
        projectPath: '/work/project',
      }),
    )
    await waitFor(() => expect(transport.requests).toHaveLength(2))

    expect(screen.getByText('docs')).toBeTruthy()
    expect(screen.queryByText('Loading MCP servers…')).toBeNull()

    await act(async () => resolveRefresh?.(inventory))
  })

  it('keeps a blocked-popup notice and prevents duplicate OAuth attempts until completion', async () => {
    const transport = client(async (method) => {
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
              scope: 'project',
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
    })
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
    expect(requiredInstance(signIn, HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(signIn)
    expect(
      transport.requests.filter((request) => request.method === 'mcp.startOAuth'),
    ).toHaveLength(1)

    act(() =>
      transport.emit('mcp.oauth', {
        provider: 'codex',
        projectPath: '/work/project',
        serverId: 'docs',
        loginId: 'another-login',
        success: true,
        error: null,
      }),
    )
    expect(requiredInstance(signIn, HTMLButtonElement).disabled).toBe(true)

    act(() =>
      transport.emit('mcp.oauth', {
        provider: 'codex',
        projectPath: '/work/project',
        serverId: 'docs',
        loginId: 'login-1',
        success: true,
        error: null,
      }),
    )
    expect(await screen.findByText('MCP sign-in completed.')).toBeTruthy()
    expect(requiredInstance(signIn, HTMLButtonElement).disabled).toBe(false)
  })

  it('settles OAuth when completion arrives before the start response', async () => {
    let resolveStart: ((value: { loginId: string; authUrl: string }) => void) | undefined
    const start = new Promise<{ loginId: string; authUrl: string }>((resolve) => {
      resolveStart = resolve
    })
    const transport = client(async (method) => {
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
              scope: 'project',
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

    const signIn = await screen.findByRole('button', { name: 'Sign in' })
    fireEvent.click(signIn)
    act(() =>
      transport.emit('mcp.oauth', {
        provider: 'codex',
        projectPath: '/work/project',
        serverId: 'docs',
        loginId: 'login-1',
        success: true,
        error: null,
      }),
    )
    expect(requiredInstance(signIn, HTMLButtonElement).disabled).toBe(true)

    await act(async () =>
      resolveStart?.({ loginId: 'login-1', authUrl: 'https://auth.example.test/' }),
    )

    expect(await screen.findByText('MCP sign-in completed.')).toBeTruthy()
    expect(requiredInstance(signIn, HTMLButtonElement).disabled).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('ignores a completed change after switching projects', async () => {
    Object.defineProperty(window, 'confirm', { configurable: true, value: () => true })
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
          scope: 'project',
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
      const { projectPath } = methods['mcp.list'].params.parse(params)
      if (method === 'mcp.list') return inventory(projectPath === '/work/alpha' ? 'alpha' : 'beta')
      if (method === 'mcp.remove') return change
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
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    view.rerender(
      <McpSettings
        transport={transport}
        provider="codex"
        providerName="Codex"
        projectPath="/work/beta"
        projectName="Beta"
      />,
    )
    expect(screen.getByText('Checking Codex MCP support…')).toBeTruthy()
    expect(await screen.findByText('beta')).toBeTruthy()

    await act(async () => finishChange?.())

    expect(screen.getByText('beta')).toBeTruthy()
    expect(
      transport.requests.filter(
        (request) =>
          request.method === 'mcp.list' &&
          methods['mcp.list'].params.parse(request.params).projectPath === '/work/alpha',
      ),
    ).toHaveLength(1)
  })

  it('adds and removes project servers', async () => {
    Object.defineProperty(window, 'confirm', { configurable: true, value: () => true })
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
              scope: 'project',
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
      if (method === 'mcp.add' || method === 'mcp.reload' || method === 'mcp.remove') return {}
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
      expect(transport.requests).toContainEqual({
        method: 'mcp.add',
        params: {
          provider: 'codex',
          projectPath: '/work/project',
          server: {
            id: 'docs',
            enabled: true,
            transport: { type: 'http', url: 'https://docs.example.test/mcp' },
          },
        },
      })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => {
      expect(transport.requests).toContainEqual({
        method: 'mcp.remove',
        params: {
          provider: 'codex',
          projectPath: '/work/project',
          serverId: 'github',
        },
      })
    })
  })
})
