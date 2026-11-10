import { describe, expect, it } from 'vitest'
import { closestReasoningEffort } from './reasoning-effort.js'

describe('closestReasoningEffort', () => {
  it('keeps an effort the model lists, or any effort when it lists none', () => {
    expect(closestReasoningEffort('low', ['low', 'high'])).toBe('low')
    expect(closestReasoningEffort('low', [])).toBe('low')
    expect(closestReasoningEffort(undefined, ['high'])).toBeUndefined()
  })

  it('moves to the nearest listed effort, upward on a tie', () => {
    expect(closestReasoningEffort('low', ['medium', 'high', 'xhigh'])).toBe('medium')
    expect(closestReasoningEffort('xhigh', ['low', 'medium', 'high'])).toBe('high')
    expect(closestReasoningEffort('medium', ['low', 'high'])).toBe('high')
    expect(closestReasoningEffort('ultracode', ['low', 'high', 'max'])).toBe('max')
  })

  it('keeps a name it cannot place', () => {
    expect(closestReasoningEffort('turbo', ['low', 'high'])).toBe('turbo')
  })
})
