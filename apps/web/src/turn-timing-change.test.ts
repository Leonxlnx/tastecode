import { describe, expect, it } from 'vitest'
import {
  changedTurnTimingId,
  materializeTurnTiming,
  turnTimingKeys,
  updateTurnTiming,
  type TurnTimingRecord,
} from './turn-timing-change.js'

describe('turn timing copy-on-write layers', () => {
  it('adds an immutable timing without copying or changing the source record', () => {
    const source: TurnTimingRecord = { first: { startedAt: 1, completedAt: 2 } }
    const next = updateTurnTiming(source, 'second', { startedAt: 3 })

    expect(next).not.toBe(source)
    expect(source['second']).toBeUndefined()
    expect(next['first']).toEqual({ startedAt: 1, completedAt: 2 })
    expect(next['second']).toEqual({ startedAt: 3 })
    expect(changedTurnTimingId(next)).toBe('second')
  })

  it('shadows one turn without returning duplicate keys', () => {
    const started = updateTurnTiming({}, 'turn-1', { startedAt: 10 })
    const completed = updateTurnTiming(started, 'turn-1', {
      startedAt: 10,
      completedAt: 20,
    })

    expect(completed['turn-1']).toEqual({ startedAt: 10, completedAt: 20 })
    expect(turnTimingKeys(completed)).toEqual(['turn-1'])
    expect(Object.keys(completed)).toEqual(['turn-1'])
    expect({ ...completed }).toEqual({
      'turn-1': { startedAt: 10, completedAt: 20 },
    })
    expect(JSON.parse(JSON.stringify(completed))).toEqual({
      'turn-1': { startedAt: 10, completedAt: 20 },
    })
  })

  it('keeps old timings after crossing the bounded compaction depth', () => {
    let timing: TurnTimingRecord = { durable: { startedAt: 1, completedAt: 2 } }
    for (let index = 0; index < 260; index += 1) {
      timing = updateTurnTiming(timing, `turn-${index}`, { startedAt: index + 10 })
    }

    expect(timing['durable']).toEqual({ startedAt: 1, completedAt: 2 })
    expect(timing['turn-0']).toEqual({ startedAt: 10 })
    expect(timing['turn-259']).toEqual({ startedAt: 269 })
    expect(turnTimingKeys(timing)).toHaveLength(261)
  })

  it('materializes inherited timings into an independent flat record', () => {
    const source = updateTurnTiming(updateTurnTiming({}, 'turn-1', { startedAt: 1 }), 'turn-2', {
      startedAt: 2,
    })
    const materialized = materializeTurnTiming(source)

    expect(materialized).toEqual({
      'turn-1': { startedAt: 1 },
      'turn-2': { startedAt: 2 },
    })
    materialized['turn-1'] = { startedAt: 99 }
    expect(source['turn-1']).toEqual({ startedAt: 1 })
  })
})
