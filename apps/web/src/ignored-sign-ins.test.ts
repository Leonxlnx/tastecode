// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ignoreSignIn, signInKey, unignoreSignIn, useIgnoredSignIns } from './ignored-sign-ins.js'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

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

  it('keeps the choice for this run when storage is full', () => {
    const other = { provider: 'codex', home: '/Users/me/.codex work' } as const
    act(() => ignoreSignIn(other))
    const { result } = renderHook(() => useIgnoredSignIns())
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage full', 'QuotaExceededError')
    })

    // Storage still reads, and still holds the list from before the refused write.
    act(() => ignoreSignIn(side))
    expect(result.current).toEqual([signInKey(other), signInKey(side)])
    act(() => unignoreSignIn(other))
    expect(result.current).toEqual([signInKey(side)])

    setItem.mockRestore()
    act(() => unignoreSignIn(side))
    expect(result.current).toEqual([])
    expect(JSON.parse(localStorage.getItem('harness.ignoredSignIns.v1')!)).toEqual([])
  })

  it('tells one provider’s folder from another’s at the same path', () => {
    act(() => ignoreSignIn(side))
    const { result } = renderHook(() => useIgnoredSignIns())
    expect(result.current.includes(signInKey({ ...side, provider: 'claude-code' }))).toBe(false)
  })
})
