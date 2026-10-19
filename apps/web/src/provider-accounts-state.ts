import { useEffect, useMemo, useSyncExternalStore } from 'react'
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

export type ProviderAccountsSnapshot = {
  /** `idle` until a view asks; `ready` once one list answered. */
  phase: 'idle' | 'loading' | 'ready' | 'error'
  accounts: readonly ProviderAccount[]
  /** The account a new chat with each provider starts on. Absent means `default`. */
  active: Readonly<Partial<Record<ProviderId, AccountId>>>
  error?: string
}

const EMPTY: ProviderAccountsSnapshot = { phase: 'idle', accounts: [], active: {} }
const stores = new WeakMap<Transport, ProviderAccountsStore>()

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
  #users = 0
  #detach: (() => void) | undefined
  #reading = false
  #again = false
  /** Bumped by every local active choice, so an older answer cannot undo it. */
  #choice = 0

  constructor(transport: Transport) {
    this.#transport = transport
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
        const active = choice === this.#choice ? (listed?.active ?? {}) : this.#state.active
        this.#set({ phase: 'ready', accounts, active })
        this.#settle()
      },
      (error: unknown) => {
        this.#set(
          unknownMethod(error)
            ? { phase: 'ready', accounts: [], active: {} }
            : {
                ...this.#state,
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

  /** Shown at once; a refused choice falls back to what the server keeps. */
  async setActive(provider: ProviderId, accountId: AccountId): Promise<void> {
    this.#choice += 1
    this.#set({ ...this.#state, active: { ...this.#state.active, [provider]: accountId } })
    try {
      await this.#transport.request('accounts.setActive', { provider, accountId })
    } catch (error) {
      this.#choice += 1
      this.refresh()
      throw error
    }
  }

  #settle(): void {
    this.#reading = false
    if (this.#again) this.refresh()
  }

  #set(state: ProviderAccountsSnapshot): void {
    this.#state = state
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
