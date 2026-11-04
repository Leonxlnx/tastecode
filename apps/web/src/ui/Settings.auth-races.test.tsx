// @vitest-environment happy-dom
import { useCallback, useState } from 'react'
import type { Account, ProviderId, ProviderStatus } from '@harness/contracts'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SIGNED_IN_PROVIDERS_KEY, SIGNED_OUT_PROVIDERS_KEY } from '../remembered-sign-in.js'
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

describe('returning to the page', () => {
  it("opens on a row's last answer and reads it again behind it", async () => {
    const reread = deferred<Account>()
    let reads = 0
    const transport = new TestTransport((method) => {
      if (method === 'providers.updates') return { updates: [] }
      if (method === 'auth.status') return ++reads === 1 ? { signedIn: true } : reread.promise
      throw new Error(`Unexpected ${method}`)
    })
    // The composer is on another provider, so it does not hand this row an account.
    const props = {
      provider: 'claude-code' as const,
      account: undefined,
      providerStatuses: statuses,
      transport,
      onConnectionsChanged,
      onAccountChange: vi.fn(),
    }
    const first = render(<ProviderSettings {...props} />)
    expect(screen.getByText('Checking account…')).toBeTruthy()
    await act(async () => undefined)
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
    first.unmount()

    render(<ProviderSettings {...props} />)
    expect(screen.queryByText('Checking account…')).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
    expect(reads).toBe(2)
    await act(async () => reread.resolve({ signedIn: false }))
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('opens on a sign-out made on an earlier visit', async () => {
    const reread = deferred<Account>()
    let reads = 0
    const transport = new TestTransport((method) => {
      if (method === 'providers.updates') return { updates: [] }
      if (method === 'auth.status') return ++reads === 1 ? account : reread.promise
      if (method === 'auth.signOut') return {}
      throw new Error(`Unexpected ${method}`)
    })
    const props = {
      provider: 'claude-code' as const,
      account: undefined,
      providerStatuses: statuses,
      transport,
      onConnectionsChanged,
      onAccountChange: vi.fn(),
    }
    const first = render(<ProviderSettings {...props} />)
    await act(async () => undefined)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await act(async () => undefined)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
    first.unmount()

    render(<ProviderSettings {...props} />)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
    expect(reads).toBe(2)
  })

  it('keeps an answer that arrives after the page closed', async () => {
    const late = deferred<Account>()
    const reread = deferred<Account>()
    let reads = 0
    const transport = new TestTransport((method) => {
      if (method === 'providers.updates') return { updates: [] }
      if (method === 'auth.status') return ++reads === 1 ? late.promise : reread.promise
      throw new Error(`Unexpected ${method}`)
    })
    const props = {
      provider: 'claude-code' as const,
      account: undefined,
      providerStatuses: statuses,
      transport,
      onConnectionsChanged,
      onAccountChange: vi.fn(),
    }
    const first = render(<ProviderSettings {...props} />)
    expect(screen.getByText('Checking account…')).toBeTruthy()
    // Left before the CLI answered.
    first.unmount()
    await act(async () => late.resolve({ signedIn: true }))

    render(<ProviderSettings {...props} />)
    expect(screen.queryByText('Checking account…')).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
    expect(reads).toBe(2)
  })

  it('joins a read a closed visit left running instead of starting another CLI', async () => {
    const slow = deferred<Account>()
    const later = deferred<Account>()
    let reads = 0
    const transport = new TestTransport((method) => {
      if (method === 'providers.updates') return { updates: [] }
      if (method === 'auth.status') return ++reads === 1 ? slow.promise : later.promise
      throw new Error(`Unexpected ${method}`)
    })
    const props = {
      provider: 'claude-code' as const,
      account: undefined,
      providerStatuses: statuses,
      transport,
      onConnectionsChanged,
      onAccountChange: vi.fn(),
    }
    const first = render(<ProviderSettings {...props} />)
    first.unmount()
    // Reopened twice while the first visit's CLI is still answering.
    render(<ProviderSettings {...props} />).unmount()
    const third = render(<ProviderSettings {...props} />)
    expect(reads).toBe(1)
    await act(async () => slow.resolve({ signedIn: true }))
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
    third.unmount()

    // The next visit reads again; one after a sign-in in a terminal must not join that read.
    render(<ProviderSettings {...props} />).unmount()
    expect(reads).toBe(2)
    render(<ProviderSettings {...props} authRefreshRevision={1} />)
    expect(reads).toBe(3)
  })

  it('does not reopen on a read that started before a sign-out on the page', async () => {
    const stale = deferred<Account>()
    let reads = 0
    const transport = new TestTransport((method) => {
      if (method === 'providers.updates') return { updates: [] }
      if (method === 'auth.status') {
        reads += 1
        return reads === 1 ? account : reads === 2 ? stale.promise : new Promise(() => undefined)
      }
      if (method === 'auth.signOut') return {}
      throw new Error(`Unexpected ${method}`)
    })
    const props = {
      provider: 'claude-code' as const,
      account: undefined,
      providerStatuses: statuses,
      transport,
      onConnectionsChanged,
      onAccountChange: vi.fn(),
    }
    const first = render(<ProviderSettings {...props} />)
    await act(async () => undefined)
    first.rerender(<ProviderSettings {...props} authRefreshRevision={1} />)
    expect(reads).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await act(async () => undefined)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
    first.unmount()
    await act(async () => stale.resolve(account))

    render(<ProviderSettings {...props} />)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it.each([
    [true, 'Sign out'],
    [false, 'Sign in'],
  ])(
    'opens a row first read this run on what an earlier run kept (signed in: %s)',
    async (signedIn, action) => {
      localStorage.setItem(
        signedIn ? SIGNED_IN_PROVIDERS_KEY : SIGNED_OUT_PROVIDERS_KEY,
        JSON.stringify(['codex']),
      )
      try {
        const reread = deferred<Account>()
        let reads = 0
        const transport = new TestTransport((method) => {
          if (method === 'providers.updates') return { updates: [] }
          if (method === 'auth.status') {
            reads += 1
            return reread.promise
          }
          throw new Error(`Unexpected ${method}`)
        })
        render(
          <ProviderSettings
            provider="claude-code"
            account={undefined}
            providerStatuses={statuses}
            transport={transport}
            onConnectionsChanged={onConnectionsChanged}
            onAccountChange={vi.fn()}
          />,
        )
        expect(screen.queryByText('Checking account…')).toBeNull()
        expect(screen.getByRole('button', { name: action })).toBeTruthy()
        expect(reads).toBe(1)
        await act(async () => reread.resolve({ signedIn: !signedIn }))
        expect(screen.getByRole('button', { name: signedIn ? 'Sign in' : 'Sign out' })).toBeTruthy()
      } finally {
        localStorage.removeItem(SIGNED_IN_PROVIDERS_KEY)
        localStorage.removeItem(SIGNED_OUT_PROVIDERS_KEY)
      }
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
