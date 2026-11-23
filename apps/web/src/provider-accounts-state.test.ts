import type { ProviderAccount, ResultOf } from '@harness/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACCOUNT_CHOSEN_KEY,
  ACCOUNT_TONES,
  accountIdentityOf,
  accountLabelOf,
  accountsOf,
  activeAccountOf,
  namedNewChatAccount,
  ProviderAccountsStore,
} from './provider-accounts-state.js'
import { TestTransport } from './test-transport.js'

/** Each test starts with nothing remembered about which account the user picked. */
const stored = new Map<string, string>()
beforeEach(() => {
  stored.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

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

  it('lets the recommended account stand in for new chats until the user picks one', async () => {
    const transport = new TestTransport((method) => (method === 'accounts.list' ? listing() : {}))
    const store = new ProviderAccountsStore(transport)
    store.retain()
    await expect.poll(() => store.snapshot().phase).toBe('ready')
    let notified = 0
    store.subscribe(() => (notified += 1))

    // Before any recommendation, nothing is named: the server chooses.
    expect(namedNewChatAccount(store.snapshot(), 'codex')).toBeUndefined()
    store.recommend({ codex: 'work-1a2b3c' })
    expect(activeAccountOf(store.snapshot(), 'codex')).toBe('work-1a2b3c')
    expect(store.snapshot().preselected).toEqual({ codex: 'work-1a2b3c' })
    expect(namedNewChatAccount(store.snapshot(), 'codex')).toBe('work-1a2b3c')
    expect(notified).toBe(1)
    // The same recommendation again changes nothing and tells no one.
    const before = store.snapshot()
    store.recommend({ codex: 'work-1a2b3c' })
    expect(store.snapshot()).toBe(before)
    expect(notified).toBe(1)
    // Nothing was sent: the server keeps its own active account.
    expect(transport.requests.map((request) => request.method)).toEqual(['accounts.list'])

    // An account the list does not hold is never preselected.
    store.recommend({ codex: 'gone-000000' })
    expect(activeAccountOf(store.snapshot(), 'codex')).toBe('default')
    expect(store.snapshot().preselected).toBeUndefined()

    // A list read keeps the recommendation standing in.
    store.recommend({ codex: 'work-1a2b3c' })
    const beforeRead = store.snapshot()
    store.refresh()
    await expect.poll(() => store.snapshot()).not.toBe(beforeRead)
    expect(transport.requests).toHaveLength(2)
    expect(activeAccountOf(store.snapshot(), 'codex')).toBe('work-1a2b3c')

    // The user's own pick wins, the default account included, and keeps winning;
    // a new chat names it, so the server's recommendation cannot replace it.
    await store.setActive('codex', 'default')
    expect(activeAccountOf(store.snapshot(), 'codex')).toBe('default')
    expect(store.snapshot().preselected).toBeUndefined()
    store.recommend({})
    store.recommend({ codex: 'work-1a2b3c' })
    expect(activeAccountOf(store.snapshot(), 'codex')).toBe('default')
    expect(namedNewChatAccount(store.snapshot(), 'codex')).toBe('default')
  })

  it('names a recommendation that matches the active account too', async () => {
    const transport = new TestTransport(() => listing())
    const store = new ProviderAccountsStore(transport)
    store.retain()
    await expect.poll(() => store.snapshot().phase).toBe('ready')
    store.recommend({ codex: 'default' })
    expect(activeAccountOf(store.snapshot(), 'codex')).toBe('default')
    expect(namedNewChatAccount(store.snapshot(), 'codex')).toBe('default')
  })

  it('keeps a further account the server keeps active as the one new chats start on', async () => {
    const transport = new TestTransport(() => listing({ codex: 'work-1a2b3c' }))
    const store = new ProviderAccountsStore(transport)
    store.retain()
    await expect.poll(() => store.snapshot().phase).toBe('ready')
    store.recommend({ codex: 'default' })
    expect(activeAccountOf(store.snapshot(), 'codex')).toBe('work-1a2b3c')
    expect(store.snapshot().preselected).toBeUndefined()
    expect(namedNewChatAccount(store.snapshot(), 'codex')).toBe('work-1a2b3c')
  })

  it('remembers across launches which providers the user picked an account for', async () => {
    const transport = new TestTransport((method) => (method === 'accounts.list' ? listing() : {}))
    const first = new ProviderAccountsStore(transport)
    await first.setActive('codex', 'default')
    expect(JSON.parse(stored.get(ACCOUNT_CHOSEN_KEY) ?? '[]')).toEqual(['codex'])

    const next = new ProviderAccountsStore(transport)
    next.retain()
    await expect.poll(() => next.snapshot().phase).toBe('ready')
    next.recommend({ codex: 'work-1a2b3c' })
    expect(activeAccountOf(next.snapshot(), 'codex')).toBe('default')

    // A stored value that is not a list of providers reads as no choice.
    stored.set(ACCOUNT_CHOSEN_KEY, '{"codex":true}')
    const broken = new ProviderAccountsStore(transport)
    broken.retain()
    await expect.poll(() => broken.snapshot().phase).toBe('ready')
    broken.recommend({ codex: 'work-1a2b3c' })
    expect(activeAccountOf(broken.snapshot(), 'codex')).toBe('work-1a2b3c')
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

describe('accountIdentityOf', () => {
  const ready = { phase: 'ready' as const, ...listing() }

  it("gives each of a provider's accounts its own tone, its label and its plan", () => {
    const withPlan = {
      ...ready,
      accounts: ready.accounts.map((account) =>
        account.id === 'default'
          ? { ...account, plan: 'Max x5', email: 'me@example.test' }
          : account,
      ),
    }
    expect(accountIdentityOf(withPlan, 'codex', undefined)).toEqual({
      label: 'Default',
      plan: 'Max x5',
      tone: 1,
    })
    expect(accountIdentityOf(withPlan, 'codex', 'work-1a2b3c')).toEqual({
      label: 'Work',
      plan: undefined,
      tone: 2,
    })
  })

  it('keeps a tone whichever account is active, so the colour means the same tomorrow', () => {
    const tone = (active: ResultOf<'accounts.list'>['active']) =>
      accountIdentityOf({ phase: 'ready', ...listing(active) }, 'codex', 'work-1a2b3c').tone
    expect(tone({ codex: 'work-1a2b3c' })).toBe(tone({}))
  })

  it('counts tones per provider and starts over past the last one', () => {
    const accounts: ProviderAccount[] = Array.from({ length: ACCOUNT_TONES + 1 }, (_, place) => ({
      ...work,
      id: place === 0 ? 'default' : `extra-${place}`,
    })).map(({ home, ...account }, place) => ({
      ...account,
      ...(place === 0 ? {} : { home }),
      managed: place !== 0,
    }))
    const many = { phase: 'ready' as const, accounts, active: {} }
    expect(accountIdentityOf(many, 'codex', `extra-${ACCOUNT_TONES - 1}`).tone).toBe(ACCOUNT_TONES)
    expect(accountIdentityOf(many, 'codex', `extra-${ACCOUNT_TONES}`).tone).toBe(1)
    expect(accountIdentityOf(many, 'claude-code', 'default').tone).toBe(0)
  })

  it('gives an account the list does not hold no colour', () => {
    expect(accountIdentityOf(ready, 'codex', 'gone-9f9f9f')).toEqual({
      label: 'Removed account',
      plan: undefined,
      tone: 0,
    })
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
