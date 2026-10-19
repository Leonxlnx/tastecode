import type { ProviderAccount, ResultOf } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import {
  accountLabelOf,
  accountsOf,
  activeAccountOf,
  ProviderAccountsStore,
} from './provider-accounts-state.js'
import { TestTransport } from './test-transport.js'

const work: ProviderAccount = {
  id: 'work-1a2b3c',
  provider: 'codex',
  label: 'Work',
  home: 'C:\\Users\\leon\\AppData\\Roaming\\TasteCode\\accounts\\codex\\work-1a2b3c',
  managed: true,
  createdAt: 1,
}
const listing = (active: ResultOf<'accounts.list'>['active'] = {}): ResultOf<'accounts.list'> => ({
  accounts: [{ id: 'default', provider: 'codex', label: 'Default', managed: false }, work],
  active,
})

describe('ProviderAccountsStore', () => {
  it('reads while retained and again on accounts.changed, one read at a time', async () => {
    const answers: Array<() => void> = []
    let current = listing()
    const transport = new TestTransport(
      (method) =>
        new Promise((resolve) => {
          expect(method).toBe('accounts.list')
          const answer = current
          answers.push(() => resolve(answer))
        }),
    )
    const store = new ProviderAccountsStore(transport)
    expect(store.snapshot().phase).toBe('idle')

    const release = store.retain()
    expect(store.snapshot().phase).toBe('loading')
    await expect.poll(() => answers.length).toBe(1)
    current = listing({ codex: 'work-1a2b3c' })
    transport.emit('accounts.changed', { provider: 'codex' })
    transport.emit('accounts.changed', { provider: 'codex' })
    answers[0]!()
    await expect.poll(() => store.snapshot().phase).toBe('ready')
    expect(accountsOf(store.snapshot(), 'codex').map((account) => account.id)).toEqual([
      'default',
      'work-1a2b3c',
    ])

    // The burst during the first read became exactly one more.
    await expect.poll(() => answers.length).toBe(2)
    answers[1]!()
    await expect.poll(() => activeAccountOf(store.snapshot(), 'codex')).toBe('work-1a2b3c')
    expect(transport.requests).toHaveLength(2)

    release()
    transport.emit('accounts.changed', { provider: 'codex' })
    await Promise.resolve()
    expect(transport.requests).toHaveLength(2)
  })

  it('treats a server from before accounts as default accounts only', async () => {
    const transport = new TestTransport(() => {
      throw new Error('unknown method: accounts.list')
    })
    const store = new ProviderAccountsStore(transport)
    store.retain()
    await expect.poll(() => store.snapshot().phase).toBe('ready')
    expect(store.snapshot().accounts).toEqual([])
    expect(activeAccountOf(store.snapshot(), 'codex')).toBe('default')
  })

  it('shows an active choice at once and falls back when the server refuses it', async () => {
    let refuse = false
    const transport = new TestTransport((method) => {
      if (method === 'accounts.list') return listing()
      if (refuse) throw new Error('The account is gone.')
      return {}
    })
    const store = new ProviderAccountsStore(transport)
    store.retain()
    await expect.poll(() => store.snapshot().phase).toBe('ready')

    const chosen = store.setActive('codex', 'work-1a2b3c')
    expect(activeAccountOf(store.snapshot(), 'codex')).toBe('work-1a2b3c')
    await chosen
    expect(transport.requests.at(-1)).toEqual({
      method: 'accounts.setActive',
      params: { provider: 'codex', accountId: 'work-1a2b3c' },
    })

    refuse = true
    await expect(store.setActive('codex', 'default')).rejects.toThrow('The account is gone.')
    // The server still lists no active choice, so the read brings back default.
    await expect.poll(() => transport.requests.at(-1)?.method).toBe('accounts.list')
    await expect.poll(() => activeAccountOf(store.snapshot(), 'codex')).toBe('default')
  })

  it('names an account active only while it is listed', () => {
    const snapshot = { phase: 'ready' as const, accounts: listing().accounts, active: {} }
    expect(activeAccountOf({ ...snapshot, active: { codex: 'gone-000000' } }, 'codex')).toBe(
      'default',
    )
    expect(activeAccountOf({ ...snapshot, active: { codex: 'work-1a2b3c' } }, 'codex')).toBe(
      'work-1a2b3c',
    )
  })
})

describe('accountLabelOf', () => {
  it('names an account by its label, never its id, and a removed one as removed', () => {
    const ready = { phase: 'ready' as const, ...listing() }
    expect(accountLabelOf(ready, 'codex', 'work-1a2b3c')).toBe('Work')
    expect(accountLabelOf(ready, 'codex', undefined)).toBe('Default')
    expect(accountLabelOf(ready, 'codex', 'gone-9f9f9f')).toBe('Removed account')
    // Before the list answers, an unknown id is not called removed yet.
    const loading = { phase: 'loading' as const, accounts: [], active: {} }
    expect(accountLabelOf(loading, 'codex', 'work-1a2b3c')).toBe('Account')
    expect(accountLabelOf(loading, 'codex', 'default')).toBe('Default')
  })
})
