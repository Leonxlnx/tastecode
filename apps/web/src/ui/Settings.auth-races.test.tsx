// @vitest-environment happy-dom
import { useCallback, useState } from 'react'
import type { Account, ProviderId, ProviderStatus } from '@harness/contracts'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TestTransport } from '../test-transport.js'
import { ProviderSettings } from './Settings.js'

afterEach(cleanup)

const statuses: ProviderStatus[] = [
  { id: 'codex', displayName: 'Codex', installed: true, auth: 'unknown' },
]
const account = { signedIn: true }
const onConnectionsChanged = () => undefined
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

describe('provider account revisions', () => {
  it('invalidates an account read started during sign-out when sign-out completes', async () => {
    const stale = deferred<Account>()
    const signOut = deferred<object>()
    let reads = 0
    const onAccountChange = vi.fn()
    const transport = new TestTransport((method) => {
      if (method === 'providers.updates') return { updates: [] }
      if (method === 'auth.status') return ++reads === 1 ? account : stale.promise
      if (method === 'auth.signOut') return signOut.promise
      throw new Error(`Unexpected ${method}`)
    })
    const props = {
      provider: 'codex' as const,
      account,
      providerStatuses: statuses,
      transport,
      onConnectionsChanged,
      onAccountChange,
    }
    const view = render(<ProviderSettings {...props} />)
    await act(async () => undefined)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    view.rerender(<ProviderSettings {...props} authRefreshRevision={1} />)
    expect(reads).toBe(2)
    await act(async () => signOut.resolve({}))
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
    onAccountChange.mockClear()
    await act(async () => stale.resolve({ signedIn: true, email: 'stale@example.com' }))
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
    expect(onAccountChange).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'reconciles a remounted provider row after sign-out (pending read: %s)',
    async (pendingRead) => {
      const signOut = deferred<object>()
      const stale = deferred<Account>()
      let reads = 0
      const transport = new TestTransport((method) => {
        if (method === 'providers.updates') return { updates: [] }
        if (method === 'auth.status') return ++reads > 1 && pendingRead ? stale.promise : account
        if (method === 'auth.signOut') return signOut.promise
        throw new Error(`Unexpected ${method}`)
      })
      function Host() {
        const [open, setOpen] = useState(true)
        const [currentAccount, setAccount] = useState<Account>(account)
        const onAccountChange = useCallback(
          (_provider: ProviderId, next: Account) => setAccount(next),
          [],
        )
        return (
          <>
            <button onClick={() => setOpen((current) => !current)}>Toggle providers</button>
            {open ? (
              <ProviderSettings
                provider="codex"
                account={currentAccount}
                providerStatuses={statuses}
                transport={transport}
                onConnectionsChanged={onConnectionsChanged}
                onAccountChange={onAccountChange}
              />
            ) : null}
          </>
        )
      }
      render(<Host />)
      await act(async () => undefined)
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
      fireEvent.click(screen.getByRole('button', { name: 'Toggle providers' }))
      fireEvent.click(screen.getByRole('button', { name: 'Toggle providers' }))
      await act(async () => undefined)
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
      await act(async () => signOut.resolve({}))
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
      await act(async () => stale.resolve(account))
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
    },
  )
})

describe('background account re-checks', () => {
  it('keeps a known sign-in when a re-check fails and marks the row until one succeeds', async () => {
    const known = { signedIn: true, email: 'person@example.test', plan: 'Pro' }
    let reads = 0
    const transport = new TestTransport((method) => {
      if (method === 'providers.updates') return { updates: [] }
      if (method === 'auth.status') {
        reads += 1
        return reads === 1
          ? Promise.reject(new Error('CLI did not respond within the time limit'))
          : known
      }
      throw new Error(`Unexpected ${method}`)
    })
    const props = {
      provider: 'codex' as const,
      account: known,
      providerStatuses: statuses,
      transport,
      onConnectionsChanged,
      onAccountChange: vi.fn(),
    }
    const view = render(<ProviderSettings {...props} />)
    await act(async () => undefined)
    expect(reads).toBe(1)
    expect(screen.queryByText('Account unavailable')).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
    expect(document.querySelector('.settings__account-plan')?.textContent).toContain('Pro')
    const issue = screen.getByRole('button', { name: 'Problem details' })
    fireEvent.focus(issue)
    expect(screen.getByRole('tooltip').textContent).toBe(
      'Could not refresh this account. CLI did not respond within the time limit',
    )
    view.rerender(<ProviderSettings {...props} authRefreshRevision={1} />)
    await act(async () => undefined)
    expect(reads).toBe(2)
    expect(screen.queryByRole('button', { name: 'Problem details' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
  })

  it("re-checks the provider row for its own sign-in, not another account's", async () => {
    let reads = 0
    const transport = new TestTransport((method) => {
      if (method === 'providers.updates') return { updates: [] }
      if (method === 'auth.status') {
        reads += 1
        return account
      }
      throw new Error(`Unexpected ${method}`)
    })
    render(
      <ProviderSettings
        provider="codex"
        account={account}
        providerStatuses={statuses}
        transport={transport}
        onConnectionsChanged={onConnectionsChanged}
        onAccountChange={vi.fn()}
      />,
    )
    await act(async () => undefined)
    expect(reads).toBe(1)

    // Work's sign-in finished in its own folder; the default row stays as it is.
    act(() =>
      transport.emit('auth.event', {
        provider: 'codex',
        loginId: 'work-login',
        success: true,
        error: null,
        accountId: 'work-1a2b3c',
      }),
    )
    await act(async () => undefined)
    expect(reads).toBe(1)

    act(() =>
      transport.emit('auth.event', {
        provider: 'codex',
        loginId: 'default-login',
        success: true,
        error: null,
      }),
    )
    await act(async () => undefined)
    expect(reads).toBe(2)
  })
})
