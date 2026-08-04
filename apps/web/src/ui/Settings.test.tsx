// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Account, ProviderId } from '@harness/contracts'
import type { Transport } from '../transport.js'
import { Settings } from './Settings.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
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
        if (method === 'connections.status') {
          return {
            enabled: false,
            serverName: 'Studio Mac',
            port: 4312,
            addresses: [],
            devices: [],
          }
        }
        if (method === 'connections.startPairing') {
          return {
            enabled: true,
            serverName: 'Studio Mac',
            port: 4312,
            addresses: [
              { kind: 'tailscale', label: 'Tailscale 100.101.2.3', url: 'ws://100.101.2.3:4312' },
            ],
            devices: [],
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
    fireEvent.click(within(geminiRow).getByRole('button', { name: 'Install first' }))
    expect(open).toHaveBeenCalledWith(
      'https://example.test/gemini',
      '_blank',
      'noopener,noreferrer',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Mobile access' }))
    await waitFor(() => expect(transport.request).toHaveBeenCalledWith('connections.status', {}))
    fireEvent.click(screen.getByRole('button', { name: 'Generate pairing code' }))
    await waitFor(() => expect(screen.getByRole('img', { name: 'Pairing QR code' })).toBeTruthy())
    expect(screen.getByText('Tailscale 100.101.2.3')).toBeTruthy()
  })
})
