import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelConnectionStore, type ModelCredentialStore } from './model-connections.js'

const credentials = new Map<string, string>()
const credentialStore: ModelCredentialStore = {
  has: (reference) => credentials.has(reference),
  write: (reference, value) => {
    credentials.set(reference, value)
  },
  remove: (reference) => {
    credentials.delete(reference)
  },
}
const roots: string[] = []

afterEach(() => {
  credentials.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('model connections', () => {
  it('keeps API keys out of the human-readable provider config', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'harness-providers-'))
    roots.push(root)
    const location = path.join(root, 'providers.json')
    const store = new ModelConnectionStore(location, credentialStore)
    store.upsert({
      id: 'work-openrouter',
      displayName: 'Work OpenRouter',
      preset: 'openrouter',
      transport: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'openai/gpt-5.6',
      enabled: true,
    })
    store.setCredential('work-openrouter', 'secret-test-key')

    expect(store.list()[0]).toMatchObject({ credentialConfigured: true, enabled: true })
    expect(readFileSync(location, 'utf8')).not.toContain('secret-test-key')
  })
})
