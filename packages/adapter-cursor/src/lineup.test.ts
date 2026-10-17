import { readFileSync } from 'node:fs'
import type { Model } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { parseCursorModels } from './adapter.js'
import { cursorLineage } from './lineup.js'

/** `cursor-agent models` on 2026-10-16: 264 ids, 53 base models. */
const today = readFileSync(
  new URL('./fixtures/cursor-models-2026-10-16.txt', import.meta.url),
  'utf8',
)

function listing(...rows: string[]): string {
  return ['Available models', '', ...rows, '', 'Tip: use --model <id> to switch.'].join('\n')
}

function generations(models: Model[], family: string): string[] {
  return models.filter((model) => model.family === family).map((model) => model.generation ?? '')
}

describe('cursorLineage', () => {
  it('reads the line and generation from either version spelling', () => {
    expect(cursorLineage('claude-4.6-opus')).toEqual({ family: 'claude-opus', generation: '4.6' })
    expect(cursorLineage('claude-opus-4-8')).toEqual({ family: 'claude-opus', generation: '4.8' })
    expect(cursorLineage('claude-opus-5')).toEqual({ family: 'claude-opus', generation: '5' })
    expect(cursorLineage('gpt-5.6-sol')).toEqual({ family: 'gpt-sol', generation: '5.6' })
    expect(cursorLineage('muse-wonder-1.0')).toEqual({ family: 'muse-wonder', generation: '1.0' })
  })

  it('keeps thinking twins in their own line and reads letter-prefixed versions', () => {
    expect(cursorLineage('claude-4.6-opus-thinking')).toEqual({
      family: 'claude-opus-thinking',
      generation: '4.6',
    })
    expect(cursorLineage('kimi-k3')).toEqual({ family: 'kimi-k', generation: '3' })
    expect(cursorLineage('kimi-k2.7-code')).toEqual({ family: 'kimi-k-code', generation: '2.7' })
  })

  it("puts Cursor's own serving of a model in that model's line", () => {
    expect(cursorLineage('cursor-grok-4.6')).toEqual({ family: 'grok', generation: '4.6' })
  })

  it('reads no generation from a date, a size or a name without a version', () => {
    expect(cursorLineage('preview-20260929')).toBeUndefined()
    expect(cursorLineage('gpt-oss-120b')).toBeUndefined()
    expect(cursorLineage('composer')).toBeUndefined()
  })
})

describe('Cursor lineup', () => {
  it('starts with the newest model of each main lab, Anthropic also with its top tier', () => {
    const models = parseCursorModels(today)
    expect(models.filter((model) => model.recommended).map((model) => model.displayName)).toEqual([
      'Claude Opus 5.5 1M',
      'Claude Fable 5.1 1M (NO ZDR)',
      'GPT-5.6 Sol 1M',
      'Gemini 4 Argon',
      'Grok 4.7',
      'Composer 2.5',
    ])
  })

  it('puts every generation of a line in one family, newest first', () => {
    const models = parseCursorModels(today)
    expect(generations(models, 'claude-opus')).toEqual(['5.5', '5', '4.8', '4.7', '4.6', '4.5'])
    expect(generations(models, 'claude-opus-thinking')).toEqual(['5', '4.8', '4.7', '4.6', '4.5'])
    expect(generations(models, 'claude-fable')).toEqual(['5.1', '5'])
    expect(generations(models, 'grok')).toEqual(['4.7', '4.6', '4.5'])
    expect(generations(models, 'gemini-flash')).toEqual(['3.8', '3.7', '3.6', '3.5', '3'])
    expect(generations(models, 'gpt')).toEqual(['5.5', '5.4', '5.2', '5.1'])
  })

  it('names the lab of every model and groups the labs in picker order', () => {
    const models = parseCursorModels(today)
    expect(models.every((model) => model.lab)).toBe(true)
    const labs = models
      .map((model) => model.lab)
      .filter((lab, index, all) => all[index - 1] !== lab)
    expect(labs).toEqual([
      'Anthropic',
      'OpenAI',
      'Google',
      'xAI',
      'Cursor',
      'Moonshot',
      'Z.ai',
      'Meta',
    ])
  })

  it('lists each lab newest generation first, a thinking twin after its line', () => {
    const models = parseCursorModels(today)
    const anthropic = models.filter((model) => model.lab === 'Anthropic')
    expect(anthropic.slice(0, 6).map((model) => model.displayName)).toEqual([
      'Claude Opus 5.5 1M',
      'Claude Sonnet 5.5',
      'Claude Haiku 5.5 No Thinking',
      'Claude Haiku 5.5',
      'Claude Fable 5.1 1M (NO ZDR)',
      'Claude Fable 5.1 1M Thinking (NO ZDR)',
    ])
    for (const lab of new Set(models.map((model) => model.lab))) {
      const versions = models
        .filter((model) => model.lab === lab)
        .map((model) => (model.generation ?? '0').split('.').map(Number))
      for (let index = 1; index < versions.length; index += 1) {
        const [previous, current] = [versions[index - 1]!, versions[index]!]
        const newer =
          (current[0] ?? 0) - (previous[0] ?? 0) || (current[1] ?? 0) - (previous[1] ?? 0)
        expect(newer, `${lab} row ${index}`).toBeLessThanOrEqual(0)
      }
    }
  })

  it('keeps the same order however often it is parsed', () => {
    const first = parseCursorModels(today).map((model) => model.id)
    expect(parseCursorModels(today).map((model) => model.id)).toEqual(first)
  })

  it('starts a lab on a lighter tier only when it lists nothing else', () => {
    const models = parseCursorModels(
      listing(
        'claude-haiku-5-5-low - Claude Haiku 5.5 Low',
        'claude-haiku-5-5-high - Claude Haiku 5.5',
      ),
    )
    expect(models).toMatchObject([{ displayName: 'Claude Haiku 5.5', recommended: true }])
  })

  it('lists a model of an unknown lab last, without a lab and switched off', () => {
    const models = parseCursorModels(
      listing('mystery-2 - Mystery 2', 'composer-2.5 - Composer 2.5', 'composer-2 - Composer 2'),
    )
    expect(models.map((model) => [model.id, model.lab, model.recommended])).toEqual([
      ['composer-2.5', 'Cursor', true],
      ['composer-2', 'Cursor', undefined],
      ['mystery-2', undefined, undefined],
    ])
  })
})
