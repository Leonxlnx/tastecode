import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountIdSchema, type ProviderId } from '@harness/contracts'
import type { AccountHomeSource } from '@harness/proc/account-home'
import { afterEach, describe, expect, it } from 'vitest'
import { ACCOUNT_HOMES, ProviderAccounts } from './provider-accounts.js'
import { Store } from './store.js'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step()
})

function temporaryFolder(): string {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'harness-accounts-'))
  cleanup.push(() => rmSync(folder, { recursive: true, force: true }))
  return folder
}

/**
 * A provider CLI's own folder with one non-secret setting, a nested one and a
 * sign-in file that must never leave it.
 */
function setup() {
  const base = temporaryFolder()
  const cliHome = path.join(base, 'cli-home')
  mkdirSync(path.join(cliHome, 'nested'), { recursive: true })
  writeFileSync(path.join(cliHome, 'config.toml'), 'model = "x"\n')
  writeFileSync(path.join(cliHome, 'nested', 'settings.json'), '{}\n')
  writeFileSync(path.join(cliHome, 'auth.json'), '{"token":"secret"}\n')
  writeFileSync(path.join(base, 'outside.txt'), 'not a setting\n')
  const source: AccountHomeSource = {
    defaultHome: (environment = {}) => environment['FAKE_CLI_HOME'] ?? cliHome,
    environment: (home) => ({ FAKE_CLI_HOME: home }),
    seedFiles: ['config.toml', 'nested/settings.json', '../outside.txt', 'missing.toml'],
  }
  const store = new Store(':memory:')
  cleanup.push(() => store.close())
  const changed: ProviderId[] = []
  const root = path.join(base, 'data', 'accounts')
  const accounts = new ProviderAccounts(store, {
    root,
    homes: { codex: source, 'claude-code': source },
    environment: {},
    onChanged: (provider) => changed.push(provider),
    now: () => 1_000,
  })
  return { base, cliHome, root, store, accounts, changed }
}

describe('provider accounts', () => {
  it('offers accounts only where the adapter declares them', () => {
    expect(Object.keys(ACCOUNT_HOMES).sort()).toEqual(['claude-code', 'codex'])
    const { accounts } = setup()
    expect(accounts.list()).toEqual({
      accounts: [
        { id: 'default', provider: 'codex', label: 'Default', managed: false },
        { id: 'default', provider: 'claude-code', label: 'Default', managed: false },
      ],
      active: { codex: 'default', 'claude-code': 'default' },
    })
    expect(accounts.list('grok')).toEqual({ accounts: [], active: {} })
    expect(accounts.supports('grok')).toBe(false)
    expect(accounts.home('grok', undefined)).toBeUndefined()
    expect(accounts.home('grok', 'default')).toBeUndefined()
    const refused = 'This provider runs as one account only.'
    expect(() => accounts.home('grok', 'work')).toThrow(refused)
    expect(() => accounts.create('grok', 'Work', { kind: 'managed' })).toThrow(refused)
    expect(() => accounts.rename('grok', 'default', 'Mine')).toThrow(refused)
    expect(() => accounts.setActive('grok', 'default')).toThrow(refused)
    return expect(accounts.remove('grok', 'work')).rejects.toThrow(refused)
  })

  it('gives a CLI the variables of an account whose folder is still there', () => {
    const { accounts, base } = setup()
    const managed = accounts.create('codex', 'Work', { kind: 'managed' })
    const brought = path.join(base, 'brought')
    mkdirSync(brought)
    const existing = accounts.create('codex', 'Old laptop', { kind: 'existing', path: brought })

    expect(accounts.environment('codex', undefined)).toEqual({})
    expect(accounts.environment('codex', 'default')).toEqual({})
    expect(accounts.environment('codex', managed.id)).toEqual({ FAKE_CLI_HOME: managed.home })
    rmSync(brought, { recursive: true })
    expect(() => accounts.environment('codex', existing.id)).toThrow(
      `This account's folder is missing (${brought}). Put it back, or remove the account.`,
    )
    expect(() => accounts.environment('grok', 'work')).toThrow(
      'This provider runs as one account only.',
    )
  })

  it('creates a managed folder with copies of the non-secret settings only', () => {
    const { accounts, root, changed } = setup()
    const account = accounts.create('codex', '  Work Laptop ', { kind: 'managed' })
    expect(account).toMatchObject({
      provider: 'codex',
      label: 'Work Laptop',
      managed: true,
      createdAt: 1_000,
    })
    expect(account.id).toMatch(/^work-laptop-[0-9a-f]{6}$/)
    expect(AccountIdSchema.safeParse(account.id).success).toBe(true)
    expect(account.home).toBe(path.join(root, 'codex', account.id))
    const home = account.home!
    expect(readdirSync(home, { recursive: true }).map(String).sort()).toEqual([
      'config.toml',
      'nested',
      path.join('nested', 'settings.json'),
    ])
    expect(readFileSync(path.join(home, 'config.toml'), 'utf8')).toBe('model = "x"\n')
    expect(changed).toEqual(['codex'])
    expect(accounts.home('codex', account.id)).toBe(home)
    expect(accounts.active('codex')).toBe('default')
    expect(accounts.list('codex').accounts.map((each) => each.id)).toEqual(['default', account.id])
  })

  it('starts an empty folder when the default account has no settings yet', () => {
    const { accounts, cliHome } = setup()
    rmSync(cliHome, { recursive: true, force: true })
    const account = accounts.create('claude-code', 'Ünïcode ✓', { kind: 'managed' })
    expect(account.id).toMatch(/^unicode-[0-9a-f]{6}$/)
    expect(readdirSync(account.home!)).toEqual([])
    expect(accounts.create('claude-code', '!!!', { kind: 'managed' }).id).toMatch(
      /^account-[0-9a-f]{6}$/,
    )
  })

  it('uses a folder the user brought as it is, after checking it', () => {
    const { accounts, base, cliHome } = setup()
    const brought = path.join(base, 'second-login')
    mkdirSync(brought)
    const account = accounts.create('codex', 'Second', { kind: 'existing', path: brought })
    expect(account).toMatchObject({ home: brought, managed: false })
    expect(readdirSync(brought)).toEqual([])

    const create = (picked: string, label = 'Other') =>
      accounts.create('codex', label, { kind: 'existing', path: picked })
    expect(() => create(path.join(base, 'missing'))).toThrow('That folder does not exist.')
    expect(() => create(path.join(base, 'outside.txt'))).toThrow('That is a file, not a folder.')
    expect(() => create(cliHome)).toThrow('That folder is the default account.')
    expect(() => create(`${brought}${path.sep}`)).toThrow(
      'The account "Second" already uses that folder.',
    )
    const managed = accounts.create('codex', 'Managed', { kind: 'managed' })
    expect(() => create(managed.home!)).toThrow('The account "Managed" already uses that folder.')
    if (process.platform !== 'linux') {
      expect(() => create(cliHome.toUpperCase())).toThrow('That folder is the default account.')
    }
    // Another provider may use the same folder for its own CLI.
    expect(
      accounts.create('claude-code', 'Second', { kind: 'existing', path: brought }),
    ).toMatchObject({ home: brought })
  })

  it('renames any account, the default one included, to a free label', () => {
    const { accounts, changed } = setup()
    const work = accounts.create('codex', 'Work', { kind: 'managed' })
    expect(accounts.rename('codex', 'default', 'Personal')).toMatchObject({
      id: 'default',
      label: 'Personal',
    })
    expect(() => accounts.rename('codex', work.id, 'personal')).toThrow(
      'Another account is already called "Personal".',
    )
    expect(() => accounts.create('codex', 'WORK', { kind: 'managed' })).toThrow(
      'Another account is already called "Work".',
    )
    expect(accounts.rename('codex', work.id, 'work')).toMatchObject({ label: 'work' })
    expect(() => accounts.rename('codex', 'gone', 'Gone')).toThrow(
      'That account does not exist any more.',
    )
    expect(accounts.list('claude-code').accounts[0]?.label).toBe('Default')
    expect(changed).toEqual(['codex', 'codex', 'codex'])
  })

  it('chooses the account new chats start on', () => {
    const { accounts, changed } = setup()
    const work = accounts.create('codex', 'Work', { kind: 'managed' })
    changed.length = 0
    accounts.setActive('codex', work.id)
    accounts.setActive('codex', work.id)
    expect(accounts.active('codex')).toBe(work.id)
    expect(accounts.list().active).toEqual({ codex: work.id, 'claude-code': 'default' })
    expect(() => accounts.setActive('codex', 'gone')).toThrow(
      'That account does not exist any more.',
    )
    accounts.setActive('codex', 'default')
    expect(accounts.active('codex')).toBe('default')
    expect(changed).toEqual(['codex', 'codex'])
  })

  it('keeps the folder on remove and deletes only a managed one on request', async () => {
    const { accounts, base, root } = setup()
    const kept = accounts.create('codex', 'Kept', { kind: 'managed' })
    const deleted = accounts.create('codex', 'Deleted', { kind: 'managed' })
    const brought = path.join(base, 'brought')
    mkdirSync(brought)
    writeFileSync(path.join(brought, 'mine.txt'), 'keep\n')
    const existing = accounts.create('codex', 'Brought', { kind: 'existing', path: brought })
    accounts.setActive('codex', kept.id)

    await expect(accounts.remove('codex', 'default')).rejects.toThrow(
      'The default account cannot be removed.',
    )
    await accounts.remove('codex', kept.id)
    expect(readdirSync(kept.home!)).toEqual(['config.toml', 'nested'])
    expect(accounts.active('codex')).toBe('default')
    expect(() => accounts.home('codex', kept.id)).toThrow('That account does not exist any more.')

    await expect(accounts.remove('codex', existing.id, true)).rejects.toThrow(
      'TasteCode deletes only folders it created. This folder stays as it is.',
    )
    expect(readdirSync(brought)).toEqual(['mine.txt'])
    expect(accounts.home('codex', existing.id)).toBe(brought)

    await accounts.remove('codex', deleted.id, true)
    expect(readdirSync(path.join(root, 'codex')).sort()).toEqual([kept.id])
    await expect(accounts.remove('codex', deleted.id)).rejects.toThrow(
      'That account does not exist any more.',
    )
    expect(accounts.list('codex').accounts.map((each) => each.id)).toEqual(['default', existing.id])
  })

  it('remembers the last identity each account named', () => {
    const { accounts, changed } = setup()
    const work = accounts.create('codex', 'Work', { kind: 'managed' })
    changed.length = 0
    const identity = (id: string) =>
      accounts.list('codex').accounts.find((account) => account.id === id)

    accounts.recordIdentity('codex', undefined, { signedIn: true, email: 'me@x.dev', plan: 'pro' })
    accounts.recordIdentity('codex', 'default', { signedIn: true, email: 'me@x.dev' })
    accounts.recordIdentity('codex', 'default', { signedIn: false })
    expect(identity('default')).toMatchObject({ email: 'me@x.dev', plan: 'pro', label: 'Default' })

    accounts.recordIdentity('codex', work.id, { signedIn: true, email: 'work@x.dev', plan: 'team' })
    accounts.recordIdentity('codex', work.id, { signedIn: true, email: 'other@x.dev' })
    expect(identity(work.id)).toMatchObject({ email: 'other@x.dev' })
    expect(identity(work.id)?.plan).toBeUndefined()

    accounts.recordIdentity('codex', 'gone', { signedIn: true, email: 'gone@x.dev' })
    accounts.recordIdentity('grok', undefined, { signedIn: true, email: 'grok@x.dev' })
    expect(changed).toEqual(['codex', 'codex', 'codex'])
  })
})
