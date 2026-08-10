import { describe, expect, it } from 'vitest'
import { mapClaudeUsage } from './limits.js'

describe('mapClaudeUsage', () => {
  it('maps the session and weekly windows with reset times', () => {
    const rows = mapClaudeUsage({
      five_hour: { utilization: 42.5, resets_at: '2026-08-11T10:00:00Z' },
      seven_day: { utilization: '80', resets_at: '2026-08-14T00:00:00Z' },
    })
    expect(rows).toEqual([
      { label: 'Session', usedPercent: 42.5, resetsAt: Date.parse('2026-08-11T10:00:00Z') },
      { label: 'Weekly', usedPercent: 80, resetsAt: Date.parse('2026-08-14T00:00:00Z') },
    ])
  })

  it('clamps runaway utilization and skips windows without a number', () => {
    const rows = mapClaudeUsage({
      five_hour: { utilization: 130 },
      seven_day: { utilization: 'soon' },
      seven_day_sonnet: null,
    })
    expect(rows).toEqual([{ label: 'Session', usedPercent: 100 }])
  })

  it('adds per-model weekly windows from the limits array without duplicating', () => {
    const rows = mapClaudeUsage({
      seven_day: { utilization: 10 },
      limits: [
        {
          kind: 'weekly_scoped',
          percent: 55,
          resets_at: '2026-08-14T00:00:00Z',
          scope: { model: { display_name: 'fable' } },
        },
        { kind: 'session', percent: 99 },
        { kind: 'weekly_scoped', percent: 12, scope: { model: { display_name: 'fable' } } },
      ],
    })
    expect(rows).toEqual([
      { label: 'Weekly', usedPercent: 10 },
      { label: 'Fable weekly', usedPercent: 55, resetsAt: Date.parse('2026-08-14T00:00:00Z') },
    ])
  })

  it('returns nothing for junk bodies', () => {
    expect(mapClaudeUsage(undefined)).toEqual([])
    expect(mapClaudeUsage('nope')).toEqual([])
    expect(mapClaudeUsage({})).toEqual([])
  })
})
