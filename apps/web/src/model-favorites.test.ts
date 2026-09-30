// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MODEL_FAVORITES_KEY,
  readModelFavorites,
  subscribeModelFavorites,
  toggleModelFavorite,
} from './model-favorites.js'

afterEach(() => {
  vi.restoreAllMocks()
  for (const key of readModelFavorites()) toggleModelFavorite(key)
  localStorage.clear()
})

describe('model favorites', () => {
  it('toggles keys in star order and notifies subscribers', () => {
    const onChange = vi.fn()
    const unsubscribe = subscribeModelFavorites(onChange)

    toggleModelFavorite('codex:gpt-5.6-sol')
    toggleModelFavorite('claude-code:sonnet')
    expect(readModelFavorites()).toEqual(['codex:gpt-5.6-sol', 'claude-code:sonnet'])
    toggleModelFavorite('codex:gpt-5.6-sol')

    expect(readModelFavorites()).toEqual(['claude-code:sonnet'])
    expect(JSON.parse(localStorage.getItem(MODEL_FAVORITES_KEY) ?? '[]')).toEqual([
      'claude-code:sonnet',
    ])
    expect(onChange).toHaveBeenCalledTimes(3)
    unsubscribe()
  })

  it('returns the same array until the stored value changes', () => {
    localStorage.setItem(MODEL_FAVORITES_KEY, JSON.stringify(['codex:gpt-5.6-sol']))
    const first = readModelFavorites()

    expect(readModelFavorites()).toBe(first)
    localStorage.setItem(MODEL_FAVORITES_KEY, JSON.stringify([]))
    expect(readModelFavorites()).not.toBe(first)
  })

  it('ignores stored values that are not a list of keys', () => {
    localStorage.setItem(MODEL_FAVORITES_KEY, '{not json')
    expect(readModelFavorites()).toEqual([])
    localStorage.setItem(MODEL_FAVORITES_KEY, JSON.stringify(['codex:a', 7, null]))
    expect(readModelFavorites()).toEqual(['codex:a'])
  })

  it('keeps stars for the session when storage rejects the write', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError')
    })

    toggleModelFavorite('codex:gpt-5.6-sol')

    expect(localStorage.getItem(MODEL_FAVORITES_KEY)).toBeNull()
    expect(readModelFavorites()).toEqual(['codex:gpt-5.6-sol'])
  })
})
