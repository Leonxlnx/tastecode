import type { ProviderId, ProviderLimitSource } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { parseLimitSnapshot, serializeLimitSnapshot } from './limit-snapshot.js'

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
})
