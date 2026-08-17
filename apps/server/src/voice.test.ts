import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelConnectionStore, type ModelCredentialStore } from './model-connections.js'
import { VoiceService } from './voice.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('VoiceService', () => {
  it('only enables Codex voice for an enabled official OpenAI API connection', () => {
    const { store, credentials } = connectionStore()
    store.upsert({
      id: 'compatible',
      displayName: 'Compatible endpoint',
      preset: 'custom',
      transport: 'openai-compatible',
      baseUrl: 'https://api.openai.com.evil.example/v1',
      enabled: true,
    })
    store.setCredential('compatible', 'compatible-test-key')
    const service = new VoiceService(store, (reference) => credentials.get(reference) ?? '')

    expect(service.status('codex')).toEqual({ available: false, reason: 'unsupported_auth' })
    expect(service.status('claude-code')).toEqual({
      available: false,
      reason: 'provider_unsupported',
    })

    store.upsert({
      id: 'openai',
      displayName: 'OpenAI',
      preset: 'openai',
      transport: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      enabled: true,
    })
    store.setCredential('openai', 'openai-test-key')

    expect(service.status('codex')).toEqual({ available: true })
  })

  it('reads the key server-side and passes only audio plus the key to the transcriber', async () => {
    const { store, credentials } = connectionStore()
    store.upsert({
      id: 'openai',
      displayName: 'OpenAI',
      preset: 'openai',
      transport: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      enabled: true,
    })
    store.setCredential('openai', 'openai-test-key')
    const transcribe = vi.fn().mockResolvedValue('voice result')
    const readCredential = vi.fn((reference: string) => credentials.get(reference) ?? '')
    const service = new VoiceService(store, readCredential, { transcribe })

    await expect(
      service.transcribe({
        requestId: 'f2fdef87-1235-455a-818f-e9636d5cf32d',
        provider: 'codex',
        audioBase64: 'UklGRg==',
        mimeType: 'audio/wav',
        sampleRateHz: 24_000,
        durationMs: 1_000,
      }),
    ).resolves.toBe('voice result')

    expect(readCredential).toHaveBeenCalledWith('model-connections/openai')
    expect(transcribe).toHaveBeenCalledWith(
      {
        audioBase64: 'UklGRg==',
        mimeType: 'audio/wav',
        sampleRateHz: 24_000,
        durationMs: 1_000,
      },
      'openai-test-key',
      undefined,
    )
  })

  it('fails closed when the configured key cannot be read', async () => {
    const { store } = connectionStore()
    store.upsert({
      id: 'openai',
      displayName: 'OpenAI',
      preset: 'openai',
      transport: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      enabled: true,
    })
    store.setCredential('openai', 'openai-test-key')
    const transcribe = vi.fn()
    const service = new VoiceService(
      store,
      () => {
        throw new Error('credential store unavailable')
      },
      { transcribe },
    )

    await expect(
      service.transcribe({
        requestId: 'f2fdef87-1235-455a-818f-e9636d5cf32d',
        provider: 'codex',
        audioBase64: 'UklGRg==',
        mimeType: 'audio/wav',
        sampleRateHz: 24_000,
        durationMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'unsupported_auth' })
    expect(transcribe).not.toHaveBeenCalled()
  })
})

function connectionStore(): {
  store: ModelConnectionStore
  credentials: Map<string, string>
} {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tastecode-voice-'))
  roots.push(root)
  const credentials = new Map<string, string>()
  const credentialStore: ModelCredentialStore = {
    has: (reference) => credentials.has(reference),
    write: (reference, value) => credentials.set(reference, value),
    remove: (reference) => credentials.delete(reference),
  }
  return {
    store: new ModelConnectionStore(path.join(root, 'providers.json'), credentialStore),
    credentials,
  }
}
