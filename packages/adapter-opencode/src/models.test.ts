import { readFileSync } from 'node:fs'
import { ModelSchema, type Model } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { openCodeModels, type OpenCodeCatalogEntry } from './models.js'

/** `GET /config/providers` from `opencode serve` 1.18.13, trimmed (see adapter.test.ts). */
const CAPTURED = z
  .object({
    providers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        models: z.record(
          z.string(),
          z.object({
            id: z.string(),
            name: z.string(),
            family: z.string().optional(),
            release_date: z.string(),
          }),
        ),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL('./fixtures/opencode-1.18.13-config-providers.json', import.meta.url),
        'utf8',
      ),
    ),
  )

function capturedEntries(): OpenCodeCatalogEntry[] {
  return CAPTURED.providers.flatMap((provider) =>
    Object.values(provider.models).map((model) => ({
      providerID: provider.id,
      providerName: provider.name,
      modelID: model.id,
      name: model.name,
      family: model.family,
      releaseDate: model.release_date,
      isDefault: false,
      reasoningEfforts: [],
    })),
  )
}

function entry(
  providerID: string,
  providerName: string,
  modelID: string,
  name: string,
  more: Partial<OpenCodeCatalogEntry> = {},
): OpenCodeCatalogEntry {
  return {
    providerID,
    providerName,
    modelID,
    name,
    isDefault: false,
    reasoningEfforts: [],
    ...more,
  }
}

function byId(models: Model[]): Map<string, Model> {
  return new Map(models.map((model) => [model.id, model]))
}

describe('openCodeModels', () => {
  it('names each captured model as its provider does and places it with its lab', () => {
    const models = openCodeModels(capturedEntries())
    for (const model of models) expect(ModelSchema.parse(model)).toEqual(model)
    const listed = byId(models)
    expect(listed.get('minimax-coding-plan/MiniMax-M3')).toMatchObject({
      displayName: 'MiniMax-M3',
      lab: 'MiniMax',
      family: 'minimax-coding-plan/minimax m#',
      generation: '3',
      released: '2026-06-01',
    })
    expect(listed.get('opencode/deepseek-v4.1-flash-free')).toMatchObject({
      displayName: 'DeepSeek V4.1 Flash Free',
      lab: 'DeepSeek',
      family: 'opencode/deepseek v# flash free',
      generation: '4.1',
      released: '2026-09-10',
    })
    expect(listed.get('opencode/glm-5.3-flash-free')?.lab).toBe('Z.ai')
    expect(listed.get('opencode/mimo-v2.6-flash-free')?.lab).toBe('Xiaomi')
    expect(listed.get('opencode/nemotron-3.5-super-vl-free')?.lab).toBe('NVIDIA')
    // OpenCode's own models belong to no lab in the table.
    expect(listed.get('opencode/big-pickle')).toMatchObject({ lab: 'OpenCode' })
    expect(listed.get('opencode/big-pickle')).not.toHaveProperty('family')
    expect(listed.get('opencode/space-bunny-free')?.lab).toBe('OpenCode')
  })

  it('puts MiniMax M2.x in the family that M3 replaces', () => {
    const listed = byId(openCodeModels(capturedEntries()))
    const m3 = listed.get('minimax-coding-plan/MiniMax-M3')
    for (const id of ['MiniMax-M2', 'MiniMax-M2.1', 'MiniMax-M2.5', 'MiniMax-M2.7']) {
      const older = listed.get(`minimax-coding-plan/${id}`)
      expect(older?.family).toBe(m3?.family)
      expect(Number(older?.generation)).toBeLessThan(Number(m3?.generation))
    }
    expect(listed.get('minimax-coding-plan/MiniMax-M2.7-highspeed')?.family).toBe(
      'minimax-coding-plan/minimax m# highspeed',
    )
    expect(listed.get('minimax-coding-plan/MiniMax-M3.1-Flash-Preview')?.family).toBe(
      'minimax-coding-plan/minimax m# flash preview',
    )
  })

  it('reads the lab from a lab/model id before the family, else names the provider', () => {
    const listed = byId(
      openCodeModels([
        entry('openrouter', 'OpenRouter', 'z-ai/glm-5.3', 'Z.AI: GLM 5.3', { family: 'glm' }),
        entry('openrouter', 'OpenRouter', 'meta-llama/llama-4-maverick', 'Llama 4 Maverick'),
        entry('openrouter', 'OpenRouter', 'qwen/qwen3.6-plus', 'Qwen3.6 Plus'),
        entry('openrouter', 'OpenRouter', 'acme/widget-2', 'Widget 2'),
        entry('openrouter', 'OpenRouter', 'metaphor-1', 'Metaphor 1'),
        entry('anthropic', 'Anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', {
          family: 'claude-opus',
        }),
      ]),
    )
    expect(listed.get('openrouter/z-ai/glm-5.3')?.lab).toBe('Z.ai')
    expect(listed.get('openrouter/meta-llama/llama-4-maverick')?.lab).toBe('Meta')
    expect(listed.get('openrouter/qwen/qwen3.6-plus')).toMatchObject({
      lab: 'Qwen',
      family: 'openrouter/qwen# plus',
      generation: '3.6',
    })
    expect(listed.get('openrouter/acme/widget-2')?.lab).toBe('OpenRouter')
    expect(listed.get('openrouter/metaphor-1')?.lab).toBe('OpenRouter')
    expect(listed.get('anthropic/claude-opus-5-5')?.lab).toBe('Anthropic')
  })

  it('names the provider only when another provider offers the same name', () => {
    const models = openCodeModels([
      entry('moonshotai', 'Moonshot AI', 'kimi-k2.6', 'Kimi K2.6'),
      entry('openrouter', 'OpenRouter', 'moonshotai/kimi-k2.6', 'Kimi K2.6'),
      entry('moonshotai', 'Moonshot AI', 'kimi-k2.5', 'Kimi K2.5'),
    ])
    expect(models.map((model) => model.displayName)).toEqual([
      'Kimi K2.6 · Moonshot AI',
      'Kimi K2.6 · OpenRouter',
      'Kimi K2.5',
    ])
    // The same model through two providers keeps two lineages.
    expect(models[0]?.family).toBe('moonshotai/kimi k#')
    expect(models[1]?.family).toBe('openrouter/kimi k#')
  })

  it('keeps a date or a size out of the generation', () => {
    const listed = byId(
      openCodeModels([
        entry('mistral', 'Mistral', 'devstral-2512', 'Devstral 2512'),
        entry('opencode', 'OpenCode', 'ring-2.6-1t-free', 'Ring 2.6 1T Free'),
      ]),
    )
    expect(listed.get('mistral/devstral-2512')).not.toHaveProperty('generation')
    expect(listed.get('opencode/ring-2.6-1t-free')).toMatchObject({
      family: 'opencode/ring # 1t free',
      generation: '2.6',
    })
  })

  it('keeps a beta or alpha release from replacing the stable model it previews', () => {
    const listed = byId(
      openCodeModels([
        entry('tinfoil', 'Tinfoil', 'deepseek-v4-1-flash', 'DeepSeek V4.1 Flash', {
          status: 'beta',
        }),
        entry('tinfoil', 'Tinfoil', 'deepseek-v4-flash', 'DeepSeek V4 Flash', {
          status: 'active',
        }),
        entry('tinfoil', 'Tinfoil', 'deepseek-v5-flash', 'DeepSeek V5 Flash', {
          status: 'alpha',
        }),
      ]),
    )
    expect(listed.get('tinfoil/deepseek-v4-flash')?.family).toBe('tinfoil/deepseek v# flash')
    expect(listed.get('tinfoil/deepseek-v4-1-flash')).toMatchObject({
      family: 'tinfoil/deepseek v# flash beta',
      generation: '4.1',
    })
    expect(listed.get('tinfoil/deepseek-v5-flash')?.family).toBe('tinfoil/deepseek v# flash alpha')
  })

  it('leaves out a release day that is not a calendar day', () => {
    const models = openCodeModels(
      ['2026-13-40', '2026-02-30', 'soon', ''].map((releaseDate, index) =>
        entry('opencode', 'OpenCode', `model-${index}`, `Model ${index}`, { releaseDate }),
      ),
    )
    for (const model of models) expect(model).not.toHaveProperty('released')
  })
})
