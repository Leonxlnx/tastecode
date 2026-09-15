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
    const idle = project(events, false, 'ask')

    expect(project(events, false, 'ask')).toBe(idle)
    expect(project(events, false, 'full')).not.toBe(idle)
    expect(project(events, true, 'ask')).not.toBe(idle)
    expect(project([...events], false, 'ask')).not.toBe(idle)
  })
})
