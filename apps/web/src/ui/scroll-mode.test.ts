import { describe, expect, it } from 'vitest'
import { isAtBottom, modeForNewTurn, shouldReleaseAnchor } from './scroll-mode.js'

describe('scroll mode', () => {
  it('treats a small gap from the bottom as being at the bottom', () => {
    // Streaming resizes the last row constantly; an exact comparison would
    // flip out of follow mode on its own.
    expect(isAtBottom({ scrollTop: 940, scrollHeight: 1000, clientHeight: 40 })).toBe(true)
    expect(isAtBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 40 })).toBe(false)
  })

  it('anchors a new turn only when the user was already at the bottom', () => {
    expect(modeForNewTurn(true)).toBe('anchor-turn')
    // Someone reading older output must not be yanked to a new turn.
    expect(modeForNewTurn(false)).toBe('free')
  })

  it('releases the anchor once the turn is taller than the viewport', () => {
    expect(shouldReleaseAnchor(1200, 800)).toBe(true)
    expect(shouldReleaseAnchor(400, 800)).toBe(false)
  })
})
