import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

    let failure = ''
    try {
      store.list()
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    expect(failure).toContain(
      'the original configuration was preserved. Unlock the OS credential store and try again',
    )
    expect(failure).not.toContain('blocked-migration-sentinel')
    expect(readFileSync(location, 'utf8')).toBe(legacy)
    expect(readFileSync(location, 'utf8')).toContain('blocked-migration-sentinel')
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

    expect(() => new CustomHarnessStore(location, credentials).list()).toThrow(
      'invalid custom harness recovery record',
    )
    expect(credentials.values.get('model-connections/keep')).toBe('unrelated-secret')
  })

  it('defers a failed post-commit cleanup to the next read instead of failing the write', () => {
    const { location } = fixture()
    const credentials = memoryCredentials()
    const store = new CustomHarnessStore(location, credentials)
    store.upsert({
      ...input(),
      environmentUpdates: { set: { TOKEN: 'old-sentinel' }, unset: [] },
    })
    credentials.failRemove = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // The config already committed, so the upsert must report success; the
    // failed delete stays in the recovery record for the next read to retry.
    const saved = store.upsert({
      ...input(),
      environmentUpdates: { set: { TOKEN: 'new-sentinel' }, unset: [] },
    })
    expect(saved.environmentKeys).toEqual(['TOKEN'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cleanup is deferred'))
    const recovery = readFileSync(`${location}.recovery`, 'utf8')
    expect(recovery).not.toContain('old-sentinel')
    expect(recovery).not.toContain('new-sentinel')

    // While the obligation is pending, reads still surface it.
    expect(() => store.get('deepseek-pi')).toThrow('cleanup is pending')

    credentials.failRemove = false
    expect(store.get('deepseek-pi').environment).toEqual({ TOKEN: 'new-sentinel' })
    expect(existsSync(`${location}.recovery`)).toBe(false)
  })

  it('waits out a live holder, then fails the locked operation', () => {
    const { location } = fixture()
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'])
    try {
      writeFileSync(`${location}.lock`, JSON.stringify({ pid: holder.pid, createdAt: Date.now() }))
      const store = new CustomHarnessStore(location, memoryCredentials(), undefined, {
        timeoutMs: 250,
      })
      expect(() => store.list()).toThrow(
        'timed out waiting for the custom harness configuration lock',
      )
    } finally {
      holder.kill()
    }
  })

  it('treats an unparsable lock as mid-write and only lets age break it', () => {
    const { location } = fixture()
    writeFileSync(`${location}.lock`, '')
    const waiting = new CustomHarnessStore(location, memoryCredentials(), undefined, {
      timeoutMs: 250,
    })
    expect(() => waiting.list()).toThrow('timed out waiting')

    const impatient = new CustomHarnessStore(location, memoryCredentials(), undefined, {
      staleMs: -1,
    })
    expect(impatient.list()).toEqual([])
  })

  it('breaks a lock whose recorded holder is dead', () => {
    const { location } = fixture()
    const dead = spawnSync(process.execPath, ['-e', ''])
    expect(dead.pid).toBeTypeOf('number')
    writeFileSync(`${location}.lock`, JSON.stringify({ pid: dead.pid, createdAt: Date.now() }))
    const store = new CustomHarnessStore(location, memoryCredentials(), undefined, {
      timeoutMs: 2_000,
    })
    expect(store.list()).toEqual([])
  })

  it('recovers a migration record without mistaking a same-named harness for the sentinel', () => {
    const { location } = fixture()
    const credentials = memoryCredentials()
    const keep = `custom-environment/${randomUUID()}`
    const other = `custom-environment/${randomUUID()}`
    const drop = `custom-environment/${randomUUID()}`
    credentials.values.set(keep, 'kept-secret')
    credentials.values.set(other, 'other-secret')
    credentials.values.set(drop, 'dropped-secret')
    // A user harness may legitimately be named '__migration__'. The record is
    // that harness's own upsert: its expected references cover only its own
    // bindings, never the whole file.
    writeFileSync(
      location,
      JSON.stringify({
        version: 2,
        harnesses: [
          { ...input('__migration__'), environmentBindings: { TOKEN: keep } },
          { ...input('other'), environmentBindings: { KEY: other } },
        ],
      }),
    )
    writeFileSync(
      `${location}.recovery`,
      JSON.stringify({
        version: 1,
        operation: { kind: 'upsert', harnessId: '__migration__', expectedReferences: [keep] },
        stagedReferences: [keep],
        obsoleteReferences: [drop],
      }),
    )

    const store = new CustomHarnessStore(location, credentials)
    expect(store.list()).toHaveLength(2)
    // Judged by the harness's own bindings the upsert committed; the legacy
    // whole-file sentinel check would instead have deleted the live staged
    // credential.
    expect(credentials.values.get(keep)).toBe('kept-secret')
    expect(credentials.values.get(other)).toBe('other-secret')
    expect(credentials.values.has(drop)).toBe(false)
    expect(existsSync(`${location}.recovery`)).toBe(false)
  })

  it('recovers migration records written with the dedicated operation kind', () => {
    const { location } = fixture()
    const credentials = memoryCredentials()
    const staged = `custom-environment/${randomUUID()}`
    const obsolete = `custom-environment/${randomUUID()}`
    credentials.values.set(staged, 'staged-secret')
    credentials.values.set(obsolete, 'obsolete-secret')
    writeFileSync(
      location,
      JSON.stringify({
        version: 2,
        harnesses: [{ ...input(), environmentBindings: { TOKEN: staged } }],
      }),
    )
    writeFileSync(
      `${location}.recovery`,
      JSON.stringify({
        version: 1,
        operation: { kind: 'migrate', expectedReferences: [staged] },
        stagedReferences: [staged],
        obsoleteReferences: [obsolete],
      }),
    )

    expect(new CustomHarnessStore(location, credentials).list()).toHaveLength(1)
    expect(credentials.values.get(staged)).toBe('staged-secret')
    expect(credentials.values.has(obsolete)).toBe(false)
    expect(existsSync(`${location}.recovery`)).toBe(false)
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
