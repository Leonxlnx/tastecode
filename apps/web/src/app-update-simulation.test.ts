import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppUpdateState } from './bridge.js'
import {
  checkSimulatedAppUpdate,
  onSimulatedAppUpdate,
  SIMULATED_CHECK_MS,
  SIMULATED_STEP_MS,
  simulatedAppUpdate,
  startAppUpdateSimulation,
  stopAppUpdateSimulation,
} from './app-update-simulation.js'

let states: Array<AppUpdateState | undefined>
let off: () => void

beforeEach(() => {
  vi.useFakeTimers()
  states = []
  off = onSimulatedAppUpdate((state) => states.push(state))
})

afterEach(() => {
  stopAppUpdateSimulation()
  off()
  vi.useRealTimers()
})

const statuses = () => states.map((state) => state?.status)

it('replays a release from check through download to a ready restart', async () => {
  const verdict = startAppUpdateSimulation('update', '0.1.2')
  expect(simulatedAppUpdate()).toEqual({ status: 'checking', currentVersion: '0.1.2' })

  await vi.advanceTimersByTimeAsync(SIMULATED_CHECK_MS)
  await expect(verdict).resolves.toEqual({
    status: 'downloading',
    currentVersion: '0.1.2',
    version: '0.1.3',
    progress: 0,
  })
  await vi.advanceTimersByTimeAsync(SIMULATED_STEP_MS * 25)

  expect(simulatedAppUpdate()).toEqual({
    status: 'ready',
    currentVersion: '0.1.2',
    version: '0.1.3',
  })
  expect(states.filter((state) => state?.status === 'downloading').length).toBe(25)
  await expect(checkSimulatedAppUpdate()).resolves.toMatchObject({ status: 'ready' })
})

it('fails partway and lets the retry succeed', async () => {
  void startAppUpdateSimulation('failure', '0.1.0-beta.6')
  await vi.advanceTimersByTimeAsync(SIMULATED_CHECK_MS + SIMULATED_STEP_MS * 10)

  expect(simulatedAppUpdate()).toMatchObject({ status: 'error', error: expect.any(String) })
  expect(states.at(-2)).toMatchObject({ version: '0.1.0-beta.7', progress: 36 })

  const retry = checkSimulatedAppUpdate()
  await vi.advanceTimersByTimeAsync(SIMULATED_CHECK_MS + SIMULATED_STEP_MS * 25)
  await expect(retry).resolves.toMatchObject({ status: 'downloading' })
  expect(simulatedAppUpdate()?.status).toBe('ready')
})

it('reports an up-to-date check and stops back to the real updater', async () => {
  const verdict = startAppUpdateSimulation('current', 'pre-release')
  await vi.advanceTimersByTimeAsync(SIMULATED_CHECK_MS)
  await expect(verdict).resolves.toEqual({
    status: 'current',
    currentVersion: 'pre-release',
    version: 'pre-release',
  })

  stopAppUpdateSimulation()
  expect(statuses()).toEqual(['checking', 'current', undefined])
  expect(simulatedAppUpdate()).toBeUndefined()
  await expect(checkSimulatedAppUpdate()).rejects.toThrow()
})

it('settles a pending check when the simulation is stopped or replaced', async () => {
  const stopped = startAppUpdateSimulation('update', '1.0.0')
  stopAppUpdateSimulation()
  await expect(stopped).resolves.toMatchObject({ status: 'checking' })

  const replaced = startAppUpdateSimulation('update', '1.0.0')
  void startAppUpdateSimulation('current', '1.0.0')
  await expect(replaced).resolves.toMatchObject({ status: 'checking' })
  await vi.advanceTimersByTimeAsync(SIMULATED_CHECK_MS + SIMULATED_STEP_MS * 30)
  expect(simulatedAppUpdate()?.status).toBe('current')
})
