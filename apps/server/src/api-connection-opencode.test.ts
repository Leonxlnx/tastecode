import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoredModelConnection } from '@harness/contracts'
import {
  listCustomModels,
  openCodeConnectionConfig,
  openCodeConnectionEnvironment,
  openCodeModelId,
  writeKeyGuard,
} from './api-connection-opencode.js'

function connection(overrides: Partial<StoredModelConnection> = {}): StoredModelConnection {
  return {
    id: 'openai-1',
    displayName: 'OpenAI API',
    preset: 'openai',
    transport: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    enabled: true,
    credentialRef: 'model-connections/openai-1',
    ...overrides,
  }
}

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('OpenCode config for a direct API connection', () => {
  it.each([
    ['openai', 'openai'],
    ['anthropic', 'anthropic'],
    ['openrouter', 'openrouter'],
    ['kimi', 'moonshotai'],
    ['zai', 'zai'],
  ] as const)('runs the %s preset as OpenCode provider %s and only that one', (preset, id) => {
    const config = openCodeConnectionConfig(
      connection({ preset, baseUrl: 'https://example.com/v1' }),
      'file:///guard.js',
    )
    expect(config).toEqual({
      enabled_providers: [id],
      plugin: ['file:///guard.js'],
      provider: {
        [id]: {
          options: { baseURL: 'https://example.com/v1', apiKey: '{env:TASTECODE_API_KEY}' },
        },
      },
    })
  })

  it('declares a custom endpoint with its transport package and models', () => {
    const config = openCodeConnectionConfig(
      connection({
        preset: 'custom',
        transport: 'openai-compatible',
        displayName: 'Local',
        baseUrl: 'http://127.0.0.1:11434/v1',
        defaultModel: 'qwen3',
      }),
      'file:///guard.js',
      { models: ['llama3', 'qwen3'] },
    )
    expect(config.model).toBe('tastecode/qwen3')
    expect(config.provider).toEqual({
      tastecode: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Local',
        options: { baseURL: 'http://127.0.0.1:11434/v1', apiKey: '{env:TASTECODE_API_KEY}' },
        models: { llama3: {}, qwen3: {} },
      },
    })
  })

  it("makes the chat's model OpenCode's default and declares it beside the catalog", () => {
    const fallback = openCodeConnectionConfig(
      connection({ defaultModel: 'gpt-next' }),
      'file:///guard.js',
    )
    expect(fallback.model).toBe('openai/gpt-next')
    expect(fallback.provider['openai']).toMatchObject({ models: { 'gpt-next': {} } })

    const chosen = openCodeConnectionConfig(
      connection({ defaultModel: 'gpt-next' }),
      'file:///guard.js',
      { model: 'openai/gpt-5.6-pro' },
    )
    expect(chosen.model).toBe('openai/gpt-5.6-pro')
    expect(chosen.provider['openai']).toMatchObject({ models: { 'gpt-5.6-pro': {} } })
  })

  it('never puts the key into the config', () => {
    const config = openCodeConnectionConfig(connection(), 'file:///guard.js')
    const environment = openCodeConnectionEnvironment('sk-test-secret', '/data/sessions.db')
    expect(JSON.stringify(config)).not.toContain('sk-test-secret')
    expect(environment).toEqual({
      TASTECODE_API_KEY: 'sk-test-secret',
      OPENCODE_AUTH_CONTENT: '{}',
      OPENCODE_DB: '/data/sessions.db',
    })
  })

  it('names models the way OpenCode does, without doubling the provider', () => {
    expect(openCodeModelId(connection(), 'gpt-5.6')).toBe('openai/gpt-5.6')
    expect(openCodeModelId(connection(), 'openai/gpt-5.6')).toBe('openai/gpt-5.6')
    expect(openCodeModelId(connection({ preset: 'openrouter' }), 'anthropic/claude')).toBe(
      'openrouter/anthropic/claude',
    )
  })
})

describe('key guard plugin', () => {
  it('blanks the key variable for shell commands and is written once', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tastecode-key-guard-'))
    directories.push(directory)
    const url = writeKeyGuard(directory)
    const file = fileURLToPath(url)
    const source = readFileSync(file, 'utf8')
    expect(source).toContain("'shell.env'")
    expect(source).toContain("output.env.TASTECODE_API_KEY = ''")
    const written = statSync(file).mtimeMs
    expect(writeKeyGuard(directory)).toBe(url)
    expect(statSync(file).mtimeMs).toBe(written)
  })
})

describe('custom endpoint models', () => {
  it('reads the model list with the key as a bearer token', async () => {
    const request = vi.fn(async () =>
      Response.json({ data: [{ id: 'llama3' }, { id: '' }, { name: 'no id' }, { id: 'qwen3' }] }),
    )
    const models = await listCustomModels(
      connection({
        preset: 'custom',
        transport: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1/',
      }),
      'local-key',
      request as unknown as typeof fetch,
    )
    expect(models).toEqual(['llama3', 'qwen3'])
    expect(request).toHaveBeenCalledWith(
      'http://127.0.0.1:1/v1/models',
      expect.objectContaining({ headers: { authorization: 'Bearer local-key' } }),
    )
  })

  it('uses the Anthropic headers for an Anthropic-compatible endpoint', async () => {
    const request = vi.fn(async () => Response.json({ data: [{ id: 'claude-x' }] }))
    await listCustomModels(
      connection({ preset: 'custom', transport: 'anthropic-messages' }),
      'anthropic-key',
      request as unknown as typeof fetch,
    )
    expect(request).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: { 'x-api-key': 'anthropic-key', 'anthropic-version': '2023-06-01' },
      }),
    )
  })

  it('yields no models when the endpoint has no list or fails', async () => {
    const missing = vi.fn(async () => new Response('not found', { status: 404 }))
    const broken = vi.fn(async () => {
      throw new Error('connection refused')
    })
    const custom = connection({ preset: 'custom', transport: 'openai-compatible' })
    await expect(
      listCustomModels(custom, 'k', missing as unknown as typeof fetch),
    ).resolves.toEqual([])
    await expect(listCustomModels(custom, 'k', broken as unknown as typeof fetch)).resolves.toEqual(
      [],
    )
  })
})
