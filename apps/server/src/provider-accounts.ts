import { randomBytes } from 'node:crypto'
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
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
  type DetectedAccountHome,
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

/** An account's removal, once nothing refused it: see ProviderAccounts.removal. */
export type AccountRemoval = {
  /** Drops the account, so nothing resolves it any more. */
  unregister: () => void
  /** Deletes its managed folder when that was asked for; nothing otherwise. */
  deleteFolder: () => Promise<void>
}

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
 * files its adapter seeds, never the sign-in; Codex and Claude Code seed
 * none, since their settings can hold the default account's keys. Nothing
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
    const removal = this.removal(provider, accountId, deleteHome)
    removal.unregister()
    await removal.deleteFolder()
  }

  /**
   * `remove` in two steps, refused before either when the account cannot go.
   * `unregister` drops the account at once, so nothing resolves it any more
   * (a chat, a limit read) while what ran as it stops; `deleteFolder` then
   * deletes the managed folder when asked, last.
   */
  removal(provider: ProviderId, accountId: AccountId, deleteHome = false): AccountRemoval {
    if (accountId === DEFAULT_ACCOUNT_ID) {
      this.#source(provider)
      throw new Error('The default account cannot be removed.')
    }
    const account = this.#require(provider, accountId)
    const folder = deleteHome ? account.home : undefined
    if (deleteHome && (!account.managed || folder === undefined || !this.#isManagedHome(folder))) {
      throw new Error('TasteCode deletes only folders it created. This folder stays as it is.')
    }
    let unregistered = false
    return {
      unregister: () => {
        if (unregistered) return
        unregistered = true
        this.#rows.removeProviderAccount(provider, accountId)
        this.#onChanged(provider)
      },
      deleteFolder: async () => {
        if (folder !== undefined) await this.#deleteManagedHome(folder)
      },
    }
  }

  /**
   * Config folders beside each provider's default one that its CLI has used
   * and that are no account yet: `~/.claude_work` beside `~/.claude`, or
   * `~/.codex-personal` beside `~/.codex`, as the user or another tool set
   * them up. Found from names and dates alone; nothing in them is opened and
   * no CLI runs there. Backup copies and folders already in use are left out.
   */
  detect(): DetectedAccountHome[] {
    const found: DetectedAccountHome[] = []
    for (const provider of Object.keys(this.#homes) as ProviderId[]) {
      const source = this.#source(provider)
      const markers = source.markers ?? []
      if (markers.length === 0) continue
      const rows = this.#rows.providerAccounts(provider)
      const labels = new Set(
        this.#accounts(provider, rows).map((account) => account.label.toLocaleLowerCase()),
      )
      for (const searched of searchedHomes(source, this.#environment)) {
        const parent = path.dirname(searched)
        const base = path.basename(searched)
        let names: string[]
        try {
          names = readdirSync(parent)
        } catch {
          continue
        }
        for (const name of names.sort()) {
          const suffix = siblingSuffix(base, name)
          if (suffix === undefined) continue
          const folder = path.join(parent, name)
          const lastUsed = lastWritten(folder, markers)
          if (lastUsed === undefined) continue
          try {
            this.#existingFolder(provider, source, rows, folder)
          } catch {
            continue
          }
          const label = freeLabel(labels, labelFrom(suffix), name)
          labels.add(label.toLocaleLowerCase())
          found.push({ provider, home: folder, label, lastUsed })
        }
      }
    }
    return found
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
    // Compared as the folders they are on disk, so a link or junction to a
    // folder in use, or a folder around or inside one, is not a new account.
    const real = realFolder(folder)
    const relation = (other: string) => folderRelation(real, realFolder(other))
    const toDefault = relation(source.defaultHome(this.#environment))
    if (toDefault === 'same') throw new Error('That folder is the default account.')
    if (toDefault)
      throw new Error(`That folder ${RELATION_WORDS[toDefault]} the default account's folder.`)
    const inUse = this.#accounts(provider, rows).flatMap((account) =>
      account.home === undefined
        ? []
        : [{ label: account.label, relation: relation(account.home) }],
    )
    const same = inUse.find((account) => account.relation === 'same')
    if (same) throw new Error(`The account "${same.label}" already uses that folder.`)
    // Every managed folder lives in the data folder, whichever provider it is
    // for; that names the data folder itself better than a managed folder in it.
    const toData = relation(path.dirname(this.#root))
    if (toData)
      throw new Error(`That folder ${RELATION_WORDS[toData]} TasteCode's own data folder.`)
    const overlapping = inUse.find((account) => account.relation !== undefined)
    if (overlapping?.relation) {
      throw new Error(
        `That folder ${RELATION_WORDS[overlapping.relation]} the folder of the account "${overlapping.label}".`,
      )
    }
    return folder
  }

  #isManagedHome(folder: string): boolean {
    const relative = path.relative(this.#root, folder)
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  }

  /** Runs once the account is gone, so a failure leaves only the folder behind. */
  async #deleteManagedHome(folder: string): Promise<void> {
    try {
      await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    } catch (error) {
      throw new Error(
        `The account is removed, but its folder could not be deleted (${errorCode(error)}). It is still at ${folder}.`,
      )
    }
  }
}

/** The longest account label the contract takes. */
const LABEL_LIMIT = 80

/** Folder names that are a copy kept aside, not an account in use. */
const SET_ASIDE = /(?:^|[-_.])(?:bak|backup|old|orig|copy|tmp|temp)\d*$/i

/**
 * The folders whose siblings can be further accounts: the default account's,
 * and the CLI's built-in one when a variable such as CODEX_HOME moved the
 * default elsewhere. Folders made beside `~/.codex` stay that CLI's after
 * such a move, and are found there.
 */
function searchedHomes(source: AccountHomeSource, environment: NodeJS.ProcessEnv): string[] {
  const homes = [source.defaultHome(environment), source.defaultHome({})]
  return homes.filter(
    (home, index) => homes.findIndex((other) => folderRelation(home, other) === 'same') === index,
  )
}

/**
 * What follows the default folder's name in a sibling's, `personal` for
 * `.claude_personal` beside `.claude`; none for anything else or a copy kept
 * aside.
 */
function siblingSuffix(base: string, name: string): string | undefined {
  if (!name.startsWith(base)) return undefined
  const rest = name.slice(base.length)
  if (!/^[-_.]./.test(rest) || SET_ASIDE.test(rest)) return undefined
  return rest.slice(1)
}

/**
 * When the CLI last wrote any of the entries only a folder it used holds;
 * undefined when the folder is not a folder or holds none of them.
 */
function lastWritten(folder: string, markers: readonly string[]): number | undefined {
  try {
    if (!statSync(folder).isDirectory()) return undefined
  } catch {
    return undefined
  }
  let latest: number | undefined
  for (const marker of markers) {
    try {
      const written = Math.trunc(statSync(path.join(folder, marker)).mtimeMs)
      latest = Math.max(latest ?? 0, written)
    } catch {
      // Not there: a CLI that never wrote this entry.
    }
  }
  return latest
}

/** `Personal` for `personal`, `Work laptop` for `work-laptop`. */
function labelFrom(suffix: string): string {
  const words = suffix.replace(/[-_.]+/g, ' ').trim()
  return words.charAt(0).toLocaleUpperCase() + words.slice(1)
}

/** The wanted label, else the folder's own name, numbered once both are taken. */
function freeLabel(taken: ReadonlySet<string>, wanted: string, folderName: string): string {
  for (const candidate of [wanted, folderName].map((each) => each.slice(0, LABEL_LIMIT))) {
    if (candidate && !taken.has(candidate.toLocaleLowerCase())) return candidate
  }
  for (let number = 2; ; number += 1) {
    const candidate = `${(wanted || folderName).slice(0, LABEL_LIMIT - 4)} ${number}`
    if (!taken.has(candidate.toLocaleLowerCase())) return candidate
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

type FolderRelation = 'same' | 'inside' | 'contains'

const RELATION_WORDS = {
  same: 'is',
  inside: 'is inside',
  contains: 'contains',
} as const satisfies Record<FolderRelation, string>

/** The folder a path names on disk, links resolved; as written when it is not there. */
function realFolder(folder: string): string {
  try {
    return realpathSync.native(folder)
  } catch {
    return path.resolve(folder)
  }
}

/** Where `folder` sits against `other`. Windows and macOS folders ignore case by default. */
function folderRelation(folder: string, other: string): FolderRelation | undefined {
  const fold = (each: string) =>
    process.platform === 'linux' ? path.resolve(each) : path.resolve(each).toLowerCase()
  const a = fold(folder)
  const b = fold(other)
  if (a === b) return 'same'
  const within = (inner: string, outer: string) => {
    const relative = path.relative(outer, inner)
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  }
  if (within(a, b)) return 'inside'
  if (within(b, a)) return 'contains'
  return undefined
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'unknown error'
}
