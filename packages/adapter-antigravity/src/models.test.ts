import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseAntigravityModels } from './adapter.js'
import {
  antigravityDisplayName,
  collapseAntigravityModels,
  getAntigravityIndex,
  resolveAntigravityModel,
} from './models.js'

/** The full listing captured from agy 1.1.10 on 2026-08-07. */
const CAPTURED = readFileSync(
  new URL('./fixtures/antigravity-models-2026-08-07.txt', import.meta.url),
  'utf8',
)
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)

describe('collapseAntigravityModels', () => {
  it('collapses the captured listing to one row per base model', () => {
    const { models } = collapseAntigravityModels(CAPTURED)
    expect(models.map((model) => model.displayName)).toEqual([
      'Gemini 3.6 Flash',
      'Gemini 3.5 Flash',
      'Gemini 3.1 Pro',
      'Claude Sonnet 4.6',
      'Claude Opus 4.6 Thinking',
      'GPT-OSS 120B',
    ])
  })

  it('offers the efforts each base actually lists, CLI-first as default', () => {
    const { models } = collapseAntigravityModels(CAPTURED)
    const flash = models.find((model) => model.displayName === 'Gemini 3.6 Flash')
    expect(flash).toMatchObject({
      isDefault: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'high',
    })
    const pro = models.find((model) => model.displayName === 'Gemini 3.1 Pro')
    expect(pro?.reasoningEfforts).toEqual(['low', 'high'])
  })

  it('keeps -thinking as a model and notes a lone baked-in effort', () => {
    const { models } = collapseAntigravityModels(CAPTURED)
    const thinking = models.find((model) => model.id === 'claude-opus-4-6-thinking')
    expect(thinking?.reasoningEfforts).toEqual([])
    const oss = models.find((model) => model.id === 'gpt-oss-120b-medium')
    expect(oss).toMatchObject({
      displayName: 'GPT-OSS 120B',
      description: 'Fixed at medium effort',
      reasoningEfforts: [],
    })
  })

  it('resolves base id + effort back to the concrete slug, nearest on a miss', () => {
    const { index } = collapseAntigravityModels(CAPTURED)
    expect(resolveAntigravityModel(index, 'gemini-3.6-flash-high', 'low')).toBe(
      'gemini-3.6-flash-low',
    )
    expect(resolveAntigravityModel(index, 'gemini-3.6-flash-high', undefined)).toBe(
      'gemini-3.6-flash-high',
    )
    // 3.1 Pro lists no medium; the nearest listed effort wins over a refusal,
    // and on a distance tie the CLI's own ordering (high first) decides.
    expect(resolveAntigravityModel(index, 'gemini-3.1-pro-high', 'medium')).toBe(
      'gemini-3.1-pro-high',
    )
    expect(resolveAntigravityModel(index, 'claude-sonnet-4-6', 'high')).toBe('claude-sonnet-4-6')
    expect(resolveAntigravityModel(index, 'not-in-the-listing', 'high')).toBe('not-in-the-listing')
  })
})

/** `agy models` with agy's names: 1.3.4 on 2026-10-16, 1.4.0 on 2026-10-17 (an alias listed first). */
const NAMED = {
  '1.3.4': readFileSync(new URL('./fixtures/agy-models-1.3.4.txt', import.meta.url), 'utf8'),
  '1.4.0': readFileSync(new URL('./fixtures/agy-models-1.4.0.txt', import.meta.url), 'utf8'),
}

describe('agy listings with names', () => {
  it.each(Object.entries(NAMED))('names each model as agy %s does, once', (_version, output) => {
    const models = parseAntigravityModels(output)
    expect(models.map((model) => [model.id, model.displayName])).toEqual([
      ['gemini-4-argon-medium', 'Gemini 4 Argon'],
      ['gemini-3.8-flash-high', 'Gemini 3.8 Flash'],
      ['gemini-flash-demo', 'Gemini 3.7 Flash'],
      ['claude-sonnet-4-6', 'Claude Sonnet 4.6 (Thinking)'],
      ['claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)'],
      ['gpt-oss-120b-medium', 'GPT-OSS 120B'],
    ])
    expect(models[0]).toMatchObject({
      isDefault: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'medium',
    })
    expect(models[1]).toMatchObject({
      reasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'high',
    })
    expect(models[5]).toMatchObject({ description: 'Fixed at medium effort', reasoningEfforts: [] })
  })

  it('runs an effort on the slug that spells the name, not on its alias', () => {
    parseAntigravityModels(NAMED['1.4.0'])
    const index = getAntigravityIndex()
    expect(resolveAntigravityModel(index, 'gemini-4-argon-medium', undefined)).toBe(
      'gemini-4-argon-medium',
    )
    expect(resolveAntigravityModel(index, 'gemini-4-argon-medium', 'high')).toBe(
      'gemini-4-argon-high',
    )
    expect(resolveAntigravityModel(index, 'gemini-4-argon-medium', 'low')).toBe(
      'gemini-4-argon-low',
    )
    expect(resolveAntigravityModel(index, 'gemini-3.8-flash-high', 'low')).toBe(
      'gemini-3.8-flash-low',
    )
    expect(resolveAntigravityModel(index, 'gemini-flash-demo', 'high')).toBe('gemini-flash-demo')
    expect(resolveAntigravityModel(index, 'gpt-oss-120b-medium', 'high')).toBe(
      'gpt-oss-120b-medium',
    )
  })
})

describe('antigravityDisplayName', () => {
  it('spells versions and family names for humans', () => {
    expect(antigravityDisplayName('claude-sonnet-4-6')).toBe('Claude Sonnet 4.6')
    expect(antigravityDisplayName('gpt-oss-120b')).toBe('GPT-OSS 120B')
    expect(antigravityDisplayName('gemini-3.6-flash')).toBe('Gemini 3.6 Flash')
  })
})
