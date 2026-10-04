// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RendererErrorBoundary } from '../RendererErrorBoundary.js'
import { resetInstalls } from '../provider-install.js'
import { TestTransport } from '../test-transport.js'
import { ProviderSettings } from './Settings.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  resetInstalls()
})

function renderProviders(transport: TestTransport) {
  const onAccountChange = vi.fn()
  render(
    <RendererErrorBoundary>
      <ProviderSettings
        provider="grok"
        account={undefined}
        providerStatuses={[
          {
            id: 'grok',
            displayName: 'Grok',
            installed: true,
            auth: 'unknown',
            setup: { installUrl: 'https://example.test/grok', login: 'provider' },
          },
        ]}
        transport={transport}
        onConnectionsChanged={() => {}}
        onAccountChange={onAccountChange}
      />
    </RendererErrorBoundary>,
  )
  return onAccountChange
}

describe('Settings with unavailable account email storage', () => {
  it.each([undefined, 'current@example.test'])(
    'still shows the signed-in account when a cache read fails (email: %s)',
    async (email) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
        throw new DOMException('Storage is unavailable', 'SecurityError')
      })
      const transport = new TestTransport((method) => {
        if (method === 'providers.updates') return { updates: [] }
        if (method === 'auth.status') return { signedIn: true, email }
        throw new Error(`unexpected ${method}`)
      })

      renderProviders(transport)

      expect(await screen.findByRole('button', { name: 'Sign out' })).toBeTruthy()
      expect(screen.getByText(email ?? 'Signed in')).toBeTruthy()
      expect(screen.queryByText('TasteCode couldn’t display this window')).toBeNull()
    },
  )

  it('finishes CLI sign-in when the email cache is full', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const saveEmail = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage is full', 'QuotaExceededError')
    })
    let signedIn = false
    const transport = new TestTransport((method) => {
      if (method === 'providers.updates') return { updates: [] }
      if (method === 'auth.status') return { signedIn }
      if (method === 'providers.launch') return { terminalId: 'storage-login' }
      throw new Error(`unexpected ${method}`)
    })
    const onAccountChange = renderProviders(transport)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    await screen.findByRole('button', { name: 'Cancel sign-in' })
    await act(async () => {
      transport.emit('terminal.output', {
        terminalId: 'storage-login',
        data: 'Signed in as user@example.test\r\n',
      })
    })
    expect(saveEmail).toHaveBeenCalledWith('harness.providerEmail.grok', 'user@example.test')
    signedIn = true
    await act(async () => {
      transport.emit('terminal.exit', { terminalId: 'storage-login', exitCode: 0 })
    })

    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeTruthy()
    expect(onAccountChange).toHaveBeenCalledWith('grok', { signedIn: true })
    expect(screen.queryByText('TasteCode couldn’t display this window')).toBeNull()
  })

  it('shows a successful sign-out even when the cached email cannot be removed', async () => {
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
      throw new DOMException('Storage is unavailable', 'SecurityError')
    })
    const transport = new TestTransport((method) => {
      if (method === 'providers.updates') return { updates: [] }
      if (method === 'auth.status') return { signedIn: true }
      if (method === 'auth.signOut') return {}
      throw new Error(`unexpected ${method}`)
    })
    const onAccountChange = renderProviders(transport)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(onAccountChange).toHaveBeenCalledWith('grok', { signedIn: false }))
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
