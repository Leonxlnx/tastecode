import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const credentials = new Map<string, string>()
let failStrictRemove = false
vi.mock('./credentials.js', () => ({
  hasCredential: (reference: string) => credentials.has(reference),
  writeCredential: (reference: string, value: string) => credentials.set(reference, value),
  removeCredential: (reference: string) => credentials.delete(reference),
  removeCredentialStrict: (reference: string) => {
    if (failStrictRemove) throw new Error('credential store is locked')
    credentials.delete(reference)
  },
}))

const { ModelConnectionStore } = await import('./model-connections.js')
const roots: string[] = []

afterEach(() => {
  credentials.clear()
  failStrictRemove = false
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-providers-'))
  roots.push(root)
  return { root, location: path.join(root, 'providers.json') }
}

function input(id: string) {
  return {
    id,
    displayName: 'Work OpenRouter',
    preset: 'openrouter' as const,
    transport: 'openai-compatible' as const,
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5.6',
    enabled: true,
  }
}

describe('model connections', () => {
  it('keeps API keys out of the human-readable provider config', () => {
    const { location } = fixture()
    const store = new ModelConnectionStore(location)
    store.upsert(input('work-openrouter'))
    store.setCredential('work-openrouter', 'secret-test-key')

    expect(store.list()[0]).toMatchObject({ credentialConfigured: true, enabled: true })
    expect(readFileSync(location, 'utf8')).not.toContain('secret-test-key')
  })

  it('mints a unique credential reference instead of deriving it from the id', () => {
    const { location } = fixture()
    const store = new ModelConnectionStore(location)
    store.upsert(input('first'))
    store.upsert(input('second'))

    const [first, second] = [store.get('first'), store.get('second')]
    const pattern =
      /^model-connections\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    expect(first.credentialRef).toMatch(pattern)
    expect(second.credentialRef).toMatch(pattern)
    expect(first.credentialRef).not.toBe('model-connections/first')
    expect(first.credentialRef).not.toBe(second.credentialRef)
  })

  it('never resurrects an API key orphaned under the deterministic reference', () => {
    const { location } = fixture()
    // A connection written before per-credential references stored its key at
    // `model-connections/<id>`.
    writeFileSync(
      location,
      JSON.stringify({
        version: 1,
        connections: [{ ...input('acme'), credentialRef: 'model-connections/acme' }],
      }),
    )
    credentials.set('model-connections/acme', 'orphaned-key')
    const store = new ModelConnectionStore(location)
    store.remove('acme')
    // The failed-delete scenario the strict removal protects against: the key
    // is still sitting under the old deterministic name.
    credentials.set('model-connections/acme', 'orphaned-key')

    store.upsert(input('acme'))

    const recreated = store.get('acme')
    expect(recreated.credentialRef).not.toBe('model-connections/acme')
    expect(credentials.has('model-connections/acme')).toBe(false)
    expect(store.list()[0]).toMatchObject({ credentialConfigured: false })
  })

  it('reports a keyring that still holds the API key after remove', () => {
    const { location } = fixture()
    const store = new ModelConnectionStore(location)
    store.upsert(input('acme'))
    store.setCredential('acme', 'live-key')
    const ref = store.get('acme').credentialRef
    failStrictRemove = true

    expect(() => store.remove('acme')).toThrow('credential store is locked')
    expect(credentials.get(ref)).toBe('live-key')
  })
})
