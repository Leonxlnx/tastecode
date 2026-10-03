import type { AppUpdateState } from './bridge.js'

/**
 * A fake run of the desktop updater for the Debug settings. It replays the
 * state sequence the native controller publishes, so the sidebar button and
 * About render exactly what a real release would show. Nothing is downloaded
 * or installed.
 */
export type AppUpdateSimulation = 'update' | 'current' | 'failure'

export const SIMULATED_CHECK_MS = 1_500
export const SIMULATED_STEP_MS = 200
const STEP_PERCENT = 4
const FAILURE_PERCENT = 40

type Listener = (state: AppUpdateState | undefined) => void

const listeners = new Set<Listener>()
let scenario: AppUpdateSimulation = 'update'
let state: AppUpdateState | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let verdict:
  { promise: Promise<AppUpdateState>; resolve: (state: AppUpdateState) => void } | undefined

function publish(next: AppUpdateState | undefined) {
  state = next
  for (const listener of listeners) listener(next)
}

function cancel() {
  if (timer) clearTimeout(timer)
  timer = undefined
  const pending = verdict
  verdict = undefined
  if (pending && state) pending.resolve(state)
}

function nextVersion(version: string): string {
  const match = /(\d+)(?!.*\d)/.exec(version)
  if (!match?.[1]) return '1.0.0'
  const end = match.index + match[1].length
  return `${version.slice(0, match.index)}${Number(match[1]) + 1}${version.slice(end)}`
}

/** The simulated state, or undefined while the real updater is in charge. */
export function simulatedAppUpdate(): AppUpdateState | undefined {
  return state
}

/** Receives every simulated state, and undefined when the simulation ends. */
export function onSimulatedAppUpdate(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Resolves once the check has a verdict, like the native check does. */
export function startAppUpdateSimulation(
  next: AppUpdateSimulation,
  currentVersion: string,
): Promise<AppUpdateState> {
  cancel()
  scenario = next
  const version = nextVersion(currentVersion)
  let resolve!: (state: AppUpdateState) => void
  const promise = new Promise<AppUpdateState>((done) => {
    resolve = done
  })
  verdict = { promise, resolve }
  publish({ status: 'checking', currentVersion })

  const download = (progress: number) => {
    timer = undefined
    if (next === 'failure' && progress >= FAILURE_PERCENT) {
      publish({ status: 'error', currentVersion, error: 'Simulated download failure.' })
    } else if (progress >= 100) {
      publish({ status: 'ready', currentVersion, version })
    } else {
      publish({ status: 'downloading', currentVersion, version, progress })
      timer = setTimeout(() => download(progress + STEP_PERCENT), SIMULATED_STEP_MS)
    }
  }
  timer = setTimeout(() => {
    timer = undefined
    if (next === 'current') publish({ status: 'current', currentVersion, version: currentVersion })
    else download(0)
    const pending = verdict
    verdict = undefined
    if (state) pending?.resolve(state)
  }, SIMULATED_CHECK_MS)
  return promise
}

export function checkSimulatedAppUpdate(): Promise<AppUpdateState> {
  if (!state) return Promise.reject(new Error('No app update simulation is running.'))
  if (verdict) return verdict.promise
  if (state.status === 'downloading' || state.status === 'ready') return Promise.resolve(state)
  // Retrying the failure succeeds, so one run shows both the error and the recovery.
  return startAppUpdateSimulation(
    scenario === 'failure' ? 'update' : scenario,
    state.currentVersion,
  )
}

export function stopAppUpdateSimulation(): void {
  cancel()
  if (state) publish(undefined)
}
