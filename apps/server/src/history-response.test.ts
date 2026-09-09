import { describe, expect, it } from 'vitest'
import type { DomainEvent } from '@harness/contracts'
import { createHistoryResponseProjector } from './history-response.js'

const event: DomainEvent = {
  type: 'turn.completed',
  turnId: 'turn-1',
  status: 'completed',
}

describe('history response projector', () => {
  it('reuses one immutable replay per running state', () => {
    const project = createHistoryResponseProjector()
    const events = [{ seq: 1, event }]
    const idle = project(events, false)

    expect(project(events, false)).toBe(idle)
    expect(project(events, true)).not.toBe(idle)
    expect(project([...events], false)).not.toBe(idle)
  })
})
