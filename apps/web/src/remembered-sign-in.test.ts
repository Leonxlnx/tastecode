// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  lastSignIn,
  rememberedSignIn,
  rememberedSignInsVersion,
  rememberSignIn,
  SIGNED_IN_PROVIDERS_KEY,
  SIGNED_OUT_PROVIDERS_KEY,
  subscribeRememberedSignIns,
} from './remembered-sign-in.js'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('remembered sign-in', () => {
  it('remembers a signed-in read and forgets it after a signed-out one', () => {
    expect(rememberedSignIn('codex')).toBe(false)
    rememberSignIn('codex', true)
    rememberSignIn('claude-code', true)
    expect(rememberedSignIn('codex')).toBe(true)
    rememberSignIn('codex', false)
    expect(rememberedSignIn('codex')).toBe(false)
    expect(rememberedSignIn('claude-code')).toBe(true)
    expect(JSON.parse(localStorage.getItem(SIGNED_IN_PROVIDERS_KEY)!)).toEqual(['claude-code'])
  })

  it('keeps what the last read said, signed in or signed out, and tells subscribers', () => {
    const changed = vi.fn()
    const unsubscribe = subscribeRememberedSignIns(changed)
    const before = rememberedSignInsVersion()
    expect(lastSignIn('claude-code')).toBeUndefined()
    rememberSignIn('claude-code', false)
    expect(lastSignIn('claude-code')).toBe(false)
    expect(rememberedSignIn('claude-code')).toBe(false)
    expect(JSON.parse(localStorage.getItem(SIGNED_OUT_PROVIDERS_KEY)!)).toEqual(['claude-code'])
    rememberSignIn('claude-code', false)
    expect(changed).toHaveBeenCalledTimes(1)
    rememberSignIn('claude-code', true)
    expect(lastSignIn('claude-code')).toBe(true)
    expect(JSON.parse(localStorage.getItem(SIGNED_OUT_PROVIDERS_KEY)!)).toEqual([])
    expect(changed).toHaveBeenCalledTimes(2)
    expect(rememberedSignInsVersion()).toBe(before + 2)
    unsubscribe()
    rememberSignIn('claude-code', false)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('treats a damaged or blocked store as remembering nothing', () => {
    localStorage.setItem(SIGNED_IN_PROVIDERS_KEY, '{not json')
    expect(rememberedSignIn('codex')).toBe(false)
    localStorage.setItem(SIGNED_IN_PROVIDERS_KEY, JSON.stringify({ codex: true }))
    expect(rememberedSignIn('codex')).toBe(false)
    const blocked = () => {
      throw new Error('SecurityError')
    }
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked })
    expect(() => rememberSignIn('codex', true)).not.toThrow()
    expect(rememberedSignIn('codex')).toBe(false)
  })
})
