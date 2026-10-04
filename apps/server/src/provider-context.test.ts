import { describe, expect, it } from 'vitest'
import type { ContextControl } from '@harness/contracts'
import {
  contextForLaunch,
  providerContextControl,
  validateContextSettings,
} from './provider-context.js'

const twoWindows: ContextControl = {
  windows: [200_000, 1_000_000],
  compaction: true,
  compactionOff: true,
  defaultCompactAt: 93,
  latestCompactAt: 93,
}

const fixedWindow: ContextControl = {
  windows: [256_000],
  compaction: true,
  compactionOff: false,
  defaultCompactAt: 80,
}

describe('provider context controls', () => {
  it.each(['cursor', 'opencode', 'antigravity', 'pi', 'acp', 'api'] as const)(
    'leaves %s context decisions with the engine when it declares no controls',
    (provider) => {
      expect(providerContextControl(provider)).toBeUndefined()
      expect(() =>
        validateContextSettings(providerContextControl(provider), { compactAt: 50 }),
      ).toThrow()
      expect(contextForLaunch(providerContextControl(provider), { compactAt: 50 })).toBeUndefined()
    },
  )

  it('reads what each shipped adapter declared', () => {
    expect(providerContextControl('codex')).toMatchObject({ latestCompactAt: 90 })
    expect(providerContextControl('claude-code')).toMatchObject({
      compactionOff: true,
      latestCompactAt: 93,
    })
    expect(providerContextControl('grok')).toMatchObject({
      windows: [256_000],
      compactionOff: false,
    })
  })
})

describe('validateContextSettings', () => {
  it('accepts what the provider declared, including no setting at all', () => {
    expect(() => validateContextSettings(twoWindows, {})).not.toThrow()
    expect(() =>
      validateContextSettings(twoWindows, { window: 1_000_000, compactAt: 60 }),
    ).not.toThrow()
    expect(() => validateContextSettings(twoWindows, { compactAt: 'off' })).not.toThrow()
    expect(() => validateContextSettings(twoWindows, { compactAt: 93 })).not.toThrow()
  })

  it('refuses a window, switch or compaction point the provider cannot honour', () => {
    expect(() => validateContextSettings(twoWindows, { window: 500_000 })).toThrow(
      'cannot run with a 500000-token context window',
    )
    expect(() => validateContextSettings(fixedWindow, { compactAt: 'off' })).toThrow(
      'cannot switch automatic compaction off',
    )
    expect(() =>
      validateContextSettings({ ...fixedWindow, compaction: false }, { compactAt: 50 }),
    ).toThrow('decides on its own when to compact')
    expect(() => validateContextSettings(twoWindows, { compactAt: 94 })).toThrow(
      'cannot compact later than 93%',
    )
    expect(() => validateContextSettings(undefined, { window: 200_000 })).toThrow()
  })

  it('lets a provider without a latest point compact anywhere the contract allows', () => {
    expect(() => validateContextSettings(fixedWindow, { compactAt: 99 })).not.toThrow()
  })
})

describe('contextForLaunch', () => {
  it('passes declared settings through unchanged', () => {
    expect(contextForLaunch(twoWindows, { window: 1_000_000, compactAt: 'off' })).toEqual({
      window: 1_000_000,
      compactAt: 'off',
    })
    expect(contextForLaunch(fixedWindow, { compactAt: 70 })).toEqual({ compactAt: 70 })
  })

  it('drops what the engine can no longer honour instead of failing the launch', () => {
    expect(contextForLaunch(twoWindows, { window: 500_000, compactAt: 60 })).toEqual({
      compactAt: 60,
    })
    expect(contextForLaunch(twoWindows, { window: 200_000, compactAt: 97 })).toEqual({
      window: 200_000,
    })
    expect(contextForLaunch(fixedWindow, { compactAt: 'off' })).toBeUndefined()
    expect(
      contextForLaunch({ ...fixedWindow, compaction: false }, { compactAt: 50 }),
    ).toBeUndefined()
  })

  it('launches with nothing when there is no control or no setting', () => {
    expect(contextForLaunch(undefined, { compactAt: 70 })).toBeUndefined()
    expect(contextForLaunch(twoWindows, undefined)).toBeUndefined()
    expect(contextForLaunch(twoWindows, {})).toBeUndefined()
  })
})
