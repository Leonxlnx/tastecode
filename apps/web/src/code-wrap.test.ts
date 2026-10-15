// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyCodeWrap,
  CODE_WRAP_KEY,
  readCodeWrap,
  subscribeCodeWrap,
  writeCodeWrap,
} from './code-wrap.js'

afterEach(() => {
  vi.restoreAllMocks()
  writeCodeWrap(false)
  localStorage.clear()
})

describe('code wrap preference', () => {
  it('starts unwrapped and remembers the choice on the document root and in storage', () => {
    expect(readCodeWrap()).toBe(false)
    applyCodeWrap()
    expect(document.documentElement.dataset.codeWrap).toBeUndefined()

    const changed = vi.fn()
    const unsubscribe = subscribeCodeWrap(changed)
    writeCodeWrap(true)
    expect(readCodeWrap()).toBe(true)
    expect(localStorage.getItem(CODE_WRAP_KEY)).toBe('on')
    expect(document.documentElement.dataset.codeWrap).toBe('on')
    expect(changed).toHaveBeenCalledOnce()

    unsubscribe()
    writeCodeWrap(false)
    expect(document.documentElement.dataset.codeWrap).toBeUndefined()
    expect(localStorage.getItem(CODE_WRAP_KEY)).toBe('off')
    expect(changed).toHaveBeenCalledOnce()
  })

  it('applies a stored choice at startup', () => {
    localStorage.setItem(CODE_WRAP_KEY, 'on')
    applyCodeWrap()
    expect(document.documentElement.dataset.codeWrap).toBe('on')
  })

  it('keeps the choice for the session when storage is blocked', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    writeCodeWrap(true)
    expect(readCodeWrap()).toBe(true)
    expect(document.documentElement.dataset.codeWrap).toBe('on')
  })
})
