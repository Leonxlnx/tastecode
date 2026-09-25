import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseCursorModels } from './adapter.js'
import { getCursorIndex, resolveCursorModel } from './models.js'

/**
 * Everything here runs against the full listing captured from the real
 * binary (fixtures/cursor-models-2026-08-07.txt). The suffix grammar is
 * irregular — `xhigh` vs `extra-high`, `-thinking` on either side of the
 * effort — so the fixture, not a synthetic sample, is the contract.
 */

const capture = readFileSync(
  new URL('./fixtures/cursor-models-2026-08-07.txt', import.meta.url),
  'utf8',
)

function rawIds(): Set<string> {
  const ids = new Set<string>()
  for (const line of capture.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+) - /)
    if (match && match[1] !== 'auto') ids.add(match[1]!)
  }
  return ids
}

describe('cursor model catalog', () => {
  it('lists every model the CLI exposes, including effort and fast variants', () => {
    const models = parseCursorModels(capture)
    const listed = ['auto', ...rawIds()]

    expect(models.map((model) => model.id)).toEqual(listed)
    expect(models.every((model) => model.reasoningEfforts.length === 0)).toBe(true)
    expect(models.every((model) => model.serviceTiers.length === 0)).toBe(true)
    expect(models.find((model) => model.id === 'gpt-5.3-codex-xhigh-fast')).toMatchObject({
      displayName: 'Codex 5.3 Extra High Fast',
      isDefault: false,
    })
    expect(models.find((model) => model.id === 'auto')).toMatchObject({
      displayName: 'Auto',
      isDefault: true,
    })
  })

  it('keeps the extra-high row and still resolves a legacy slider selection', () => {
    const models = parseCursorModels(capture)
    expect(models.find((model) => model.id === 'gpt-5.5-extra-high')).toMatchObject({
      displayName: 'GPT-5.5 1M Extra High',
    })
    expect(models.find((model) => model.id === 'gpt-5.5-medium')).toMatchObject({
      displayName: 'GPT-5.5 1M',
      reasoningEfforts: [],
    })
    // gpt-5.5-extra-high-fast exists; a stored base id plus xhigh/fast must find it.
    expect(resolveCursorModel(getCursorIndex(), 'gpt-5.5-medium', 'xhigh', 'fast')).toBe(
      'gpt-5.5-extra-high-fast',
    )
  })

  it('keeps thinking modes as their own rows regardless of suffix position', () => {
    const models = parseCursorModels(capture)
    expect(models.find((model) => model.id === 'claude-4.6-sonnet-medium')).toMatchObject({
      displayName: 'Sonnet 4.6 1M',
      reasoningEfforts: [],
    })
    expect(models.find((model) => model.id === 'claude-4.6-sonnet-medium-thinking')).toMatchObject({
      displayName: 'Sonnet 4.6 1M Thinking',
    })
    expect(models.find((model) => model.id === 'claude-opus-5-thinking-high')).toMatchObject({
      displayName: 'Opus 5 1M Thinking',
      reasoningEfforts: [],
    })
    expect(models.find((model) => model.id === 'claude-opus-5-thinking-xhigh')).toMatchObject({
      displayName: 'Opus 5 1M Extra High Thinking',
    })
  })

  it('keeps the vendor display name on every variant', () => {
    const models = parseCursorModels(capture)
    expect(models.find((model) => model.id === 'kimi-k3-max')).toMatchObject({
      displayName: 'Kimi K3',
      reasoningEfforts: [],
      serviceTiers: [],
    })
    expect(models.find((model) => model.id === 'kimi-k3-low')).toMatchObject({
      displayName: 'Kimi K3 Low',
    })
    expect(models.find((model) => model.id === 'cursor-grok-4.5-high')).toMatchObject({
      displayName: 'Cursor Grok 4.5',
    })
    expect(models.find((model) => model.id === 'cursor-grok-4.5-low')).toMatchObject({
      displayName: 'Cursor Grok 4.5 Low',
    })
  })

  it('resolves every offered combination to an id the CLI actually listed', () => {
    const models = parseCursorModels(capture)
    const listed = rawIds()
    listed.add('auto')
    const index = getCursorIndex()
    for (const model of models) {
      const efforts = model.reasoningEfforts.length ? model.reasoningEfforts : [undefined]
      const tiers = model.serviceTiers.length
        ? model.serviceTiers.map((tier) => tier.id)
        : [undefined]
      for (const effort of efforts) {
        for (const tier of tiers) {
          const resolved = resolveCursorModel(index, model.id, effort, tier)
          expect(listed, `${model.id} @ ${effort}/${tier} -> ${resolved}`).toContain(resolved)
        }
      }
    }
  })

  it('degrades a missing fast twin to the standard variant instead of failing', () => {
    parseCursorModels(capture)
    // The listing offers gpt-5.4-low but no gpt-5.4-low-fast.
    expect(resolveCursorModel(getCursorIndex(), 'gpt-5.4-medium', 'low', 'fast')).toBe(
      'gpt-5.4-low',
    )
  })

  it('passes unknown ids through for the CLI to reject with its own error', () => {
    parseCursorModels(capture)
    expect(resolveCursorModel(getCursorIndex(), 'not-a-model', 'high', 'fast')).toBe('not-a-model')
  })

  it('keeps the automatic route and single models keep their names', () => {
    const models = parseCursorModels(capture)
    expect(models.find((model) => model.id === 'auto')).toMatchObject({
      displayName: 'Auto',
      isDefault: true,
    })
    expect(models.find((model) => model.id === 'kimi-k2.7-code')).toMatchObject({
      displayName: 'Kimi K2.7 Code',
      reasoningEfforts: [],
      serviceTiers: [],
    })
  })
})
