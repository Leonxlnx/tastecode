// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MODEL_RECENTS_KEY,
  readModelRecents,
  recordModelRecent,
  subscribeModelRecents,
} from './model-recents.js'

afterEach(() => {
  localStorage.removeItem(MODEL_RECENTS_KEY)
  vi.restoreAllMocks()
})

describe('model recents', () => {
  it('keeps the pairs a message left with, newest first, each pair once', () => {
    recordModelRecent({ key: 'claude-code:opus-5.5', effort: 'high' }, 1)
    recordModelRecent({ key: 'codex:gpt-6-astra', effort: 'xhigh', serviceTier: 'priority' }, 2)
    recordModelRecent({ key: 'claude-code:opus-5.5', effort: 'high' }, 3)

    expect(readModelRecents()).toEqual([
      { key: 'claude-code:opus-5.5', effort: 'high', at: 3 },
      { key: 'codex:gpt-6-astra', effort: 'xhigh', serviceTier: 'priority', at: 2 },
    ])
  })

  it('counts the same model at another effort as another pair, and keeps four', () => {
    for (const [index, effort] of ['low', 'medium', 'high', 'xhigh', 'max'].entries()) {
      recordModelRecent({ key: 'codex:gpt-6-astra', effort }, index)
    }
    expect(readModelRecents().map((recent) => recent.effort)).toEqual([
      'max',
      'xhigh',
      'high',
      'medium',
    ])
  })

  it('reads nothing from a damaged or foreign value', () => {
    localStorage.setItem(MODEL_RECENTS_KEY, '{nope')
    expect(readModelRecents()).toEqual([])
    localStorage.setItem(
      MODEL_RECENTS_KEY,
      JSON.stringify([{ key: 7 }, { key: 'codex:x', at: 'yesterday' }, { key: 'codex:y', at: 5 }]),
    )
    expect(readModelRecents()).toEqual([{ key: 'codex:y', at: 5 }])
  })

  it('hands back the same list until it changes, and tells subscribers when it does', () => {
    recordModelRecent({ key: 'grok:grok-build' }, 1)
    expect(readModelRecents()).toBe(readModelRecents())
    const onChange = vi.fn()
    const unsubscribe = subscribeModelRecents(onChange)
    recordModelRecent({ key: 'grok:grok-5' }, 2)
    expect(onChange).toHaveBeenCalledTimes(1)
    unsubscribe()
    recordModelRecent({ key: 'grok:grok-build' }, 3)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('keeps the pairs for the session when site data is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    recordModelRecent({ key: 'codex:gpt-6-astra', effort: 'low' }, 1)
    expect(readModelRecents()).toEqual([{ key: 'codex:gpt-6-astra', effort: 'low', at: 1 }])
  })
})
