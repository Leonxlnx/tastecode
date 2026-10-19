// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rememberedSignIn, rememberSignIn, SIGNED_IN_PROVIDERS_KEY } from './remembered-sign-in.js'

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
