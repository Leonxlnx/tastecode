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
  /** Shared by every phase of one update attempt; each phase is a new object. */
  run: number
  phase: 'starting' | 'running' | 'verifying' | 'succeeded' | 'failed'
  error?: string
  /** Played by the Debug simulation; nothing was installed. */
  simulated?: true
}
type Operations = Partial<Record<ProviderId, UpdateOperation>>
type UpdateSnapshot = {
  updates: ProviderUpdate[]
  checking: boolean
  noticeRevision: number
  operations: Operations
  error?: string | undefined
  /** Set while Debug shows made-up releases in place of the real ones. */
  simulation?: ProviderUpdateSimulation | undefined
}
const stores = new WeakMap<Transport, ProviderUpdatesStore>()
const CHECK_INTERVAL = 60 * 60_000

/**
 * Debug-only releases for the update notice. `one` and `several` succeed;
 * `failure` fails each provider's first attempt so a retry shows recovery.
 */
export type ProviderUpdateSimulation = 'one' | 'several' | 'failure'
export const SIMULATED_START_MS = 300
export const SIMULATED_INSTALL_MS = 2_400
export const SIMULATED_VERIFY_MS = 600

const SIMULATED_PROVIDERS: ProviderUpdate[] = [
  {
    provider: 'codex',
    displayName: 'Codex',
    currentVersion: '0.158.0',
    updateAvailable: true,
    canUpdate: true,
    updateUrl: 'https://developers.openai.com/codex/cli',
  },
  {
    provider: 'claude-code',
    displayName: 'Claude Code',
    currentVersion: '2.0.14',
    updateAvailable: true,
    canUpdate: true,
    updateUrl: 'https://code.claude.com/docs/en/getting-started',
  },
  {
    provider: 'grok',
    displayName: 'Grok',
    currentVersion: '1.0.45',
    updateAvailable: true,
    canUpdate: true,
    updateUrl: 'https://x.ai/cli',
  },
]

/** A minor release after `x.y.0`, a patch otherwise, the way the CLIs ship. */
function nextVersion(version: string): string {
  const minor = /^(\d+)\.(\d+)\.0$/.exec(version)
  if (minor?.[1] && minor[2]) return `${minor[1]}.${Number(minor[2]) + 1}.0`
  const match = /(\d+)(?!.*\d)/.exec(version)
  if (!match?.[1]) return '1.0.0'
  const end = match.index + match[1].length
  return `${version.slice(0, match.index)}${Number(match[1]) + 1}${version.slice(end)}`
}

/** Releases one step past what is installed, so the wheels turn real numbers. */
export function simulatedUpdates(
  scenario: ProviderUpdateSimulation,
  installed: readonly ProviderUpdate[],
): ProviderUpdate[] {
  const providers = scenario === 'one' ? SIMULATED_PROVIDERS.slice(0, 1) : SIMULATED_PROVIDERS
  return providers.map((fallback) => {
    const real = installed.find((entry) => entry.provider === fallback.provider)
    const currentVersion = real?.currentVersion ?? fallback.currentVersion!
    return {
      ...fallback,
      displayName: real?.displayName ?? fallback.displayName,
      currentVersion,
      latestVersion: nextVersion(currentVersion),
    }
  })
}

export class ProviderUpdatesStore {
  #state: UpdateSnapshot = { updates: [], checking: false, noticeRevision: 0, operations: {} }
  #listeners = new Set<() => void>()
  #request: Promise<void> | undefined
  #checkedAt = 0
  #runs = 0
  /** The real releases and runs, set aside while a simulation is shown. */
  #real: { updates: ProviderUpdate[]; operations: Operations } | undefined
  #simulationTimers = new Set<ReturnType<typeof setTimeout>>()
  #failOnce = new Set<ProviderId>()

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
        const real = this.#real ?? this.#state
        const operations = { ...real.operations }
        for (const update of result.updates) {
          const operation = operations[update.provider]
          const previous = real.updates.find((entry) => entry.provider === update.provider)
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
        if (this.#real) {
          this.#real = { updates: result.updates, operations }
          this.#state = { ...this.#state, error: undefined }
        } else {
          this.#state = { ...this.#state, updates: result.updates, operations, error: undefined }
        }
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
    // A real update keeps running behind a simulation and lands out of sight.
    if (this.#real && !operation.simulated) {
      this.#real = {
        ...this.#real,
        operations: { ...this.#real.operations, [provider]: operation },
      }
      return
    }
    this.#set({ operations: { ...this.#state.operations, [provider]: operation } })
  }

  simulate = (scenario: ProviderUpdateSimulation) => {
    this.#clearSimulationTimers()
    this.#real ??= { updates: this.#state.updates, operations: this.#state.operations }
    const updates = simulatedUpdates(scenario, this.#real.updates)
    this.#failOnce = new Set(scenario === 'failure' ? updates.map((update) => update.provider) : [])
    this.#set({ simulation: scenario, updates, operations: {} })
  }

  stopSimulation = () => {
    const real = this.#real
    if (!real) return
    this.#clearSimulationTimers()
    this.#real = undefined
    this.#set({ simulation: undefined, ...real })
  }

  #clearSimulationTimers() {
    for (const timer of this.#simulationTimers) clearTimeout(timer)
    this.#simulationTimers.clear()
  }

  #after(ms: number, step: () => void) {
    const timer = setTimeout(() => {
      this.#simulationTimers.delete(timer)
      step()
    }, ms)
    this.#simulationTimers.add(timer)
  }

  /** The same phases a real update passes through, on a timer. */
  #simulateRun(provider: ProviderId) {
    const run = ++this.#runs
    const fails = this.#failOnce.delete(provider)
    const operation = (phase: UpdateOperation['phase'], error?: string) =>
      this.#operation(provider, { run, phase, simulated: true, ...(error ? { error } : {}) })
    operation('starting')
    this.#after(SIMULATED_START_MS, () => {
      operation('running')
      this.#after(SIMULATED_INSTALL_MS, () => {
        if (fails) return operation('failed', 'Simulated update failure. Try again.')
        operation('verifying')
        this.#after(SIMULATED_VERIFY_MS, () => {
          // As after a real install, the check reports the new version first.
          this.#set({
            updates: this.#state.updates.map((update) =>
              update.provider === provider
                ? { ...update, currentVersion: update.latestVersion, updateAvailable: false }
                : update,
            ),
          })
          operation('succeeded')
        })
      })
    })
  }

  start = async (provider: ProviderId): Promise<void> => {
    const phase = this.#state.operations[provider]?.phase
    if (phase === 'starting' || phase === 'running' || phase === 'verifying') return
    if (this.#real) return this.#simulateRun(provider)
    const run = ++this.#runs
    this.#operation(provider, { run, phase: 'starting' })
    const key = updateKey(provider)
    clearInstall(key)
    try {
      await beginUpdate(this.transport, provider)
      this.#operation(provider, { run, phase: 'running' })
      let handled = false
      let off = () => {}
      const settle = () => {
        const install = installState(key)
        if (handled || !install || install.phase === 'running') return
        handled = true
        off()
        if (install.phase === 'failed') {
          this.#operation(provider, {
            run,
            phase: 'failed',
            error: 'Update failed. Open details and try again.',
          })
          return
        }
        this.#operation(provider, { run, phase: 'verifying' })
        // A check started before the installer exited cannot verify its result.
        void (async () => {
          await this.#request
          await this.refresh(true)
          const result = (this.#real ?? this.#state).updates.find(
            (entry) => entry.provider === provider,
          )
          if (
            !this.#state.error &&
            result?.currentVersion &&
            result.latestVersion &&
            !result.error &&
            !result.updateAvailable
          ) {
            this.#operation(provider, { run, phase: 'succeeded' })
          } else {
            this.#operation(provider, {
              run,
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
        run,
        phase: 'failed',
        error: error instanceof Error ? error.message : 'Could not start the update.',
      })
    }
  }
}

/** The one store per connection that the notice, Settings and Debug share. */
export function providerUpdatesStore(transport: Transport): ProviderUpdatesStore {
  let current = stores.get(transport)
  if (!current) {
    current = new ProviderUpdatesStore(transport)
    stores.set(transport, current)
  }
  return current
}

export function useProviderUpdates(transport: Transport) {
  const store = useMemo(() => providerUpdatesStore(transport), [transport])
  const state = useSyncExternalStore(store.subscribe, store.snapshot)
  return { store, state }
}
