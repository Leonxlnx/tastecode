import { randomBytes } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { CLAUDE_ACCOUNT_HOME } from '@harness/adapter-claude-code/account-home'
import { CLAUDE_CAPABILITIES } from '@harness/adapter-claude-code/capabilities'
import { CODEX_ACCOUNT_HOME } from '@harness/adapter-codex/account-home'
import { CODEX_CAPABILITIES } from '@harness/adapter-codex/capabilities'
import {
  DEFAULT_ACCOUNT_ID,
  ProviderAccountSchema,
  type Account,
  type AccountId,
  type Capabilities,
  type ProviderAccount,
  type ProviderAccountHome,
  type ProviderId,
  type ResultOf,
} from '@harness/contracts'
import type { AccountHomeSource } from '@harness/proc/account-home'
import {
  AccountNotFoundError,
  existingAccountHome,
  type AccountDirectory,
} from './account-directory.js'
import { accountRead } from './account-identity.js'
import type { Store, StoredProviderAccount } from './store.js'

export type AccountHomes = Readonly<Partial<Record<ProviderId, AccountHomeSource>>>

function declared(
  entries: ReadonlyArray<readonly [ProviderId, Capabilities, AccountHomeSource]>,
): AccountHomes {
  return Object.fromEntries(
    entries
      .filter(([, capabilities]) => capabilities.multipleAccounts === true)
      .map(([provider, , home]) => [provider, home]),
  )
}

/**
 * The providers whose adapter declares `multipleAccounts`, with the folder
 * source it exports. Every other provider runs as its default account only;
 * Grok joins once a captured run proves its own folder keeps sign-ins apart.
 */
export const ACCOUNT_HOMES: AccountHomes = declared([
  ['claude-code', CLAUDE_CAPABILITIES, CLAUDE_ACCOUNT_HOME],
  ['codex', CODEX_CAPABILITIES, CODEX_ACCOUNT_HOME],
])

/** What the default account is called until the user renames it. */
const DEFAULT_LABEL = 'Default'
/** The label's first letters make a managed folder recognisable on disk. */
const ID_SLUG_LENGTH = 40

type AccountRows = Pick<
  Store,
  | 'providerAccounts'
  | 'addProviderAccount'
  | 'renameProviderAccount'
  | 'recordProviderAccountIdentity'
  | 'removeProviderAccount'
  | 'setActiveProviderAccount'
>

export type ProviderAccountsOptions = {
  /** `<data folder>/accounts`. A managed account's folder is `<root>/<provider>/<id>`. */
  root: string
  /** Which providers keep accounts apart, and how. */
  homes?: AccountHomes
  /** The environment that picks each CLI's own folder, the default account's. */
  environment?: NodeJS.ProcessEnv
  /** A provider's accounts, labels, identities or active account changed. */
  onChanged?: (provider: ProviderId) => void
  now?: () => number
}

/**
 * The accounts each provider can run as. An account is a config folder of
 * its own, which the provider's adapter points its CLI at; the default
 * account is the CLI's own folder and is never removed. A managed folder is
 * created under the TasteCode data folder and starts with copies of the
 * default account's non-secret settings only, never its sign-in. Nothing
 * here opens a file inside an account's folder.
 */
export class ProviderAccounts implements AccountDirectory {
  readonly #rows: AccountRows
  readonly #root: string
  readonly #homes: AccountHomes
  readonly #environment: NodeJS.ProcessEnv
  readonly #onChanged: (provider: ProviderId) => void
  readonly #now: () => number

  constructor(rows: AccountRows, options: ProviderAccountsOptions) {
    this.#rows = rows
    this.#root = path.resolve(options.root)
    this.#homes = options.homes ?? ACCOUNT_HOMES
    this.#environment = options.environment ?? process.env
    this.#onChanged = options.onChanged ?? (() => {})
    this.#now = options.now ?? Date.now
  }

  /** Whether the provider can run as accounts beyond its default one. */
  supports(provider: ProviderId): boolean {
    return Object.hasOwn(this.#homes, provider)
  }

  /** Each listed provider's default account first, then the others oldest first. */
  list(provider?: ProviderId): ResultOf<'accounts.list'> {
    const providers =
      provider === undefined
        ? (Object.keys(this.#homes) as ProviderId[])
        : this.supports(provider)
          ? [provider]
          : []
    const accounts: ProviderAccount[] = []
    const active: Partial<Record<ProviderId, AccountId>> = {}
    for (const each of providers) {
      const rows = this.#rows.providerAccounts(each)
      const listed = this.#accounts(each, rows)
      const chosen = rows.find((row) => row.active)?.id
      active[each] =
        chosen !== undefined && listed.some((account) => account.id === chosen)
          ? chosen
          : DEFAULT_ACCOUNT_ID
      accounts.push(...listed)
    }
    return { accounts, active }
  }

  /** The account a new chat with this provider starts on. */
  active(provider: ProviderId): AccountId {
    return this.list(provider).active[provider] ?? DEFAULT_ACCOUNT_ID
  }

  /**
   * The folder an account's processes run in, for its adapter to map onto
   * the CLI's own variable. Undefined for the default account, which runs
   * with no override. Refuses an account the provider cannot have.
   */
  home(provider: ProviderId, accountId: AccountId | undefined): string | undefined {
    if (accountId === undefined || accountId === DEFAULT_ACCOUNT_ID) return undefined
    return this.#require(provider, accountId).home
  }

  /**
   * The variables that make a CLI run as the account, laid over the inherited
   * environment, as its adapter maps them; none for the default account.
   * Refuses an account whose folder is gone, where a CLI would quietly make a
   * new, signed-out account.
   */
  environment(provider: ProviderId, accountId: AccountId | undefined): NodeJS.ProcessEnv {
    const home = existingAccountHome(this, provider, accountId)
    return home === undefined ? {} : this.#source(provider).environment(home)
  }

  create(provider: ProviderId, label: string, home: ProviderAccountHome): ProviderAccount {
    const source = this.#source(provider)
    const name = label.trim()
    const rows = this.#rows.providerAccounts(provider)
    this.#assertFreeLabel(provider, rows, name)
    const id = this.#newId(provider, name, rows)
    const createdAt = this.#now()
    if (home.kind === 'existing') {
      const folder = this.#existingFolder(provider, source, rows, home.path)
      this.#rows.addProviderAccount({
        provider,
        id,
        label: name,
        home: folder,
        managed: false,
        createdAt,
      })
    } else {
      const folder = this.#managedHome(provider, id)
      this.#makeManagedHome(source, folder)
      try {
        this.#rows.addProviderAccount({ provider, id, label: name, managed: true, createdAt })
      } catch (error) {
        rmSync(folder, { recursive: true, force: true })
        throw error
      }
    }
    this.#onChanged(provider)
    return this.#require(provider, id)
  }

  rename(provider: ProviderId, accountId: AccountId, label: string): ProviderAccount {
    const name = label.trim()
    this.#require(provider, accountId)
    this.#assertFreeLabel(provider, this.#rows.providerAccounts(provider), name, accountId)
    this.#rows.renameProviderAccount(provider, accountId, name)
    this.#onChanged(provider)
    return this.#require(provider, accountId)
  }

  /**
   * Unregister an account; its folder stays. `deleteHome` also deletes a
   * folder TasteCode created, which signs that account out and erases its
   * local sessions. A folder the user brought is never deleted.
   */
  async remove(provider: ProviderId, accountId: AccountId, deleteHome = false): Promise<void> {
    if (accountId === DEFAULT_ACCOUNT_ID) {
      this.#source(provider)
      throw new Error('The default account cannot be removed.')
    }
    const account = this.#require(provider, accountId)
    if (deleteHome) {
      if (!account.managed || account.home === undefined) {
        throw new Error('TasteCode deletes only folders it created. This folder stays as it is.')
      }
      await this.#deleteManagedHome(account.home)
    }
    this.#rows.removeProviderAccount(provider, accountId)
    this.#onChanged(provider)
  }

  setActive(provider: ProviderId, accountId: AccountId): void {
    this.#require(provider, accountId)
    if (this.active(provider) === accountId) return
    this.#rows.setActiveProviderAccount(provider, accountId)
    this.#onChanged(provider)
  }

  /**
   * Keep who an account's own sign-in check named, for the account list. A
   * signed-out read keeps the last known identity, and a read that leaves a
   * detail out keeps the one named before.
   */
  recordIdentity(provider: ProviderId, accountId: AccountId | undefined, account: Account): void {
    if (!this.supports(provider) || !account.signedIn) return
    const id = accountId ?? DEFAULT_ACCOUNT_ID
    const row = this.#rows.providerAccounts(provider).find((each) => each.id === id)
    if (row === undefined && id !== DEFAULT_ACCOUNT_ID) return
    const previous = row && {
      signedIn: true,
      ...(row.email === undefined ? {} : { email: row.email }),
      ...(row.plan === undefined ? {} : { plan: row.plan }),
    }
    const { identity } = accountRead(previous, account)
    if (identity.email === row?.email && identity.plan === row?.plan) return
    this.#rows.recordProviderAccountIdentity(provider, id, {
      ...(identity.email === undefined ? {} : { email: identity.email }),
      ...(identity.plan === undefined ? {} : { plan: identity.plan }),
    })
    this.#onChanged(provider)
  }

  #source(provider: ProviderId): AccountHomeSource {
    const source = this.#homes[provider]
    if (!source) throw new Error('This provider runs as one account only.')
    return source
  }

  #require(provider: ProviderId, accountId: AccountId): ProviderAccount {
    this.#source(provider)
    const account = this.#accounts(provider, this.#rows.providerAccounts(provider)).find(
      (each) => each.id === accountId,
    )
    if (!account) throw new AccountNotFoundError()
    return account
  }

  #accounts(provider: ProviderId, rows: readonly StoredProviderAccount[]): ProviderAccount[] {
    const stored = rows.find((row) => row.id === DEFAULT_ACCOUNT_ID)
    const defaultAccount: ProviderAccount = {
      id: DEFAULT_ACCOUNT_ID,
      provider,
      label: stored?.label ?? DEFAULT_LABEL,
      managed: false,
      ...(stored?.email === undefined ? {} : { email: stored.email }),
      ...(stored?.plan === undefined ? {} : { plan: stored.plan }),
    }
    const others = rows.flatMap((row) => {
      if (row.id === DEFAULT_ACCOUNT_ID) return []
      const parsed = ProviderAccountSchema.safeParse({
        id: row.id,
        provider,
        label: row.label,
        // A managed folder follows the data folder; only a brought one is stored.
        home: row.managed ? this.#managedHome(provider, row.id) : row.home,
        managed: row.managed,
        createdAt: row.createdAt,
        ...(row.email === undefined ? {} : { email: row.email }),
        ...(row.plan === undefined ? {} : { plan: row.plan }),
      })
      if (parsed.success) return [parsed.data]
      // A row a newer build shaped differently is left alone, not listed.
      console.warn(`[accounts] skipped an unreadable ${provider} account`)
      return []
    })
    return [defaultAccount, ...others]
  }

  #assertFreeLabel(
    provider: ProviderId,
    rows: readonly StoredProviderAccount[],
    label: string,
    except?: AccountId,
  ): void {
    if (!label) throw new Error('Give the account a name.')
    const wanted = label.toLocaleLowerCase()
    const taken = this.#accounts(provider, rows).find(
      (account) => account.id !== except && account.label.toLocaleLowerCase() === wanted,
    )
    if (taken) throw new Error(`Another account is already called "${taken.label}".`)
  }

  #newId(provider: ProviderId, label: string, rows: readonly StoredProviderAccount[]): AccountId {
    const slug = label
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, ID_SLUG_LENGTH)
      .replace(/-+$/, '')
    for (;;) {
      const id = `${slug || 'account'}-${randomBytes(3).toString('hex')}`
      if (rows.some((row) => row.id === id)) continue
      if (existsSync(this.#managedHome(provider, id))) continue
      return id
    }
  }

  #managedHome(provider: ProviderId, accountId: AccountId): string {
    return path.join(this.#root, provider, accountId)
  }

  #makeManagedHome(source: AccountHomeSource, folder: string): void {
    try {
      mkdirSync(path.dirname(folder), { recursive: true })
      // Not recursive: an existing folder is someone else's and fails here.
      mkdirSync(folder, { mode: 0o700 })
    } catch (error) {
      throw new Error(`Could not create the account folder (${errorCode(error)}).`)
    }
    try {
      const origin = source.defaultHome(this.#environment)
      for (const file of source.seedFiles) {
        const relative = path.normalize(file)
        if (path.isAbsolute(relative) || relative.startsWith('..')) continue
        const from = path.join(origin, relative)
        if (!isFile(from)) continue
        const to = path.join(folder, relative)
        mkdirSync(path.dirname(to), { recursive: true })
        copyFileSync(from, to, constants.COPYFILE_EXCL)
      }
    } catch (error) {
      rmSync(folder, { recursive: true, force: true })
      throw new Error(
        `Could not copy the default account's settings into the new folder (${errorCode(error)}).`,
      )
    }
  }

  #existingFolder(
    provider: ProviderId,
    source: AccountHomeSource,
    rows: readonly StoredProviderAccount[],
    picked: string,
  ): string {
    const folder = path.resolve(picked)
    let isFolder: boolean
    try {
      isFolder = statSync(folder).isDirectory()
    } catch {
      throw new Error('That folder does not exist.')
    }
    if (!isFolder) throw new Error('That is a file, not a folder.')
    if (sameFolder(folder, source.defaultHome(this.#environment))) {
      throw new Error('That folder is the default account.')
    }
    const owner = this.#accounts(provider, rows).find(
      (account) => account.home !== undefined && sameFolder(account.home, folder),
    )
    if (owner) throw new Error(`The account "${owner.label}" already uses that folder.`)
    return folder
  }

  async #deleteManagedHome(folder: string): Promise<void> {
    const relative = path.relative(this.#root, folder)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('TasteCode deletes only folders it created. This folder stays as it is.')
    }
    try {
      await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    } catch (error) {
      throw new Error(
        `Could not delete the account folder; close what uses it and try again (${errorCode(error)}).`,
      )
    }
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** Windows and macOS folders ignore case by default. */
function sameFolder(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase()
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'unknown error'
}
