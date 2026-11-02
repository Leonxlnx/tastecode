import { describe, expect, it } from 'vitest'
import { ThreadSchema } from './domain.js'
import {
  ModelConnectionSchema,
  ModelEndpointSchema,
  StoredModelConnectionSchema,
} from './connections.js'

describe('model connections', () => {
  it('accepts server-owned API connection configuration without exposing its credential reference', () => {
    const stored = StoredModelConnectionSchema.parse({
      id: 'work-openrouter',
      displayName: 'Work OpenRouter',
      preset: 'openrouter',
      transport: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      credentialRef: 'model-connections/work-openrouter',
      defaultModel: 'anthropic/claude-sonnet-4.6',
      enabled: true,
    })

    const publicConnection = ModelConnectionSchema.parse({
      ...stored,
      credentialConfigured: true,
    })

    expect(publicConnection).not.toHaveProperty('credentialRef')
    expect(publicConnection.credentialConfigured).toBe(true)
  })

  it('allows HTTPS and local development endpoints but rejects remote plaintext HTTP', () => {
    expect(ModelEndpointSchema.parse('https://api.openai.com/v1')).toBe('https://api.openai.com/v1')
    expect(ModelEndpointSchema.parse('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1')
    expect(() => ModelEndpointSchema.parse('http://192.168.1.4:11434/v1')).toThrow()
    expect(() => ModelEndpointSchema.parse('http://localhost:11434/v1')).toThrow()
  })

  it('requires a named connection only for direct API threads', () => {
    expect(
      ThreadSchema.parse({
        id: 'thread-1',
        provider: 'api',
        connectionId: 'personal-openai',
        workspacePath: 'D:\\repo',
        createdAt: 1,
      }),
    ).toMatchObject({ provider: 'api', connectionId: 'personal-openai' })
    expect(() =>
      ThreadSchema.parse({
        id: 'thread-1',
        provider: 'api',
        workspacePath: 'D:\\repo',
        createdAt: 1,
      }),
    ).toThrow()
    expect(() =>
      ThreadSchema.parse({
        id: 'thread-1',
        provider: 'codex',
        connectionId: 'personal-openai',
        workspacePath: 'D:\\repo',
        createdAt: 1,
      }),
    ).toThrow()
  })
})
