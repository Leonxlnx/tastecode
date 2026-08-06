// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Account, ProviderId } from '@harness/contracts'
import { resetInstalls } from '../provider-install.js'
import type { Transport } from '../transport.js'
import { Settings } from './Settings.js'

// The real component boots xterm, which needs a canvas happy-dom does not
// have. What these tests care about is *when* a terminal is offered, not how
// it paints.
vi.mock('./InstallTerminal.js', () => ({
  InstallTerminal: (props: { installKey: string }) => (
    <div data-testid="install-terminal" data-install-key={props.installKey} />
  ),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  resetInstalls()
})

describe('provider settings', () => {
  it('shows one account action per provider and runs that provider flow', async () => {
    const accounts: Record<string, Account> = {
      codex: { signedIn: true, plan: 'pro' },
      'claude-code': { signedIn: true, plan: 'pro' },
      cursor: { signedIn: false },
    }
    const transport = {
      request: vi.fn(async (method: string, params: { provider?: ProviderId }) => {
        if (method === 'auth.status') return accounts[params.provider ?? '']
        if (method === 'auth.startLogin') {
          return { loginId: 'login-1', authUrl: 'https://auth.example.test/' }
        }
        if (method === 'auth.signOut') return {}
        if (method === 'providers.install') return { terminalId: 'term-install-1' }
        throw new Error(`unexpected ${method}`)
      }),
      on: vi.fn(() => () => {}),
    } as unknown as Transport
    const onAccountChange = vi.fn()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)

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
          { id: 'cursor', displayName: 'Cursor', installed: true, auth: 'unauthenticated' },
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
    expect(screen.queryByText('Gemini CLI')).toBeNull()
    expect(screen.getByText('Qwen Code')).toBeTruthy()
    expect(screen.getByText('Kimi CLI')).toBeTruthy()

    const claudeRow = screen.getByText('Claude Code').closest<HTMLElement>('.settings__row')
    const cursorRow = screen.getByText('Cursor').closest<HTMLElement>('.settings__row')
    if (!claudeRow || !cursorRow) throw new Error('provider row missing')
    fireEvent.click(within(claudeRow).getByRole('button', { name: 'Sign out' }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('auth.signOut', {
        provider: 'claude-code',
      }),
    )

    fireEvent.click(within(cursorRow).getByRole('button', { name: 'Sign in' }))
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('auth.startLogin', { provider: 'cursor' })
      expect(open).toHaveBeenCalledWith(
        'https://auth.example.test/',
        '_blank',
        'noopener,noreferrer',
      )
    })

    fireEvent.click(screen.getByRole('button', { name: 'Connect another plan or API' }))
    fireEvent.click(screen.getByRole('button', { name: 'Provider, OpenAI API' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Anthropic API' }))
    expect(screen.getByRole('button', { name: 'Provider, Anthropic API' })).toBeTruthy()
    expect(screen.getByDisplayValue('https://api.anthropic.com/v1')).toBeTruthy()

    const qwenRow = screen.getByText('Qwen Code').closest<HTMLElement>('.settings__row')
    if (!qwenRow) throw new Error('Qwen provider row missing')
    fireEvent.click(within(qwenRow).getByRole('button', { name: 'Install' }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('providers.install', {
        provider: 'acp',
        agent: 'qwen',
        columns: 100,
        rows: 30,
      }),
    )
    expect(open).not.toHaveBeenCalledWith(
      'https://example.test/gemini',
      '_blank',
      'noopener,noreferrer',
    )
    await waitFor(() =>
      expect(within(qwenRow).getByRole('button', { name: 'Installing…' })).toBeTruthy(),
    )
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
            id: 'opencode',
            displayName: 'OpenCode',
            installed: true,
            auth: 'unknown',
            setup: {
              installUrl: 'https://example.test/opencode',
              installCommand: 'npm install -g opencode-ai',
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

    const opencodeRow = screen.getByText('OpenCode').closest<HTMLElement>('.settings__row')
    if (!opencodeRow) throw new Error('OpenCode row missing')
    fireEvent.click(within(opencodeRow).getByRole('button', { name: 'Sign in' }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('providers.launch', {
        provider: 'opencode',
        columns: 320,
        rows: 30,
      }),
    )
    expect(open).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('install-terminal')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Hide terminal' })).toBeTruthy()

    const emit = (channel: string, data: unknown) => {
      for (const listener of channels.get(channel) ?? []) listener(data)
    }
    emit('terminal.exit', { terminalId: 'term-login-3', exitCode: 0 })
    await waitFor(() => expect(screen.queryByTestId('install-terminal')).toBeNull())
    expect(within(opencodeRow).getByRole('button', { name: 'Sign in' })).toBeTruthy()

    const kimiRow = screen.getByText('Kimi CLI').closest<HTMLElement>('.settings__row')
    if (!kimiRow) throw new Error('Kimi row missing')
    // An impaired agent leads with the vendor's story, not a generic note —
    // but sign-in stays offered for the accounts that still work.
    expect(within(kimiRow).getByText('Vendor ended individual sign-in.')).toBeTruthy()
    fireEvent.click(within(kimiRow).getByRole('button', { name: 'Sign in' }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('providers.launch', {
        provider: 'acp',
        agent: 'kimi',
        columns: 320,
        rows: 30,
      }),
    )
    emit('terminal.exit', { terminalId: 'term-login-3', exitCode: 0 })
    await waitFor(() => expect(onConnectionsChanged).toHaveBeenCalled())
    expect(open).not.toHaveBeenCalled()
  })
})
