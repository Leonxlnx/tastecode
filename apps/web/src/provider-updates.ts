import { useMemo, useSyncExternalStore } from 'react'
import type { ProviderId, ProviderUpdate } from '@harness/contracts'
import {
  beginUpdate,
  clearInstall,
  installState,
  subscribeInstalls,
  updateKey,
} from './provider-install.js'
import type { Transport } from './transport.js'

export type UpdateOperation = {
  phase: 'starting' | 'running' | 'verifying' | 'succeeded' | 'failed'
  error?: string
}
type UpdateSnapshot = {
  updates: ProviderUpdate[]
  checking: boolean
  noticeRevision: number
  operations: Partial<Record<ProviderId, UpdateOperation>>
  error?: string | undefined
}
const stores = new WeakMap<Transport, ProviderUpdatesStore>()
const CHECK_INTERVAL = 60 * 60_000

export class ProviderUpdatesStore {
  #state: UpdateSnapshot = { updates: [], checking: false, noticeRevision: 0, operations: {} }
  #listeners = new Set<() => void>()
  #request: Promise<void> | undefined
  #checkedAt = 0

  constructor(private transport: Transport) {}

  snapshot = () => this.#state
  showNotice = () => this.#set({ noticeRevision: this.#state.noticeRevision + 1 })
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #set(patch: Partial<UpdateSnapshot>) {
    this.#state = { ...this.#state, ...patch }
    for (const listener of this.#listeners) listener()
  }

  refresh = (force = false): Promise<void> => {
    if (this.#request) return this.#request
    if (
      this.transport.state !== 'open' ||
      (!force && this.#checkedAt && Date.now() - this.#checkedAt < CHECK_INTERVAL)
    )
      return Promise.resolve()
    this.#set({ checking: true })
    this.#request = this.transport
      .request('providers.updates', { refresh: force })
      .then((result) => {
        this.#checkedAt = Date.now()
        const operations = { ...this.#state.operations }
        for (const update of result.updates) {
          const operation = operations[update.provider]
          const previous = this.#state.updates.find((entry) => entry.provider === update.provider)
          const current = Boolean(
            update.currentVersion &&
            update.latestVersion &&
            !update.error &&
            !update.updateAvailable,
          )
          if (
            (update.updateAvailable && operation?.phase === 'succeeded') ||
            (operation?.phase === 'failed' &&
              !update.error &&
              (current ||
                (previous?.latestVersion && previous.latestVersion !== update.latestVersion)))
          )
            delete operations[update.provider]
        }
        this.#state = { ...this.#state, updates: result.updates, operations, error: undefined }
      })
      .catch(() => {
        this.#state = { ...this.#state, error: 'Could not check for updates. Try again.' }
      })
      .finally(() => {
        this.#request = undefined
        this.#set({ checking: false })
      })
    return this.#request
  }

  monitor = () => {
    const check = () => {
      if (document.visibilityState !== 'hidden') void this.refresh()
    }
    check()
    const interval = setInterval(check, CHECK_INTERVAL)
    const off = this.transport.onState((state) => {
      if (state === 'open') check()
    })
    document.addEventListener('visibilitychange', check)
    return () => {
      clearInterval(interval)
      off()
      document.removeEventListener('visibilitychange', check)
    }
  }

  #operation(provider: ProviderId, operation: UpdateOperation) {
    this.#set({ operations: { ...this.#state.operations, [provider]: operation } })
  }

  start = async (provider: ProviderId): Promise<void> => {
    const phase = this.#state.operations[provider]?.phase
    if (phase === 'starting' || phase === 'running' || phase === 'verifying') return
    this.#operation(provider, { phase: 'starting' })
    const key = updateKey(provider)
    clearInstall(key)
    try {
      await beginUpdate(this.transport, provider)
      this.#operation(provider, { phase: 'running' })
      let handled = false
      let off = () => {}
      const settle = () => {
        const install = installState(key)
        if (handled || !install || install.phase === 'running') return
        handled = true
        off()
        if (install.phase === 'failed') {
          this.#operation(provider, {
            phase: 'failed',
            error: 'Update failed. Open details and try again.',
          })
          return
        }
        this.#operation(provider, { phase: 'verifying' })
        // A check started before the installer exited cannot verify its result.
        void (async () => {
          await this.#request
          await this.refresh(true)
          const result = this.#state.updates.find((entry) => entry.provider === provider)
          if (
            !this.#state.error &&
            result?.currentVersion &&
            result.latestVersion &&
            !result.error &&
            !result.updateAvailable
          ) {
            this.#operation(provider, { phase: 'succeeded' })
          } else {
            this.#operation(provider, {
              phase: 'failed',
              error: 'The new version could not be confirmed. Check details or try again.',
            })
          }
        })()
      }
      off = subscribeInstalls(settle)
      settle()
    } catch (error) {
      this.#operation(provider, {
        phase: 'failed',
        error: error instanceof Error ? error.message : 'Could not start the update.',
      })
    }
  }
}

export function useProviderUpdates(transport: Transport) {
  const store = useMemo(() => {
    let current = stores.get(transport)
    if (!current) {
      current = new ProviderUpdatesStore(transport)
      stores.set(transport, current)
    }
    return current
  }, [transport])
  const state = useSyncExternalStore(store.subscribe, store.snapshot)
  return { store, state }
}
