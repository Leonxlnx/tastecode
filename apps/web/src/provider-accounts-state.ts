import { createContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  DEFAULT_ACCOUNT_ID,
  type AccountId,
  type ProviderAccount,
  type ProviderAccountHome,
  type ProviderId,
  type ProviderStatus,
} from '@harness/contracts'
import { errorMessage } from './boundary.js'
import type { Transport } from './transport.js'

/** An account per provider, such as the one new chats start on. */
type AccountChoices = Partial<Record<ProviderId, AccountId>>
type AccountMap = Readonly<AccountChoices>

export type ProviderAccountsSnapshot = {
  /** `idle` until a view asks; `ready` once one list answered. */
  phase: 'idle' | 'loading' | 'ready' | 'error'
  accounts: readonly ProviderAccount[]
  /** The account a new chat with each provider starts on. Absent means `default`. */
  active: AccountMap
  /**
   * Providers whose new chats start on the account their limits recommend
   * (account-pool.ts), because the user has not picked one; `active` holds
   * it too. A new chat names this account when it starts.
   */
  preselected?: AccountMap
  /**
   * Providers whose account for new chats the user picked: picked in this
   * app, or a further account the server keeps active. A new chat names it,
   * so the server's own recommendation does not replace the pick.
   */
  picked?: AccountMap
  error?: string
}

/**
 * The account a new chat names in `thread.start`: a recommendation standing
 * in, or the user's pick. Undefined leaves the choice to the server, which
 * starts the chat on its recommended account, else on its active one.
 */
export function namedNewChatAccount(
  snapshot: ProviderAccountsSnapshot,
  provider: ProviderId,
): AccountId | undefined {
  return snapshot.preselected?.[provider] ?? snapshot.picked?.[provider]
}

const EMPTY: ProviderAccountsSnapshot = { phase: 'idle', accounts: [], active: {} }
const stores = new WeakMap<Transport, ProviderAccountsStore>()

/** The providers whose account for new chats the user picked; theirs is never preselected. */
export const ACCOUNT_CHOSEN_KEY = 'harness.newChatAccountChosen'

function readChosen(): Set<ProviderId> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ACCOUNT_CHOSEN_KEY) ?? '[]')
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((each): each is ProviderId => typeof each === 'string')
        : [],
    )
  } catch {
    return new Set()
  }
}

function writeChosen(chosen: ReadonlySet<ProviderId>): void {
  try {
    localStorage.setItem(ACCOUNT_CHOSEN_KEY, JSON.stringify([...chosen].sort()))
  } catch {
    // Kept for this session only; the server still keeps the active account.
  }
}

function sameAccounts(left: AccountMap, right: AccountMap): boolean {
  const keys = Object.keys(left) as ProviderId[]
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

/** A server from before accounts answers this; it runs every provider as its default account. */
function unknownMethod(error: unknown): boolean {
  return error instanceof Error && /^unknown method\b/i.test(error.message)
}

/**
 * The provider accounts the server keeps, for every provider that declares
 * `multipleAccounts`. Read while something shows them, kept current by
 * `accounts.changed`, and asked again after a reconnect. Nothing secret is
 * here: an account is a label, a folder and its last known identity.
 */
export class ProviderAccountsStore {
  readonly #transport: Transport
  readonly #listeners = new Set<() => void>()
  #state: ProviderAccountsSnapshot = EMPTY
  /** The active accounts as the server keeps them, with a local choice shown at once. */
  #kept: AccountMap = {}
  /** What the limits recommend for new chats, per provider with several accounts. */
  #recommended: AccountMap = {}
  /** Providers whose account for new chats the user picked in this app. */
  readonly #chosen: Set<ProviderId>
  #users = 0
  #detach: (() => void) | undefined
  #reading = false
  #again = false
  /** Bumped by every local active choice, so an older answer cannot undo it. */
  #choice = 0

  constructor(transport: Transport) {
    this.#transport = transport
    this.#chosen = readChosen()
  }

  snapshot = (): ProviderAccountsSnapshot => this.#state

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Keeps the list current while the returned release is not called. */
  retain(): () => void {
    this.#users += 1
    if (this.#users === 1) {
      const offChanged = this.#transport.on('accounts.changed', () => this.refresh())
      const offState = this.#transport.onState((state) => {
        if (state === 'open') this.refresh()
      })
      this.#detach = () => {
        offChanged()
        offState()
      }
      this.refresh()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.#users -= 1
      if (this.#users > 0) return
      this.#detach?.()
      this.#detach = undefined
    }
  }

  /** Reads the list; a burst while one read runs collapses into one more. */
  refresh(): void {
    if (this.#reading) {
      this.#again = true
      return
    }
    this.#reading = true
    this.#again = false
    if (this.#state.phase === 'idle') this.#set({ ...this.#state, phase: 'loading' })
    const choice = this.#choice
    void this.#transport.request('accounts.list', {}).then(
      (listed) => {
        const accounts = Array.isArray(listed?.accounts) ? listed.accounts : []
        // A choice made while this read ran is newer than its answer.
        const active = choice === this.#choice ? (listed?.active ?? {}) : this.#kept
        this.#set({ phase: 'ready', accounts, active })
        this.#settle()
      },
      (error: unknown) => {
        this.#set(
          unknownMethod(error)
            ? { phase: 'ready', accounts: [], active: {} }
            : {
                ...this.#state,
                active: this.#kept,
                phase: this.#state.phase === 'ready' ? 'ready' : 'error',
                error: errorMessage(error, 'Accounts could not be loaded.'),
              },
        )
        this.#settle()
      },
    )
  }

  async create(
    provider: ProviderId,
    label: string,
    home: ProviderAccountHome,
  ): Promise<ProviderAccount> {
    try {
      return (await this.#transport.request('accounts.create', { provider, label, home })).account
    } finally {
      this.refresh()
    }
  }

  async rename(provider: ProviderId, accountId: AccountId, label: string): Promise<void> {
    try {
      await this.#transport.request('accounts.rename', { provider, accountId, label })
    } finally {
      this.refresh()
    }
  }

  /** `deleteHome` also deletes a folder TasteCode created; the user asked for that separately. */
  async remove(provider: ProviderId, accountId: AccountId, deleteHome = false): Promise<void> {
    try {
      await this.#transport.request('accounts.remove', {
        provider,
        accountId,
        ...(deleteHome ? { deleteHome: true } : {}),
      })
    } finally {
      this.refresh()
    }
  }

  /**
   * The user's own pick of the account new chats start on. Shown at once; a
   * refused choice falls back to what the server keeps. From then on the
   * provider's recommended account no longer stands in for it.
   */
  async setActive(provider: ProviderId, accountId: AccountId): Promise<void> {
    this.#choice += 1
    if (!this.#chosen.has(provider)) {
      this.#chosen.add(provider)
      writeChosen(this.#chosen)
    }
    this.#set({ ...this.#state, active: { ...this.#kept, [provider]: accountId } })
    try {
      await this.#transport.request('accounts.setActive', { provider, accountId })
    } catch (error) {
      this.#choice += 1
      this.refresh()
      throw error
    }
  }

  /**
   * The accounts the limits recommend for new chats (`recommendedAccounts`).
   * Each stands in for its provider's active account until the user picks
   * one; nothing is sent to the server, and a new chat names the account
   * when it starts. Unchanged recommendations notify no one.
   */
  recommend(recommended: AccountMap): void {
    if (sameAccounts(recommended, this.#recommended)) return
    this.#recommended = { ...recommended }
    const next = this.#withRecommendations({ ...this.#state, active: this.#kept })
    if (
      sameAccounts(next.active, this.#state.active) &&
      sameAccounts(next.preselected ?? {}, this.#state.preselected ?? {})
    ) {
      return
    }
    this.#state = next
    this.#notify()
  }

  #settle(): void {
    this.#reading = false
    if (this.#again) this.refresh()
  }

  /** `state.active` is what the server keeps; the snapshot adds the recommendations. */
  #set(state: ProviderAccountsSnapshot): void {
    this.#kept = state.active
    this.#state = this.#withRecommendations(state)
    this.#notify()
  }

  /**
   * A recommendation stands in only where the user picked no account: a
   * further account active on the server was someone's choice, and so is
   * one picked here, the default account included.
   */
  #withRecommendations(state: ProviderAccountsSnapshot): ProviderAccountsSnapshot {
    const rest = { ...state }
    delete rest.preselected
    delete rest.picked
    const active = { ...state.active }
    const preselected: AccountChoices = {}
    const picked: AccountChoices = {}
    const providers = new Set([...(Object.keys(state.active) as ProviderId[]), ...this.#chosen])
    for (const provider of providers) {
      const kept = state.active[provider] ?? DEFAULT_ACCOUNT_ID
      if (kept !== DEFAULT_ACCOUNT_ID || this.#chosen.has(provider)) picked[provider] = kept
    }
    for (const provider of Object.keys(this.#recommended) as ProviderId[]) {
      const recommended = this.#recommended[provider]
      if (recommended === undefined || picked[provider] !== undefined) continue
      const listed = state.accounts.some(
        (account) => account.provider === provider && account.id === recommended,
      )
      if (!listed) continue
      active[provider] = recommended
      preselected[provider] = recommended
    }
    return {
      ...rest,
      active: Object.keys(preselected).length > 0 ? active : state.active,
      ...(Object.keys(preselected).length > 0 ? { preselected } : {}),
      ...(Object.keys(picked).length > 0 ? { picked } : {}),
    }
  }

  #notify(): void {
    for (const listener of this.#listeners) listener()
  }
}

export function providerAccountsStore(transport: Transport): ProviderAccountsStore {
  let store = stores.get(transport)
  if (!store) {
    store = new ProviderAccountsStore(transport)
    stores.set(transport, store)
  }
  return store
}

/** The providers that can run as more than their default account. */
export function multiAccountProviders(statuses: readonly ProviderStatus[]): ProviderStatus[] {
  return statuses.filter(
    (status) => status.installed && status.capabilities?.multipleAccounts === true,
  )
}

/** One provider's accounts, the default one first, as the server lists them. */
export function accountsOf(
  snapshot: ProviderAccountsSnapshot,
  provider: ProviderId,
): ProviderAccount[] {
  return snapshot.accounts.filter((account) => account.provider === provider)
}

export function activeAccountOf(
  snapshot: ProviderAccountsSnapshot,
  provider: ProviderId,
): AccountId {
  const active = snapshot.active[provider] ?? DEFAULT_ACCOUNT_ID
  return accountsOf(snapshot, provider).some((account) => account.id === active)
    ? active
    : DEFAULT_ACCOUNT_ID
}

/** Names a provider account where limits or usage are listed by account. */
export type AccountLabel = (provider: ProviderId, accountId: AccountId | undefined) => string

/** Names accounts where the app shows them deep in a view, such as a chat moving to one. */
export const AccountLabelContext = createContext<AccountLabel | undefined>(undefined)

/**
 * The account's own label, never its id. Usage can outlive an account, so an
 * id the server no longer lists reads as removed once the list is known.
 */
export function accountLabelOf(
  snapshot: ProviderAccountsSnapshot,
  provider: ProviderId,
  accountId: AccountId | undefined,
): string {
  const id = accountId ?? DEFAULT_ACCOUNT_ID
  const listed = snapshot.accounts.find(
    (account) => account.provider === provider && account.id === id,
  )
  if (listed) return listed.label
  if (id === DEFAULT_ACCOUNT_ID) return 'Default'
  return snapshot.phase === 'ready' ? 'Removed account' : 'Account'
}

/** How many account tones tokens.css defines (`--account-1` and on). */
export const ACCOUNT_TONES = 6

/**
 * What the app shows to tell a provider's accounts apart. The email stays out
 * of it: addresses stay in Settings > Providers, behind their reveal.
 */
export type AccountIdentity = {
  label: string
  plan?: string | undefined
  /**
   * 1 to `ACCOUNT_TONES`, by the account's place in its provider's list, which
   * starts with the default account. So a provider's first accounts never
   * share a tone and each keeps its own from day to day, whichever account a
   * chat happens to be on. 0, no colour, for an account the list does not hold.
   */
  tone: number
}

export function accountIdentityOf(
  snapshot: ProviderAccountsSnapshot,
  provider: ProviderId,
  accountId: AccountId | undefined,
): AccountIdentity {
  const accounts = accountsOf(snapshot, provider)
  const place = accounts.findIndex((account) => account.id === (accountId ?? DEFAULT_ACCOUNT_ID))
  return {
    label: accountLabelOf(snapshot, provider, accountId),
    plan: accounts[place]?.plan,
    tone: place < 0 ? 0 : (place % ACCOUNT_TONES) + 1,
  }
}

/**
 * The accounts snapshot, kept current while `enabled`: a view passes false
 * when no installed provider can have accounts, so nothing is asked.
 */
export function useProviderAccounts(transport: Transport, enabled: boolean) {
  const store = useMemo(() => providerAccountsStore(transport), [transport])
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  useEffect(() => (enabled ? store.retain() : undefined), [store, enabled])
  return { store, snapshot }
}
