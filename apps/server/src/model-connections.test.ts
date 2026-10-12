import * as fs from 'node:fs'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', { spy: true })

const credentials = new Map<string, string>()
vi.mock('./credentials.js', () => ({
  hasCredential: (reference: string) => credentials.has(reference),
  writeCredential: (reference: string, value: string) => credentials.set(reference, value),
  removeCredential: (reference: string) => credentials.delete(reference),
}))

const { ModelConnectionStore } = await import('./model-connections.js')
const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  credentials.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-providers-'))
  roots.push(root)
  const location = path.join(root, 'providers.json')
  return { root, location, store: new ModelConnectionStore(location) }
}

function parked(root: string): string[] {
  return readdirSync(root).filter((name) => name.includes('.invalid-'))
}

const STORED = {
  id: 'work-openrouter',
  displayName: 'Work OpenRouter',
  preset: 'openrouter',
  transport: 'openai-compatible',
  baseUrl: 'https://openrouter.ai/api/v1',
  enabled: true,
  credentialRef: 'model-connections/work-openrouter',
}

// Accepted by an earlier build, refused by this one (loopback must be 127.0.0.1).
const LEGACY = {
  id: 'old-local',
  displayName: 'Old local',
  preset: 'custom',
  transport: 'openai-compatible',
  baseUrl: 'http://localhost:1234/v1',
  enabled: true,
  credentialRef: 'model-connections/old-local',
}

const FRESH = {
  id: 'fresh',
  displayName: 'Fresh',
  preset: 'openai',
  transport: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
  enabled: true,
} as const

describe('model connections', () => {
  it('keeps API keys out of the human-readable provider config', () => {
    const { location, store } = setup()
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

  it('skips one invalid entry instead of failing every connection', () => {
    const { location, store } = setup()
    writeFileSync(location, JSON.stringify({ version: 1, connections: [LEGACY, STORED] }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(store.list().map((connection) => connection.id)).toEqual(['work-openrouter'])
    expect(store.get('work-openrouter').baseUrl).toBe(STORED.baseUrl)
    expect(() => store.get('old-local')).toThrow('is invalid in')

    // Reported once per file content, by id and field, never by value.
    store.list()
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0]?.[0])
    expect(message).toContain('"old-local"')
    expect(message).toContain('baseUrl')
    expect(message).not.toContain('localhost')
  })

  it('keeps entries it cannot use verbatim when it saves', () => {
    const { root, location, store } = setup()
    const future = { ...STORED, id: 'future', preset: 'deepseek', headers: { 'x-team': 'a' } }
    writeFileSync(
      location,
      JSON.stringify({ version: 1, connections: [LEGACY, STORED, future, 42] }),
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    credentials.set(STORED.credentialRef, 'secret-test-key')

    store.upsert(FRESH)
    store.remove('work-openrouter')

    const saved = JSON.parse(readFileSync(location, 'utf8')) as { connections: unknown[] }
    expect(saved.connections).toEqual([
      expect.objectContaining({ id: 'fresh' }),
      LEGACY,
      future,
      42,
    ])
    expect(store.list().map((connection) => connection.id)).toEqual(['fresh'])
    expect(credentials.has(STORED.credentialRef)).toBe(false)
    expect(parked(root)).toEqual([])
  })

  it.each([
    ['broken JSON', '{"version":1,"connections":[{"id":"half"'],
    ['not a version 1 list', JSON.stringify({ version: 2, connections: {} })],
  ])('does not lock out connections when the file is %s', (_, original) => {
    const { root, location, store } = setup()
    writeFileSync(location, original)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(store.list()).toEqual([])
    expect(() => store.remove('half')).toThrow('could not be read')
    expect(readFileSync(location, 'utf8')).toBe(original)

    // The first save replaces the file, but only after a byte-for-byte copy
    // of the original is in place beside it.
    store.upsert(FRESH)
    expect(store.list().map((connection) => connection.id)).toEqual(['fresh'])
    const [backup, ...extra] = parked(root)
    expect(extra).toEqual([])
    expect(readFileSync(path.join(root, backup!), 'utf8')).toBe(original)
    expect(warn.mock.calls.some(([message]) => String(message).includes(backup!))).toBe(true)

    store.upsert({ ...FRESH, displayName: 'Fresh again' })
    expect(parked(root)).toHaveLength(1)
  })

  it('leaves an unreadable file in place when the replacing save fails', () => {
    const { root, location, store } = setup()
    const original = '{not json'
    writeFileSync(location, original)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    })

    expect(() => store.upsert(FRESH)).toThrow('EPERM')

    expect(readFileSync(location, 'utf8')).toBe(original)
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
