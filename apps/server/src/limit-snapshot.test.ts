import type { ProviderId, ProviderLimitSource } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import {
  parseLimitFailures,
  parseLimitSnapshot,
  serializeLimitSnapshot,
  type SavedLimitFailure,
} from './limit-snapshot.js'

type Ready = Extract<ProviderLimitSource, { status: 'ready' }>

const codex: Ready = {
  provider: 'codex',
  status: 'ready',
  limits: [{ id: 'codex:primary', label: '5h', usedPercent: 12, resetsAt: 1_000 }],
  checkedAt: 500,
  origin: 'read',
}

describe('limit snapshot', () => {
  it('round-trips each provider’s last full read', () => {
    const saved = new Map<ProviderId, Ready>([['codex', codex]])
    expect(parseLimitSnapshot(serializeLimitSnapshot(saved))).toEqual(saved)
  })

  it('reads nothing from a missing, broken or differently shaped value', () => {
    expect(parseLimitSnapshot(undefined).size).toBe(0)
    expect(parseLimitSnapshot('{').size).toBe(0)
    expect(parseLimitSnapshot('[]').size).toBe(0)
    expect(parseLimitSnapshot(JSON.stringify({ version: 2, sources: [codex] })).size).toBe(0)
  })

  it('skips entries that are not a valid ready source', () => {
    const text = JSON.stringify({
      version: 1,
      sources: [
        codex,
        { provider: 'grok', status: 'unavailable' },
        {
          provider: 'claude-code',
          status: 'ready',
          limits: [{ label: 'Weekly', usedPercent: 140 }],
        },
        { provider: 'nobody', status: 'ready', limits: [] },
      ],
    })
    expect([...parseLimitSnapshot(text).keys()]).toEqual(['codex'])
  })

  it('round-trips each provider’s newest failed read beside the full reads', () => {
    const saved = new Map<ProviderId, Ready>([['codex', codex]])
    const failures = new Map<ProviderId, SavedLimitFailure>([
      [
        'claude-code',
        {
          error: 'Claude did not report plan limits this time.',
          count: 2,
          timeouts: 0,
          retryAt: 900_000,
        },
      ],
    ])
    const text = serializeLimitSnapshot(saved, failures)
    expect(parseLimitSnapshot(text)).toEqual(saved)
    expect(parseLimitFailures(text)).toEqual(failures)
    // Without failures the value keeps the shape older builds wrote.
    expect(JSON.parse(serializeLimitSnapshot(saved))).toEqual({ version: 1, sources: [codex] })
    expect(parseLimitFailures(serializeLimitSnapshot(saved)).size).toBe(0)
  })

  it('skips failures that are not valid', () => {
    const valid = { provider: 'grok', error: 'Grok billing request failed.', count: 1 }
    const text = JSON.stringify({
      version: 1,
      sources: [],
      failures: [
        { ...valid, timeouts: 0, retryAt: 300_000 },
        { ...valid, provider: 'nobody', timeouts: 0, retryAt: 1 },
        { ...valid, provider: 'codex', error: '', timeouts: 0, retryAt: 1 },
        { ...valid, provider: 'claude-code', timeouts: 0, retryAt: null },
        { ...valid, provider: 'cursor', count: 0, timeouts: 0, retryAt: 1 },
      ],
    })
    expect([...parseLimitFailures(text).keys()]).toEqual(['grok'])
    expect(parseLimitFailures(JSON.stringify({ version: 1, failures: [valid] })).size).toBe(0)
    expect(parseLimitFailures('{').size).toBe(0)
  })
})
