// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Account, ProviderId } from '@harness/contracts'
import { resetInstalls } from '../provider-install.js'
import type { Transport } from '../transport.js'
import { Settings } from './Settings.js'

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
    expect(screen.getByText('Gemini CLI')).toBeTruthy()
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

    const geminiRow = screen.getByText('Gemini CLI').closest<HTMLElement>('.settings__row')
    if (!geminiRow) throw new Error('Gemini provider row missing')
    fireEvent.click(within(geminiRow).getByRole('button', { name: 'Install' }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('providers.install', {
        provider: 'acp',
        agent: 'gemini',
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
      expect(within(geminiRow).getByRole('button', { name: 'Installing…' })).toBeTruthy(),
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
        showMacOSFontSmoothing={false}
        macOSFontSmoothing={true}
        onMacOSFontSmoothingChange={() => {}}
        onAccountChange={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />,
    )

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
  })
})
