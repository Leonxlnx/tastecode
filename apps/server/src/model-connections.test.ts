import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const credentials = new Map<string, string>()
vi.mock('./credentials.js', () => ({
  hasCredential: (reference: string) => credentials.has(reference),
  writeCredential: (reference: string, value: string) => credentials.set(reference, value),
  removeCredential: (reference: string) => credentials.delete(reference),
}))

const { ModelConnectionStore } = await import('./model-connections.js')
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
    const store = new ModelConnectionStore(location)
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
