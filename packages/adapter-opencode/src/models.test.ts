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
            capabilities: z.object({
              toolcall: z.boolean(),
              output: z.object({ text: z.boolean() }),
            }),
            status: z.string(),
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
      status: model.status,
      releaseDate: model.release_date,
      toolCall: model.capabilities.toolcall,
      textOutput: model.capabilities.output.text,
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

function recommendedIds(models: Model[]): string[] {
  return models
    .filter((model) => model.recommended === true)
    .map((model) => model.id)
    .sort()
}

/** A model released on `day`, as models.dev lists a stable chat model. */
function released(
  providerID: string,
  providerName: string,
  modelID: string,
  name: string,
  day: string,
  more: Partial<OpenCodeCatalogEntry> = {},
): OpenCodeCatalogEntry {
  return entry(providerID, providerName, modelID, name, {
    status: 'active',
    releaseDate: day,
    toolCall: true,
    textOutput: true,
    ...more,
  })
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

  it('recommends the newest stable model of each priority lab, four at most', () => {
    const models = openCodeModels(capturedEntries())
    // NVIDIA, LongCat and OpenCode's own models are not on the priority list,
    // MiniMax M3 replaces M2.x and its M3.1 Flash is a preview.
    expect(recommendedIds(models)).toEqual(
      [
        'minimax-coding-plan/MiniMax-M3',
        'opencode/deepseek-v4.1-flash-free',
        'opencode/glm-5.3-flash-free',
        'opencode/mimo-v2.6-flash-free',
      ].sort(),
    )
  })

  it("counts the agent's default among the four", () => {
    const entries = capturedEntries().map((captured) =>
      captured.modelID === 'big-pickle' ? { ...captured, isDefault: true } : captured,
    )
    expect(recommendedIds(openCodeModels(entries))).toEqual(
      [
        'minimax-coding-plan/MiniMax-M3',
        'opencode/big-pickle',
        'opencode/deepseek-v4.1-flash-free',
        'opencode/glm-5.3-flash-free',
      ].sort(),
    )
  })

  it("gives DeepSeek's Pro and Flash a slot each before the next lab", () => {
    const models = openCodeModels([
      released('google', 'Google', 'gemini-4-argon', 'Gemini 4 Argon', '2026-10-13'),
      released('openai', 'OpenAI', 'gpt-6.1-sol', 'GPT-6.1 Sol', '2026-09-29'),
      released(
        'opencode',
        'OpenCode',
        'deepseek-v4.1-flash-free',
        'DeepSeek V4.1 Flash Free',
        '2026-09-10',
      ),
      released('deepseek', 'DeepSeek', 'deepseek-flash', 'DeepSeek V4.1 Flash', '2026-09-10'),
      released('deepseek', 'DeepSeek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', '2026-08-12'),
      released('deepseek', 'DeepSeek', 'deepseek-v4-flash', 'DeepSeek V4 Flash', '2026-04-24'),
      released('deepseek', 'DeepSeek', 'deepseek-chat', 'DeepSeek Chat', '2025-12-01'),
      released(
        'openrouter',
        'OpenRouter',
        '~deepseek/deepseek-flash-latest',
        'DeepSeek Flash Latest',
        '2026-09-14',
        {
          family: 'deepseek-flash',
        },
      ),
      released('anthropic', 'Anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', '2026-09-28'),
    ])
    // The second DeepSeek slot goes to the other tier, not to the older Chat.
    // The connected DeepSeek's Flash goes before OpenCode's free one and an
    // alias of it, and V4 Flash is an older generation.
    expect(recommendedIds(models)).toEqual(
      [
        'anthropic/claude-sonnet-5-5',
        'deepseek/deepseek-flash',
        'deepseek/deepseek-v4-pro',
        'openai/gpt-6.1-sol',
      ].sort(),
    )
  })

  it('starts a lighter tier visible only when its lab offers nothing else', () => {
    const models = openCodeModels([
      released('anthropic', 'Anthropic', 'claude-haiku-5-5', 'Claude Haiku 5.5', '2026-10-07'),
      released('anthropic', 'Anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', '2026-09-28'),
      released('openai', 'OpenAI', 'gpt-6.1-sol-fast', 'GPT-6.1 Sol Fast', '2026-09-29'),
      released('openai', 'OpenAI', 'gpt-6.1-sol', 'GPT-6.1 Sol', '2026-09-29'),
      released('google', 'Google', 'gemini-3.8-flash', 'Gemini 3.8 Flash', '2026-09-02'),
    ])
    expect(recommendedIds(models)).toEqual(
      ['anthropic/claude-sonnet-5-5', 'google/gemini-3.8-flash', 'openai/gpt-6.1-sol'].sort(),
    )
  })

  it('never starts with a preview or a model that cannot run an agent turn', () => {
    const models = openCodeModels([
      released(
        'xai',
        'xAI',
        'grok-imagine-video-1.5-lite',
        'Grok Imagine Video 1.5 Lite',
        '2026-10-01',
        {
          toolCall: false,
          textOutput: false,
        },
      ),
      released('xai', 'xAI', 'grok-4.20-multi-agent-0309', 'Grok 4.20 Multi-Agent', '2026-09-30', {
        toolCall: false,
      }),
      released('xai', 'xAI', 'grok-4.7', 'Grok 4.7', '2026-09-21'),
      released(
        'anthropic',
        'Anthropic',
        'claude-fable-6-preview',
        'Claude Fable 6 (Preview)',
        '2026-10-01',
      ),
      released('anthropic', 'Anthropic', 'claude-opus-6', 'Claude Opus 6', '2026-09-30', {
        status: 'beta',
      }),
      released('anthropic', 'Anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', '2026-09-22'),
    ])
    expect(recommendedIds(models)).toEqual(['anthropic/claude-opus-5-5', 'xai/grok-4.7'])
  })

  it('recommends nothing when no lab on the priority list is connected', () => {
    const models = openCodeModels(
      capturedEntries().filter(
        (captured) => captured.modelID === 'big-pickle' || captured.modelID.startsWith('nemotron'),
      ),
    )
    expect(recommendedIds(models)).toEqual([])
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
