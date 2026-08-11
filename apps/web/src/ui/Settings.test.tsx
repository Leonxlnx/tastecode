// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Account, ConnectionsStatus, ProviderId, ResultOf } from '@harness/contracts'
import { customModelChoice, type ModelChoice } from '../model-catalog.js'
import { MODEL_PICKER_LAYOUT_KEY, writeModelPickerLayout } from '../model-picker-layout.js'
import { resetInstalls } from '../provider-install.js'
import type { Transport } from '../transport.js'
import { formatDeviceNote, Settings } from './Settings.js'

// The real component boots xterm, which needs a canvas happy-dom does not
// have. What these tests care about is *when* a terminal is offered, not how
// it paints.
vi.mock('./InstallTerminal.js', () => ({
  InstallTerminal: (props: { installKey: string }) => (
    <div data-testid="install-terminal" data-install-key={props.installKey} />
  ),
}))

function renderAppearanceSettings() {
  const transport = {
    request: vi.fn(),
    on: vi.fn(() => () => {}),
  } as unknown as Transport

  return render(
    <Settings
      provider="codex"
      providerName="Codex"
      transport={transport}
      projectPath={undefined}
      projectName={undefined}
      account={undefined}
      providerStatuses={[]}
      acpAgents={[]}
      modelConnections={[]}
      models={[]}
      hiddenModels={new Set()}
      onModelVisibilityChange={() => {}}
      providers={[{ id: 'codex', name: 'Codex' }]}
      onCustomModelAdd={() => {}}
      onCustomModelRemove={() => {}}
      onConnectionsChanged={() => {}}
      projectCount={0}
      sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
      onSidebarSettingsChange={() => {}}
      themePreference="system"
      onThemePreferenceChange={() => {}}
      fontPreference="geist"
      onFontPreferenceChange={() => {}}
      accentPreference="neutral"
      onAccentPreferenceChange={() => {}}
      backdropPreference="default"
      onBackdropPreferenceChange={() => {}}
      sidebarGlass={0}
      onSidebarGlassChange={() => {}}
      showMacOSFontSmoothing={false}
      macOSFontSmoothing={true}
      onMacOSFontSmoothingChange={() => {}}
      onAccountChange={() => {}}
      initialSection="appearance"
      onReset={() => {}}
      onClose={() => {}}
    />,
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetInstalls()
  writeModelPickerLayout('list')
  localStorage.removeItem(MODEL_PICKER_LAYOUT_KEY)
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('model picker layout setting', () => {
  it('reflects changes from the shared layout preference', () => {
    renderAppearanceSettings()
    const toggle = screen.getByRole('switch', { name: 'Provider rail layout' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    act(() => writeModelPickerLayout('rail'))

    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function connectionsStatus(enabled: boolean): ConnectionsStatus {
  return {
    enabled,
    serverName: 'Studio Mac',
    port: 4312,
    addresses: [],
    devices: [],
    webUrls: [],
  }
}

function mobileTransport(
  status: ConnectionsStatus,
  request?: (method: string) => unknown,
): Transport {
  return {
    request: vi.fn((method: string) => {
      if (method === 'connections.status') return Promise.resolve(status)
      if (request) return request(method)
      throw new Error(`unexpected ${method}`)
    }),
    on: vi.fn(() => () => {}),
  } as unknown as Transport
}

function mobileAccessSettings(transport: Transport) {
  return (
    <Settings
      provider="codex"
      providerName="Codex"
      transport={transport}
      projectPath={undefined}
      projectName={undefined}
      account={undefined}
      providerStatuses={[]}
      acpAgents={[]}
      modelConnections={[]}
      models={[]}
      hiddenModels={new Set()}
      onModelVisibilityChange={() => {}}
      providers={[{ id: 'codex', name: 'Codex' }]}
      onCustomModelAdd={() => {}}
      onCustomModelRemove={() => {}}
      onConnectionsChanged={() => {}}
      projectCount={0}
      sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
      onSidebarSettingsChange={() => {}}
      themePreference="system"
      onThemePreferenceChange={() => {}}
      fontPreference="geist"
      onFontPreferenceChange={() => {}}
      accentPreference="neutral"
      onAccentPreferenceChange={() => {}}
      backdropPreference="default"
      onBackdropPreferenceChange={() => {}}
      sidebarGlass={0}
      onSidebarGlassChange={() => {}}
      showMacOSFontSmoothing={false}
      macOSFontSmoothing={true}
      onMacOSFontSmoothingChange={() => {}}
      onAccountChange={() => {}}
      initialSection="mobile"
      onReset={() => {}}
      onClose={() => {}}
    />
  )
}

function renderMobileAccess(transport: Transport) {
  return render(mobileAccessSettings(transport))
}

describe('paired device timestamps', () => {
  it.each([
    [0, 'Seen just now'],
    [37 * 60_000, 'Seen 37m ago'],
    [3 * 60 * 60_000, 'Seen 3h ago'],
    [2_272 * 60_000, 'Seen 1d ago'],
  ])('formats an age of %i milliseconds', (age, expected) => {
    const now = Date.now()
    expect(formatDeviceNote(now - age, now)).toBe(expected)
  })
})

describe('model settings', () => {
  it('filters each provider locally while its master switch still controls every model', () => {
    const models: ModelChoice[] = [
      {
        key: 'opencode:ling',
        provider: 'opencode',
        sourceName: 'OpenCode',
        mark: 'opencode',
        model: {
          id: 'zen/ling-3.0-tiny',
          displayName: 'OpenCode Zen · Ling-3.0-tiny Free',
          description: '',
          isDefault: false,
          reasoningEfforts: [],
          serviceTiers: [],
        },
      },
      {
        key: 'opencode:qwen',
        provider: 'opencode',
        sourceName: 'OpenCode',
        mark: 'opencode',
        model: {
          id: 'go/qwen3.8-max',
          displayName: 'OpenCode Go · Qwen3.8 Max',
          description: '',
          isDefault: false,
          reasoningEfforts: [],
          serviceTiers: [],
        },
      },
    ]
    const onModelVisibilityChange = vi.fn()
    const transport = {
      request: vi.fn(),
      on: vi.fn(() => () => {}),
    } as unknown as Transport

    render(
      <Settings
        provider="codex"
        providerName="Codex"
        transport={transport}
        projectPath={undefined}
        projectName={undefined}
        account={undefined}
        providerStatuses={[]}
        acpAgents={[]}
        modelConnections={[]}
        models={models}
        hiddenModels={new Set(['opencode:ling'])}
        onModelVisibilityChange={onModelVisibilityChange}
        providers={[
          { id: 'codex', name: 'Codex' },
          { id: 'opencode', name: 'OpenCode' },
        ]}
        onCustomModelAdd={() => {}}
        onCustomModelRemove={() => {}}
        onConnectionsChanged={() => {}}
        projectCount={0}
        sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
        onSidebarSettingsChange={() => {}}
        themePreference="system"
        onThemePreferenceChange={() => {}}
        fontPreference="geist"
        onFontPreferenceChange={() => {}}
        accentPreference="neutral"
        onAccentPreferenceChange={() => {}}
        backdropPreference="default"
        onBackdropPreferenceChange={() => {}}
        sidebarGlass={0}
        onSidebarGlassChange={() => {}}
        showMacOSFontSmoothing={false}
        macOSFontSmoothing={true}
        onMacOSFontSmoothingChange={() => {}}
        onAccountChange={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />,
    )

    const categories = screen.getByRole('navigation', { name: 'Settings categories' })
    expect(within(categories).getAllByRole('button')[0]?.textContent).toBe('Profile')

    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    const search = screen.getByRole('searchbox', { name: 'Search OpenCode models' })
    fireEvent.change(search, { target: { value: 'qwen 3.8' } })

    expect(screen.queryByText('OpenCode Zen · Ling-3.0-tiny Free')).toBeNull()
    expect(screen.getByText('OpenCode Go · Qwen3.8 Max')).toBeTruthy()

    fireEvent.click(screen.getByRole('switch', { name: 'Show any models from OpenCode' }))
    expect(onModelVisibilityChange).toHaveBeenCalledTimes(2)
    expect(onModelVisibilityChange).toHaveBeenNthCalledWith(1, 'opencode:ling', false)
    expect(onModelVisibilityChange).toHaveBeenNthCalledWith(2, 'opencode:qwen', false)

    fireEvent.click(screen.getByRole('button', { name: 'Clear Search OpenCode models' }))
    expect(screen.getByText('OpenCode Zen · Ling-3.0-tiny Free')).toBeTruthy()
  })

  it('lists custom models in their own section and reports add/remove', () => {
    const custom = customModelChoice(
      { provider: 'codex', modelId: 'qwen-max', displayName: 'Qwen Max' },
      'Codex',
      'openai',
    )
    const onCustomModelAdd = vi.fn()
    const onCustomModelRemove = vi.fn()
    const transport = {
      request: vi.fn(),
      on: vi.fn(() => () => {}),
    } as unknown as Transport

    render(
      <Settings
        provider="codex"
        providerName="Codex"
        transport={transport}
        projectPath={undefined}
        projectName={undefined}
        account={undefined}
        providerStatuses={[]}
        acpAgents={[]}
        modelConnections={[]}
        models={[custom]}
        hiddenModels={new Set()}
        onModelVisibilityChange={() => {}}
        providers={[{ id: 'codex', name: 'Codex' }]}
        onCustomModelAdd={onCustomModelAdd}
        onCustomModelRemove={onCustomModelRemove}
        onConnectionsChanged={() => {}}
        projectCount={0}
        sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
        onSidebarSettingsChange={() => {}}
        themePreference="system"
        onThemePreferenceChange={() => {}}
        fontPreference="geist"
        onFontPreferenceChange={() => {}}
        accentPreference="neutral"
        onAccentPreferenceChange={() => {}}
        backdropPreference="default"
        onBackdropPreferenceChange={() => {}}
        sidebarGlass={0}
        onSidebarGlassChange={() => {}}
        showMacOSFontSmoothing={false}
        macOSFontSmoothing={true}
        onMacOSFontSmoothingChange={() => {}}
        onAccountChange={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Models' }))

    const section = screen.getByRole('region', { name: 'Custom models' })
    expect(within(section).getByText('Qwen Max')).toBeTruthy()
    expect(within(section).getByText('qwen-max')).toBeTruthy()
    const row = within(section).getByText('Qwen Max').closest('li')
    if (!row) throw new Error('custom model row missing')
    expect(within(row).getByText('Codex')).toBeTruthy()

    // The custom entry does not leak into a provider visibility group.
    expect(screen.queryByRole('switch', { name: 'Show Qwen Max' })).toBeNull()

    fireEvent.click(within(section).getByRole('button', { name: 'Remove Qwen Max' }))
    expect(onCustomModelRemove).toHaveBeenCalledWith(custom.key)

    fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'deepseek-v3' } })
    fireEvent.change(screen.getByLabelText('Display name'), {
      target: { value: 'DeepSeek V3' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }))
    expect(onCustomModelAdd).toHaveBeenCalledWith({
      provider: 'codex',
      modelId: 'deepseek-v3',
      displayName: 'DeepSeek V3',
    })
  })

  it('adds a custom model from the bottom of a provider list', () => {
    const models: ModelChoice[] = [
      {
        key: 'opencode:ling',
        provider: 'opencode',
        sourceName: 'OpenCode',
        mark: 'opencode',
        model: {
          id: 'zen/ling-3.0-tiny',
          displayName: 'OpenCode Zen · Ling-3.0-tiny Free',
          description: '',
          isDefault: false,
          reasoningEfforts: [],
          serviceTiers: [],
        },
      },
    ]
    const onCustomModelAdd = vi.fn()
    const transport = {
      request: vi.fn(),
      on: vi.fn(() => () => {}),
    } as unknown as Transport

    render(
      <Settings
        provider="codex"
        providerName="Codex"
        transport={transport}
        projectPath={undefined}
        projectName={undefined}
        account={undefined}
        providerStatuses={[]}
        acpAgents={[]}
        modelConnections={[]}
        models={models}
        hiddenModels={new Set()}
        onModelVisibilityChange={() => {}}
        providers={[
          { id: 'codex', name: 'Codex' },
          { id: 'opencode', name: 'OpenCode' },
        ]}
        onCustomModelAdd={onCustomModelAdd}
        onCustomModelRemove={() => {}}
        onConnectionsChanged={() => {}}
        projectCount={0}
        sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
        onSidebarSettingsChange={() => {}}
        themePreference="system"
        onThemePreferenceChange={() => {}}
        fontPreference="geist"
        onFontPreferenceChange={() => {}}
        accentPreference="neutral"
        onAccentPreferenceChange={() => {}}
        backdropPreference="default"
        onBackdropPreferenceChange={() => {}}
        sidebarGlass={0}
        onSidebarGlassChange={() => {}}
        showMacOSFontSmoothing={false}
        macOSFontSmoothing={true}
        onMacOSFontSmoothingChange={() => {}}
        onAccountChange={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    const group = screen.getByRole('region', { name: 'OpenCode' })
    fireEvent.click(within(group).getByRole('button', { name: 'Add custom model' }))

    // Pinned to the group's engine: no provider select, id + name only.
    expect(within(group).queryByLabelText('Provider')).toBeNull()
    fireEvent.change(within(group).getByLabelText('Model id'), {
      target: { value: 'qwen-max' },
    })
    fireEvent.change(within(group).getByLabelText('Display name'), {
      target: { value: 'Qwen Max' },
    })
    fireEvent.click(within(group).getByRole('button', { name: 'Add model' }))

    expect(onCustomModelAdd).toHaveBeenCalledWith({
      provider: 'opencode',
      modelId: 'qwen-max',
      displayName: 'Qwen Max',
    })
  })
})

describe('mobile access settings', () => {
  it('starts a fresh status read when the transport changes', async () => {
    const staleStatus = deferred<ConnectionsStatus>()
    const previousTransport = {
      request: vi.fn((method: string) => {
        if (method === 'connections.status') return staleStatus.promise
        throw new Error(`unexpected ${method}`)
      }),
      on: vi.fn(() => () => {}),
    } as unknown as Transport
    const currentTransport = {
      request: vi.fn((method: string) => {
        if (method === 'connections.status') return Promise.resolve(connectionsStatus(false))
        throw new Error(`unexpected ${method}`)
      }),
      on: vi.fn(() => () => {}),
    } as unknown as Transport

    const view = renderMobileAccess(previousTransport)
    expect(previousTransport.request).toHaveBeenCalledWith('connections.status', {})

    view.rerender(mobileAccessSettings(currentTransport))
    await waitFor(() =>
      expect(currentTransport.request).toHaveBeenCalledWith('connections.status', {}),
    )
    expect(screen.getByText('Not accepting mobile connections')).toBeTruthy()

    await act(async () => {
      staleStatus.reject(new Error('previous transport closed'))
      await staleStatus.promise.catch(() => {})
    })

    expect(screen.getByText('Not accepting mobile connections')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores a pairing completion from a replaced transport', async () => {
    const stalePairing = deferred<ResultOf<'connections.startPairing'>>()
    const previousTransport = mobileTransport(connectionsStatus(false), (method) => {
      if (method === 'connections.startPairing') return stalePairing.promise
      throw new Error(`unexpected ${method}`)
    })
    const currentTransport = mobileTransport(connectionsStatus(false))

    const view = renderMobileAccess(previousTransport)
    await waitFor(() => expect(screen.getByText('Not accepting mobile connections')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Generate pairing code' }))
    await waitFor(() =>
      expect(previousTransport.request).toHaveBeenCalledWith('connections.startPairing', {}),
    )

    view.rerender(mobileAccessSettings(currentTransport))
    await waitFor(() =>
      expect(currentTransport.request).toHaveBeenCalledWith('connections.status', {}),
    )
    expect(
      screen.getByRole('button', { name: 'Generate pairing code' }).getAttribute('disabled'),
    ).toBeNull()

    await act(async () => {
      stalePairing.resolve({
        ...connectionsStatus(true),
        pairingUri: 'harness://pair?payload=stale-ticket',
        expiresAt: Date.now() + 300_000,
      })
      await stalePairing.promise
    })

    expect(screen.getByText('Not accepting mobile connections')).toBeTruthy()
    expect(screen.queryByText('Available to paired devices')).toBeNull()
  })

  it('ignores a mutation error from a replaced transport', async () => {
    const staleStop = deferred<Record<string, never>>()
    const previousTransport = mobileTransport(connectionsStatus(true), (method) => {
      if (method === 'connections.stop') return staleStop.promise
      throw new Error(`unexpected ${method}`)
    })
    const currentTransport = mobileTransport(connectionsStatus(false))

    const view = renderMobileAccess(previousTransport)
    await waitFor(() => expect(screen.getByText('Available to paired devices')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Stop accepting connections' }))
    await waitFor(() =>
      expect(previousTransport.request).toHaveBeenCalledWith('connections.stop', {}),
    )

    view.rerender(mobileAccessSettings(currentTransport))
    await waitFor(() => expect(screen.getByText('Not accepting mobile connections')).toBeTruthy())

    await act(async () => {
      staleStop.reject(new Error('previous transport closed'))
      await staleStop.promise.catch(() => {})
    })

    expect(screen.getByText('Not accepting mobile connections')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not refresh through a replaced transport after disconnecting a device', async () => {
    const staleRevoke = deferred<Record<string, never>>()
    const previousStatus = {
      ...connectionsStatus(true),
      devices: [
        {
          id: 'device-1',
          name: 'Studio iPhone',
          createdAt: Date.now() - 60_000,
          lastSeenAt: Date.now(),
        },
      ],
    }
    const previousTransport = mobileTransport(previousStatus, (method) => {
      if (method === 'connections.revoke') return staleRevoke.promise
      throw new Error(`unexpected ${method}`)
    })
    const currentTransport = mobileTransport(connectionsStatus(false))

    const view = renderMobileAccess(previousTransport)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await waitFor(() =>
      expect(previousTransport.request).toHaveBeenCalledWith('connections.revoke', {
        deviceId: 'device-1',
      }),
    )

    view.rerender(mobileAccessSettings(currentTransport))
    await waitFor(() => expect(screen.getByText('Not accepting mobile connections')).toBeTruthy())

    await act(async () => {
      staleRevoke.resolve({})
      await staleRevoke.promise
    })

    expect(previousTransport.request).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Not accepting mobile connections')).toBeTruthy()
  })

  it('deduplicates interval ticks while a slow status read is pending', async () => {
    vi.useFakeTimers()
    const slowStatus = deferred<ConnectionsStatus>()
    let statusRequests = 0
    const transport = {
      request: vi.fn((method: string) => {
        if (method === 'connections.status') {
          statusRequests += 1
          return slowStatus.promise
        }
        throw new Error(`unexpected ${method}`)
      }),
      on: vi.fn(() => () => {}),
    } as unknown as Transport

    renderMobileAccess(transport)
    expect(statusRequests).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000)
    })
    expect(statusRequests).toBe(1)

    await act(async () => {
      slowStatus.resolve(connectionsStatus(true))
      await slowStatus.promise
    })
    expect(screen.getByText('Available to paired devices')).toBeTruthy()
  })

  it('keeps a pairing offer newer than an in-flight status response', async () => {
    const staleStatus = deferred<ConnectionsStatus>()
    const offer = {
      ...connectionsStatus(true),
      pairingUri: 'harness://pair?payload=new-ticket',
      expiresAt: Date.now() + 300_000,
    }
    const transport = {
      request: vi.fn((method: string) => {
        if (method === 'connections.status') return staleStatus.promise
        if (method === 'connections.startPairing') return Promise.resolve(offer)
        throw new Error(`unexpected ${method}`)
      }),
      on: vi.fn(() => () => {}),
    } as unknown as Transport

    renderMobileAccess(transport)
    await waitFor(() => expect(transport.request).toHaveBeenCalledWith('connections.status', {}))

    fireEvent.click(screen.getByRole('button', { name: 'Generate pairing code' }))
    await waitFor(() => expect(screen.getByText('Available to paired devices')).toBeTruthy())

    await act(async () => {
      staleStatus.resolve(connectionsStatus(false))
      await staleStatus.promise
    })

    expect(screen.getByText('Available to paired devices')).toBeTruthy()
    expect(screen.queryByText('Not accepting mobile connections')).toBeNull()
  })

  it('runs one authoritative refresh after stop while an older poll is pending', async () => {
    vi.useFakeTimers()
    const stalePoll = deferred<ConnectionsStatus>()
    const postStopStatus = deferred<ConnectionsStatus>()
    let statusRequests = 0
    const transport = {
      request: vi.fn((method: string) => {
        if (method === 'connections.status') {
          statusRequests += 1
          if (statusRequests === 1) return Promise.resolve(connectionsStatus(true))
          if (statusRequests === 2) return stalePoll.promise
          if (statusRequests === 3) return postStopStatus.promise
          return Promise.reject(new Error('later poll failed'))
        }
        if (method === 'connections.stop') return Promise.resolve({})
        throw new Error(`unexpected ${method}`)
      }),
      on: vi.fn(() => () => {}),
    } as unknown as Transport

    renderMobileAccess(transport)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText('Available to paired devices')).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(statusRequests).toBe(2)

    fireEvent.click(screen.getByRole('button', { name: 'Stop accepting connections' }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(statusRequests).toBe(3)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(statusRequests).toBe(3)

    await act(async () => {
      postStopStatus.resolve(connectionsStatus(false))
      await postStopStatus.promise
      stalePoll.resolve(connectionsStatus(true))
      await stalePoll.promise
    })

    expect(screen.getByText('Not accepting mobile connections')).toBeTruthy()
    expect(screen.queryByText('Available to paired devices')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('provider settings', () => {
  it('shows one account action per provider and runs that provider flow', async () => {
    const accounts: Record<string, Account> = {
      codex: { signedIn: true, email: 'private@example.com', plan: 'pro' },
      'claude-code': { signedIn: true, plan: 'pro' },
      grok: { signedIn: false },
    }
    const transport = {
      request: vi.fn(async (method: string, params: { provider?: ProviderId; agent?: string }) => {
        if (method === 'auth.status') {
          // The Kimi CLI on this machine is already logged in; Qwen is not.
          if (params.agent) return { signedIn: params.agent === 'kimi' }
          return accounts[params.provider ?? '']
        }
        if (method === 'auth.startLogin') {
          return { loginId: 'login-1', authUrl: 'https://auth.example.test/' }
        }
        if (method === 'auth.signOut') return {}
        if (method === 'providers.install') return { terminalId: 'term-install-1' }
        if (method === 'connections.status') {
          return {
            enabled: true,
            serverName: 'Studio Mac',
            port: 4312,
            addresses: [
              { kind: 'tailscale', label: 'Tailscale 100.101.2.3', url: 'ws://100.101.2.3:4312' },
            ],
            devices: [
              {
                id: 'phone-1',
                name: 'Blueemi’s iPhone',
                createdAt: Date.now() - 60_000,
                lastSeenAt: Date.now(),
              },
            ],
            webUrls: ['http://100.101.2.3:4312/#access_token=test-web-token'],
          }
        }
        if (method === 'connections.revoke') return {}
        if (method === 'connections.startPairing') {
          return {
            enabled: true,
            serverName: 'Studio Mac',
            port: 4312,
            addresses: [
              { kind: 'tailscale', label: 'Tailscale 100.101.2.3', url: 'ws://100.101.2.3:4312' },
            ],
            devices: [],
            webUrls: ['http://100.101.2.3:4312/#access_token=test-web-token'],
            pairingUri: 'harness://pair?payload=test-ticket',
            expiresAt: Date.now() + 300_000,
          }
        }
        throw new Error(`unexpected ${method}`)
      }),
      on: vi.fn(() => () => {}),
    } as unknown as Transport
    const onAccountChange = vi.fn()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(
      <Settings
        provider="codex"
        providerName="Codex"
        transport={transport}
        projectPath={undefined}
        projectName={undefined}
        account={accounts.codex}
        providerStatuses={[
          { id: 'codex', displayName: 'Codex', installed: true, auth: 'authenticated' },
          {
            id: 'claude-code',
            displayName: 'Claude Code',
            installed: true,
            auth: 'authenticated',
          },
          {
            id: 'grok',
            displayName: 'Grok',
            installed: true,
            auth: 'unauthenticated',
            setup: { installUrl: 'https://example.test/grok', login: 'provider' },
          },
        ]}
        acpAgents={[
          // A stale server may still list retired gemini; the row must not render.
          {
            id: 'gemini',
            name: 'Gemini CLI',
            installed: false,
            verified: true,
            setup: {
              installUrl: 'https://example.test/gemini',
              installCommand: 'npm install -g @google/gemini-cli',
              login: 'provider',
            },
          },
          {
            id: 'qwen',
            name: 'Qwen Code',
            installed: false,
            verified: false,
            setup: {
              installUrl: 'https://example.test/qwen',
              installCommand: 'npm install -g @qwen-code/qwen-code',
              login: 'provider',
            },
          },
          {
            id: 'kimi',
            name: 'Kimi CLI',
            installed: true,
            verified: true,
            setup: {
              installUrl: 'https://example.test/kimi',
              login: 'provider',
            },
          },
        ]}
        modelConnections={[]}
        models={[]}
        hiddenModels={new Set()}
        onModelVisibilityChange={() => {}}
        providers={[{ id: 'codex', name: 'Codex' }]}
        onCustomModelAdd={() => {}}
        onCustomModelRemove={() => {}}
        onConnectionsChanged={() => {}}
        projectCount={0}
        sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
        onSidebarSettingsChange={() => {}}
        themePreference="system"
        onThemePreferenceChange={() => {}}
        fontPreference="geist"
        onFontPreferenceChange={() => {}}
        accentPreference="neutral"
        onAccentPreferenceChange={() => {}}
        backdropPreference="default"
        onBackdropPreferenceChange={() => {}}
        sidebarGlass={0}
        onSidebarGlassChange={() => {}}
        showMacOSFontSmoothing={false}
        macOSFontSmoothing={true}
        onMacOSFontSmoothingChange={() => {}}
        onAccountChange={onAccountChange}
        onReset={() => {}}
        onClose={() => {}}
      />,
    )

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Sign out' })).toHaveLength(2))
    expect(screen.getAllByText('Codex')).toHaveLength(1)

    const codexRow = screen.getByText('Codex').closest<HTMLElement>('.settings__row')
    if (!codexRow) throw new Error('Codex provider row missing')
    expect(within(codexRow).getByText('p******@example.com')).toBeTruthy()
    const email = within(codexRow).getByText('private@example.com')
    expect(email.getAttribute('aria-hidden')).toBe('true')
    const eye = within(codexRow).getByLabelText('Show account email')
    fireEvent.click(eye)
    expect(email.getAttribute('aria-hidden')).toBe('true')
    fireEvent.mouseEnter(eye)
    expect(email.getAttribute('aria-hidden')).toBe('false')
    expect(within(codexRow).getByLabelText('Hide account email')).toBeTruthy()
    fireEvent.mouseLeave(eye)
    expect(email.getAttribute('aria-hidden')).toBe('true')

    // Beta scope: agent rows and the API-connection form stay out entirely,
    // even when the server still reports agents.
    expect(screen.queryByText('Gemini CLI')).toBeNull()
    expect(screen.queryByText('Qwen Code')).toBeNull()
    expect(screen.queryByText('Kimi CLI')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Connect another plan or API' })).toBeNull()

    const claudeRow = screen.getByText('Claude Code').closest<HTMLElement>('.settings__row')
    const grokRow = screen.getByText('Grok').closest<HTMLElement>('.settings__row')
    if (!claudeRow || !grokRow) throw new Error('provider row missing')
    fireEvent.click(within(claudeRow).getByRole('button', { name: 'Sign out' }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('auth.signOut', {
        provider: 'claude-code',
      }),
    )

    // Grok signs in through its own CLI: the row offers the guided card flow.
    expect(within(grokRow).getByRole('button', { name: 'Sign in' })).toBeTruthy()
    expect(open).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Mobile access' }))
    await waitFor(() => expect(transport.request).toHaveBeenCalledWith('connections.status', {}))

    // The full web app for a phone is the primary link, with copy and a QR.
    const webUrl = 'http://100.101.2.3:4312/#access_token=test-web-token'
    const webRow = screen.getByText(webUrl).closest<HTMLElement>('.settings__console-url')
    if (!webRow) throw new Error('web app URL row missing')
    expect(webRow).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('img', { name: 'App QR code' })).toBeTruthy())
    fireEvent.click(within(webRow).getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(webUrl))
    expect(within(webRow).getByRole('button', { name: 'Copied' })).toBeTruthy()

    const phoneRow = screen.getByText('Blueemi’s iPhone').closest<HTMLElement>('.settings__row')
    if (!phoneRow) throw new Error('paired phone row missing')
    fireEvent.click(within(phoneRow).getByRole('button', { name: 'Disconnect' }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('connections.revoke', {
        deviceId: 'phone-1',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Generate pairing code' }))
    await waitFor(() => expect(screen.getByRole('img', { name: 'Pairing QR code' })).toBeTruthy())
    expect(screen.getByText('Tailscale 100.101.2.3')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy pairing link' }))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('harness://pair?payload=test-ticket'),
    )
    const pairingPanel = document.querySelector('.settings__pairing')
    if (!pairingPanel) throw new Error('pairing panel missing')
    expect(within(pairingPanel as HTMLElement).getByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it('runs installs in the background and refreshes once the install exits cleanly', async () => {
    const channels = new Map<string, Set<(data: unknown) => void>>()
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === 'providers.install') return { terminalId: 'term-install-2' }
        if (method === 'auth.status') return { signedIn: false }
        throw new Error(`unexpected ${method}`)
      }),
      on: vi.fn((channel: string, listener: (data: unknown) => void) => {
        const listeners = channels.get(channel) ?? new Set()
        listeners.add(listener)
        channels.set(channel, listeners)
        return () => listeners.delete(listener)
      }),
    } as unknown as Transport
    const onConnectionsChanged = vi.fn()

    const settingsFor = (onChanged: () => void) => (
      <Settings
        provider="codex"
        providerName="Codex"
        transport={transport}
        projectPath={undefined}
        projectName={undefined}
        account={undefined}
        providerStatuses={[
          {
            id: 'opencode',
            displayName: 'OpenCode',
            installed: false,
            auth: 'unknown',
            setup: {
              installUrl: 'https://example.test/opencode',
              installCommand: 'npm install -g opencode-ai',
              login: 'provider',
            },
          },
        ]}
        acpAgents={[]}
        modelConnections={[]}
        models={[]}
        hiddenModels={new Set()}
        onModelVisibilityChange={() => {}}
        providers={[{ id: 'codex', name: 'Codex' }]}
        onCustomModelAdd={() => {}}
        onCustomModelRemove={() => {}}
        onConnectionsChanged={onChanged}
        projectCount={0}
        sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
        onSidebarSettingsChange={() => {}}
        themePreference="system"
        onThemePreferenceChange={() => {}}
        fontPreference="geist"
        onFontPreferenceChange={() => {}}
        accentPreference="neutral"
        onAccentPreferenceChange={() => {}}
        backdropPreference="default"
        onBackdropPreferenceChange={() => {}}
        sidebarGlass={0}
        onSidebarGlassChange={() => {}}
        showMacOSFontSmoothing={false}
        macOSFontSmoothing={true}
        onMacOSFontSmoothingChange={() => {}}
        onAccountChange={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    const view = render(settingsFor(onConnectionsChanged))

    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('providers.install', {
        provider: 'opencode',
        columns: 100,
        rows: 30,
      }),
    )

    const emit = (channel: string, data: unknown) => {
      for (const listener of channels.get(channel) ?? []) listener(data)
    }
    emit('terminal.output', { terminalId: 'term-install-2', data: 'added 12 packages\r\n' })
    await waitFor(() => expect(screen.getByText('added 12 packages')).toBeTruthy())

    emit('terminal.exit', { terminalId: 'term-install-2', exitCode: 0 })
    await waitFor(() => expect(onConnectionsChanged).toHaveBeenCalled())

    // The succeeded row persists until the provider list confirms the
    // install, and parents may hand the callback a fresh identity on every
    // render. That combination once produced an endless refresh loop that
    // spawned an `opencode serve` process per iteration — the notification
    // must stay one-shot no matter how often the row re-renders.
    view.rerender(settingsFor(() => onConnectionsChanged()))
    view.rerender(settingsFor(() => onConnectionsChanged()))
    expect(screen.getByRole('button', { name: 'Installed' })).toBeTruthy()
    expect(onConnectionsChanged).toHaveBeenCalledTimes(1)
  })

  it('signs in to provider-CLI-managed logins in an in-app terminal, not a docs page', async () => {
    const channels = new Map<string, Set<(data: unknown) => void>>()
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === 'providers.launch') return { terminalId: 'term-login-3' }
        if (method === 'auth.status') return { signedIn: false }
        throw new Error(`unexpected ${method}`)
      }),
      on: vi.fn((channel: string, listener: (data: unknown) => void) => {
        const listeners = channels.get(channel) ?? new Set()
        listeners.add(listener)
        channels.set(channel, listeners)
        return () => listeners.delete(listener)
      }),
    } as unknown as Transport
    const onConnectionsChanged = vi.fn()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)

    render(
      <Settings
        provider="codex"
        providerName="Codex"
        transport={transport}
        projectPath={undefined}
        projectName={undefined}
        account={undefined}
        providerStatuses={[
          {
            id: 'grok',
            displayName: 'Grok',
            installed: true,
            auth: 'unknown',
            setup: {
              installUrl: 'https://example.test/grok',
              login: 'provider',
            },
          },
        ]}
        acpAgents={[
          {
            id: 'kimi',
            name: 'Kimi CLI',
            installed: true,
            verified: true,
            setup: {
              installUrl: 'https://example.test/kimi',
              login: 'provider',
            },
            problem: 'Vendor ended individual sign-in.',
          },
        ]}
        modelConnections={[]}
        models={[]}
        hiddenModels={new Set()}
        onModelVisibilityChange={() => {}}
        providers={[{ id: 'codex', name: 'Codex' }]}
        onCustomModelAdd={() => {}}
        onCustomModelRemove={() => {}}
        onConnectionsChanged={onConnectionsChanged}
        projectCount={0}
        sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
        onSidebarSettingsChange={() => {}}
        themePreference="system"
        onThemePreferenceChange={() => {}}
        fontPreference="geist"
        onFontPreferenceChange={() => {}}
        accentPreference="neutral"
        onAccentPreferenceChange={() => {}}
        backdropPreference="default"
        onBackdropPreferenceChange={() => {}}
        sidebarGlass={0}
        onSidebarGlassChange={() => {}}
        showMacOSFontSmoothing={false}
        macOSFontSmoothing={true}
        onMacOSFontSmoothingChange={() => {}}
        onAccountChange={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />,
    )

    const grokRow = screen.getByText('Grok').closest<HTMLElement>('.settings__row')
    if (!grokRow) throw new Error('Grok row missing')
    fireEvent.click(within(grokRow).getByRole('button', { name: 'Sign in' }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('providers.launch', {
        provider: 'grok',
        columns: 320,
        rows: 30,
      }),
    )
    expect(open).not.toHaveBeenCalled()
    // The guided card leads; the raw terminal waits behind Details.
    await waitFor(() => expect(screen.getByText('Starting the provider sign-in…')).toBeTruthy())
    expect(screen.queryByTestId('install-terminal')).toBeNull()

    const emit = (channel: string, data: unknown) => {
      for (const listener of channels.get(channel) ?? []) listener(data)
    }
    emit('terminal.output', {
      terminalId: 'term-login-3',
      data: 'Visit https://example.test/device then enter code: WDJB-MJHT \r\n',
    })
    // The OAuth link opens once by itself; the code becomes a copyable chip.
    await waitFor(() => expect(screen.getByText('WDJB-MJHT')).toBeTruthy())
    expect(open).toHaveBeenCalledWith(
      'https://example.test/device',
      '_blank',
      'noopener,noreferrer',
    )
    expect(screen.getByRole('button', { name: 'Open link again' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    await waitFor(() => expect(screen.getByTestId('install-terminal')).toBeTruthy())

    emit('terminal.exit', { terminalId: 'term-login-3', exitCode: 0 })
    await waitFor(() => expect(screen.queryByTestId('install-terminal')).toBeNull())
    expect(within(grokRow).getByRole('button', { name: 'Sign in' })).toBeTruthy()

    // Beta scope: agent rows never render, even when the server reports one.
    expect(screen.queryByText('Kimi CLI')).toBeNull()
    expect(open).toHaveBeenCalledTimes(1)
    expect(onConnectionsChanged).not.toHaveBeenCalled()
  })
})
