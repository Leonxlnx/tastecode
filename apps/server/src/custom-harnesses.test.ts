import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CustomHarnessStore, type CustomHarnessCredentialStore } from './custom-harnesses.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-custom-cli-'))
  roots.push(root)
  return { root, location: path.join(root, 'custom-harnesses.json') }
}

function memoryCredentials(): CustomHarnessCredentialStore & {
  values: Map<string, string>
  failWrite: boolean
  failRemove: boolean
} {
  const credentials = {
    values: new Map<string, string>(),
    failWrite: false,
    failRemove: false,
    read(reference: string): string {
      const value = this.values.get(reference)
      if (value === undefined) throw new Error('credential unavailable')
      return value
    },
    write(reference: string, value: string): void {
      if (this.failWrite) throw new Error(`write failed for ${value}`)
      this.values.set(reference, value)
    },
    remove(reference: string): void {
      if (this.failRemove) throw new Error('remove failed')
      this.values.delete(reference)
    },
  }
  return credentials
}

function input(id = 'deepseek-pi') {
  return {
    id,
    displayName: 'DeepSeek Pi',
    provider: 'pi' as const,
    command: '/Applications/Pi forks/deepseek-pi',
    args: ['--openrouter', 'value with spaces'],
    workingDirectory: '~/Developer/pi-deepseek',
  }
}

describe('custom harnesses', () => {
  it('returns configured keys while values stay only in the credential store', () => {
    const { location } = fixture()
    const credentials = memoryCredentials()
    const store = new CustomHarnessStore(location, credentials)

    const saved = store.upsert({
      ...input(),
      environmentUpdates: {
        set: { PI_CODING_AGENT_DIR: 'write-only-sentinel', EMPTY_SETTING: '' },
        unset: [],
      },
    })

    expect(saved).toMatchObject({
      command: '/Applications/Pi forks/deepseek-pi',
      args: ['--openrouter', 'value with spaces'],
      workingDirectory: '~/Developer/pi-deepseek',
      environmentKeys: ['PI_CODING_AGENT_DIR', 'EMPTY_SETTING'],
    })
    expect(store.list()).toEqual([saved])
    expect(store.get('deepseek-pi').environment).toEqual({
      PI_CODING_AGENT_DIR: 'write-only-sentinel',
      EMPTY_SETTING: '',
    })
    const serialized = readFileSync(location, 'utf8')
    expect(serialized).toContain('"version": 2')
    expect(serialized).not.toContain('write-only-sentinel')
    expect(JSON.stringify(saved)).not.toContain('write-only-sentinel')
  })

  it('preserves omitted values and removes only explicit keys', () => {
    const { location } = fixture()
    const credentials = memoryCredentials()
    const store = new CustomHarnessStore(location, credentials)
    store.upsert({
      ...input('first'),
      environmentUpdates: { set: { TOKEN: 'secret', KEEP: 'yes' }, unset: [] },
    })

    store.upsert({ ...input('first'), displayName: 'First updated' })
    expect(store.get('first').environment).toEqual({ TOKEN: 'secret', KEEP: 'yes' })

    store.upsert({
      ...input('first'),
      displayName: 'First updated',
      environmentUpdates: { set: {}, unset: ['TOKEN', 'ABSENT'] },
    })
    expect(store.get('first').environment).toEqual({ KEEP: 'yes' })
  })

  it('migrates version 1 values without copying them into version 2 metadata', () => {
    const { location } = fixture()
    writeFileSync(
      location,
      JSON.stringify({
        version: 1,
        harnesses: [{ ...input(), environment: { TOKEN: 'migration-sentinel' } }],
      }),
    )
    const credentials = memoryCredentials()
    const store = new CustomHarnessStore(location, credentials)

    expect(store.list()[0]?.environmentKeys).toEqual(['TOKEN'])
    expect(store.get('deepseek-pi').environment).toEqual({ TOKEN: 'migration-sentinel' })
    const serialized = readFileSync(location, 'utf8')
    expect(serialized).toContain('"version": 2')
    expect(serialized).not.toContain('migration-sentinel')
  })

  it('preserves version 1 plaintext when migration cannot reach the keyring', () => {
    const { location } = fixture()
    const legacy = JSON.stringify({
      version: 1,
      harnesses: [{ ...input(), environment: { TOKEN: 'blocked-migration-sentinel' } }],
    })
    writeFileSync(location, legacy)
    const credentials = memoryCredentials()
    credentials.failWrite = true
    const store = new CustomHarnessStore(location, credentials)

    // Listing stays readable — key names are metadata — while reads and
    // writes that need the values still surface the migration failure.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(store.list()).toEqual([
        expect.objectContaining({ id: 'deepseek-pi', environmentKeys: ['TOKEN'] }),
      ])
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }

    let failure = ''
    try {
      store.get('deepseek-pi')
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    expect(failure).toContain(
      'the original configuration was preserved. Unlock the OS credential store and try again',
    )
    expect(failure).not.toContain('blocked-migration-sentinel')
    expect(() => store.upsert({ ...input(), displayName: 'Still blocked' })).toThrow(
      'the original configuration was preserved',
    )
    expect(readFileSync(location, 'utf8')).toBe(legacy)
    expect(readFileSync(location, 'utf8')).toContain('blocked-migration-sentinel')
  })

  it('keeps listing entries while credential cleanup waits for the store', () => {
    const { location } = fixture()
    const credentials = memoryCredentials()
    const store = new CustomHarnessStore(location, credentials)
    store.upsert({
      ...input(),
      environmentUpdates: { set: { TOKEN: 'first' }, unset: [] },
    })
    credentials.failRemove = true
    expect(() =>
      store.upsert({
        ...input(),
        environmentUpdates: { set: { TOKEN: 'second' }, unset: [] },
      }),
    ).toThrow('cleanup is pending')

    // The obsolete reference cannot be removed while the store is locked,
    // but that pending cleanup must not hide the harness from list().
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(store.list()).toEqual([
        expect.objectContaining({ id: 'deepseek-pi', environmentKeys: ['TOKEN'] }),
      ])
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
    expect(() => store.get('deepseek-pi')).toThrow('cleanup is pending')

    credentials.failRemove = false
    expect(store.get('deepseek-pi').environment).toEqual({ TOKEN: 'second' })
  })

  it('never treats a foreign credential reference as custom-environment cleanup', () => {
    const { location } = fixture()
    const credentials = memoryCredentials()
    credentials.values.set('model-connections/keep', 'unrelated-secret')
    writeFileSync(
      `${location}.recovery`,
      JSON.stringify({
        version: 1,
        operation: { kind: 'remove', harnessId: 'missing' },
        stagedReferences: [],
        obsoleteReferences: ['model-connections/keep'],
      }),
    )

    const store = new CustomHarnessStore(location, credentials)
    // Reads tolerate the unreadable record — nothing in it is ever removed —
    // but the next write still refuses to touch a foreign reference.
    expect(store.list()).toEqual([])
    expect(() => store.upsert({ ...input() })).toThrow(
      'invalid custom harness recovery record',
    )
    expect(credentials.values.get('model-connections/keep')).toBe('unrelated-secret')
  })

  it('retains a reference-only cleanup obligation until deletion succeeds', () => {
    const { location } = fixture()
    const credentials = memoryCredentials()
    const store = new CustomHarnessStore(location, credentials)
    store.upsert({
      ...input(),
      environmentUpdates: { set: { TOKEN: 'old-sentinel' }, unset: [] },
    })
    credentials.failRemove = true

    expect(() =>
      store.upsert({
        ...input(),
        environmentUpdates: { set: { TOKEN: 'new-sentinel' }, unset: [] },
      }),
    ).toThrow('cleanup is pending')
    expect(readFileSync(location, 'utf8')).not.toContain('new-sentinel')
    const recovery = readFileSync(`${location}.recovery`, 'utf8')
    expect(recovery).not.toContain('old-sentinel')
    expect(recovery).not.toContain('new-sentinel')

    credentials.failRemove = false
    expect(store.get('deepseek-pi').environment).toEqual({ TOKEN: 'new-sentinel' })
  })

  it('uses Windows key equivalence without changing Unix case sensitivity', () => {
    const windowsCredentials = memoryCredentials()
    const windows = new CustomHarnessStore(fixture().location, windowsCredentials, 'win32')
    windows.upsert({
      ...input(),
      environmentUpdates: { set: { PATH: 'first' }, unset: [] },
    })
    windows.upsert({
      ...input(),
      environmentUpdates: { set: { Path: 'second' }, unset: [] },
    })
    expect(windows.get('deepseek-pi').environment).toEqual({ Path: 'second' })
    expect(() =>
      windows.upsert({
        ...input(),
        environmentUpdates: { set: { PATH: 'third' }, unset: ['Path'] },
      }),
    ).toThrow('environment key cannot be both set and unset')

    const unix = new CustomHarnessStore(fixture().location, memoryCredentials(), 'linux')
    unix.upsert({
      ...input(),
      environmentUpdates: { set: { PATH: 'first', Path: 'second' }, unset: [] },
    })
    expect(unix.list()[0]?.environmentKeys).toEqual(['PATH', 'Path'])
  })

  it('updates and removes one entry without touching its neighbours', () => {
    const { location } = fixture()
    const credentials = memoryCredentials()
    const store = new CustomHarnessStore(location, credentials)
    store.upsert({ ...input('first'), environmentUpdates: { set: { TOKEN: 'first' }, unset: [] } })
    store.upsert({
      ...input('second'),
      provider: 'claude-code',
      environmentUpdates: { set: { TOKEN: 'second' }, unset: [] },
    })
    store.upsert({ ...input('first'), displayName: 'First updated' })
    store.remove('second')

    expect(store.list()).toEqual([
      expect.objectContaining({ id: 'first', displayName: 'First updated' }),
    ])
    expect(store.get('first').environment).toEqual({ TOKEN: 'first' })
  })
})
