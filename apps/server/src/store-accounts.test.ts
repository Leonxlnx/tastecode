import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from './sqlite.js'
import { Store } from './store.js'

const stores: Store[] = []
const roots: string[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function open(location = ':memory:'): Store {
  const store = new Store(location)
  stores.push(store)
  return store
}

describe('provider accounts in the store', () => {
  it('keeps a managed account and a brought folder, oldest first', () => {
    const store = open()
    expect(store.providerAccounts('codex')).toEqual([])
    store.addProviderAccount({
      provider: 'codex',
      id: 'work-1a2b3c',
      label: 'Work',
      managed: true,
      createdAt: 2,
    })
    store.addProviderAccount({
      provider: 'codex',
      id: 'old-4d5e6f',
      label: 'Old laptop',
      home: 'D:\\codex-old',
      managed: false,
      createdAt: 1,
    })
    expect(store.providerAccounts('codex')).toEqual([
      {
        provider: 'codex',
        id: 'old-4d5e6f',
        label: 'Old laptop',
        home: 'D:\\codex-old',
        managed: false,
        createdAt: 1,
        active: false,
      },
      {
        provider: 'codex',
        id: 'work-1a2b3c',
        label: 'Work',
        managed: true,
        createdAt: 2,
        active: false,
      },
    ])
    expect(store.providerAccounts('claude-code')).toEqual([])
    expect(() =>
      store.addProviderAccount({
        provider: 'codex',
        id: 'work-1a2b3c',
        label: 'Again',
        managed: true,
        createdAt: 3,
      }),
    ).toThrow()
  })

  it('adds the default account row on its first rename or identity', () => {
    const store = open()
    store.recordProviderAccountIdentity('claude-code', 'default', {
      email: 'me@example.com',
      plan: 'max',
    })
    store.renameProviderAccount('claude-code', 'default', 'Personal')
    const [row] = store.providerAccounts('claude-code')
    expect(row).toMatchObject({
      id: 'default',
      label: 'Personal',
      managed: false,
      email: 'me@example.com',
      plan: 'max',
      active: false,
    })
    expect(row?.home).toBeUndefined()

    store.recordProviderAccountIdentity('claude-code', 'default', { email: 'me@example.com' })
    expect(store.providerAccounts('claude-code')[0]?.plan).toBeUndefined()
    expect(() => store.renameProviderAccount('claude-code', 'missing', 'Nope')).toThrow(
      'account not found',
    )
    expect(() => store.recordProviderAccountIdentity('codex', 'missing', {})).toThrow(
      'account not found',
    )
    expect(store.providerAccounts('codex')).toEqual([])
  })

  it('keeps one active account per provider and falls back to the default one', () => {
    const store = open()
    for (const [provider, id] of [
      ['codex', 'a'],
      ['codex', 'b'],
      ['claude-code', 'c'],
    ] as const) {
      store.addProviderAccount({ provider, id, label: id, managed: true, createdAt: 1 })
    }
    const active = () =>
      [...store.providerAccounts('codex'), ...store.providerAccounts('claude-code')]
        .filter((account) => account.active)
        .map((account) => account.id)

    store.setActiveProviderAccount('codex', 'a')
    store.setActiveProviderAccount('claude-code', 'c')
    store.setActiveProviderAccount('codex', 'b')
    expect(active()).toEqual(['b', 'c'])

    expect(() => store.setActiveProviderAccount('codex', 'missing')).toThrow('account not found')
    expect(active()).toEqual(['b', 'c'])

    store.setActiveProviderAccount('codex', 'default')
    expect(active()).toEqual(['c'])

    store.setActiveProviderAccount('claude-code', 'c')
    expect(store.removeProviderAccount('claude-code', 'c')).toBe(true)
    expect(store.removeProviderAccount('claude-code', 'c')).toBe(false)
    expect(active()).toEqual([])
  })

  it('survives a restart and leaves rows of providers it does not know alone', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'harness-store-accounts-'))
    roots.push(root)
    const location = path.join(root, 'tastecode.db')
    const first = open(location)
    first.addProviderAccount({
      provider: 'codex',
      id: 'w',
      label: 'W',
      managed: true,
      createdAt: 1,
    })
    first.setActiveProviderAccount('codex', 'w')
    first.close()
    stores.splice(stores.indexOf(first), 1)

    // A newer build's provider, written while this build was closed.
    const raw = new DatabaseSync(location)
    raw
      .prepare(
        `INSERT INTO provider_accounts (provider, id, label, managed, created_at, active)
         VALUES ('future-agent', 'x', 'X', 1, 1, 1)`,
      )
      .run()
    raw.close()

    const reopened = open(location)
    expect(reopened.providerAccounts('codex')).toMatchObject([{ id: 'w', active: true }])
    reopened.setActiveProviderAccount('codex', 'default')
    expect(reopened.removeProviderAccount('codex', 'w')).toBe(true)
    reopened.close()
    stores.splice(stores.indexOf(reopened), 1)

    const check = new DatabaseSync(location)
    try {
      expect(check.prepare(`SELECT provider, id, active FROM provider_accounts`).all()).toEqual([
        { provider: 'future-agent', id: 'x', active: 1 },
      ])
    } finally {
      check.close()
    }
  })
})

describe('the account a chat is pinned to', () => {
  it('keeps chats from before accounts on the default account', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'harness-store-accounts-'))
    roots.push(root)
    const location = path.join(root, 'tastecode.db')
    const first = open(location)
    first.addThread({ id: 'older', projectPath: root, provider: 'codex', title: 'Older' })
    first.close()
    stores.splice(stores.indexOf(first), 1)
    // The table as a build before accounts left it.
    const raw = new DatabaseSync(location)
    raw.prepare(`ALTER TABLE threads DROP COLUMN account_id`).run()
    raw.close()

    const store = open(location)
    store.addThread({
      id: 'pinned',
      projectPath: root,
      provider: 'codex',
      accountId: 'work-1a2b3c',
      title: 'Pinned',
    })
    expect(store.thread('older')?.accountId).toBeUndefined()
    expect(store.thread('pinned')?.accountId).toBe('work-1a2b3c')
    expect(
      store.sidebarThreads().map((thread) => [thread.id, thread.accountId ?? 'default']),
    ).toEqual(
      expect.arrayContaining([
        ['older', 'default'],
        ['pinned', 'work-1a2b3c'],
      ]),
    )
    store.close()
    stores.splice(stores.indexOf(store), 1)
    // Read back from disk, not from the store's cache.
    expect(open(location).thread('pinned')?.accountId).toBe('work-1a2b3c')
  })
})
