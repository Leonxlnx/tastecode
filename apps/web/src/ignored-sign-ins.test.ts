// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ignoreSignIn, signInKey, unignoreSignIn, useIgnoredSignIns } from './ignored-sign-ins.js'

afterEach(() => localStorage.clear())

const side = { provider: 'codex', home: '/Users/me/.codex side' } as const

describe('ignored sign-ins', () => {
  it('keeps an ignored folder across reads until it is taken back', () => {
    const { result } = renderHook(() => useIgnoredSignIns())
    expect(result.current).toEqual([])

    act(() => ignoreSignIn(side))
    act(() => ignoreSignIn(side))
    expect(result.current).toEqual(['codex /Users/me/.codex side'])
    expect(JSON.parse(localStorage.getItem('harness.ignoredSignIns.v1')!)).toEqual([
      signInKey(side),
    ])

    act(() => unignoreSignIn(side))
    expect(result.current).toEqual([])
  })

  it('tells one provider’s folder from another’s at the same path', () => {
    act(() => ignoreSignIn(side))
    const { result } = renderHook(() => useIgnoredSignIns())
    expect(result.current.includes(signInKey({ ...side, provider: 'claude-code' }))).toBe(false)
  })
})
