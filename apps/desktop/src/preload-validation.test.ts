import { describe, expect, it } from 'vitest'
import { isAppUpdateState, isFiniteNumber } from './preload-validation.js'

describe('preload validation', () => {
  it('accepts valid update states and finite zoom factors', () => {
    expect(
      isAppUpdateState({
        status: 'downloading',
        currentVersion: '0.1.0-beta.1',
        channel: 'beta',
        version: '0.1.0-beta.2',
        progress: 55,
      }),
    ).toBe(true)
    expect(isFiniteNumber(1.1)).toBe(true)
  })

  it('rejects malformed update states and non-finite zoom factors', () => {
    expect(isAppUpdateState({ status: 'ready', currentVersion: 1, channel: 'stable' })).toBe(false)
    expect(isAppUpdateState({ status: 'ready', currentVersion: '0.1.0' })).toBe(false)
    expect(isAppUpdateState({ status: 'ready', currentVersion: '0.1.0', channel: 'nightly' })).toBe(
      false,
    )
    expect(
      isAppUpdateState({ status: 'unknown', currentVersion: '0.1.0', channel: 'stable' }),
    ).toBe(false)
    expect(
      isAppUpdateState({
        status: 'downloading',
        currentVersion: '0.1.0',
        channel: 'stable',
        progress: Infinity,
      }),
    ).toBe(false)
    expect(isFiniteNumber(Number.NaN)).toBe(false)
    expect(isFiniteNumber(Infinity)).toBe(false)
  })
})
