import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeVersionChange,
  installDrifted,
  LAST_RUN_VERSION_FILE,
  readInstallSignature,
  recordRunVersion,
  type InstallIo,
} from './install-drift.js'

const created: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'install-drift-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true })
})

function fakeIo(
  files: Record<string, unknown>,
  stats: Record<string, { dev: number; ino: number; size: number }>,
): InstallIo {
  return {
    readJson: (filePath) => files[filePath],
    stat: (filePath) => stats[filePath],
  }
}

describe('readInstallSignature', () => {
  it('prefers the packaging provenance when present', () => {
    const io = fakeIo(
      { '/res/BUILD_PROVENANCE.json': { version: '1.2.3', commit: 'abcdef123456' } },
      { '/res/app.asar': { dev: 1, ino: 2, size: 3 } },
    )
    expect(readInstallSignature('/res', io)).toEqual({
      kind: 'provenance',
      version: '1.2.3',
      commit: 'abcdef123456',
    })
  })

  it('falls back to the app.asar inode identity without provenance', () => {
    const io = fakeIo({}, { '/res/app.asar': { dev: 66307, ino: 8540585, size: 15389777 } })
    expect(readInstallSignature('/res', io)).toEqual({
      kind: 'files',
      dev: 66307,
      ino: 8540585,
      size: 15389777,
    })
  })

  it('returns undefined when neither source exists', () => {
    expect(readInstallSignature('/res', fakeIo({}, {}))).toBeUndefined()
  })
})

describe('installDrifted', () => {
  const provenanceA = { kind: 'provenance', version: '1.0.0', commit: 'aaa111' } as const
  const provenanceB = { kind: 'provenance', version: '1.0.1', commit: 'bbb222' } as const

  it('is unchanged for identical signatures', () => {
    expect(installDrifted(provenanceA, provenanceA).changed).toBe(false)
    expect(installDrifted(undefined, undefined).changed).toBe(false)
  })

  it('reports a version change with a readable detail', () => {
    const drift = installDrifted(provenanceA, provenanceB)
    expect(drift.changed).toBe(true)
    expect(drift.detail).toBe('on-disk version changed: 1.0.0 (aaa111) → 1.0.1 (bbb222)')
  })

  it('reports a replaced app.asar by inode identity', () => {
    const before = { kind: 'files', dev: 1, ino: 100, size: 50 } as const
    const after = { kind: 'files', dev: 1, ino: 200, size: 50 } as const
    expect(installDrifted(before, after).changed).toBe(true)
    expect(installDrifted(before, before).changed).toBe(false)
  })

  it('reports a signature that disappears mid-run', () => {
    expect(installDrifted(provenanceA, undefined).changed).toBe(true)
  })
})

describe('recordRunVersion + describeVersionChange', () => {
  function memoryIo() {
    const files = new Map<string, string>()
    return {
      files,
      readText: (filePath: string) => files.get(filePath),
      writeText: (filePath: string, contents: string) => files.set(filePath, contents),
    }
  }

  it('returns no previous version on the first run but stores the current one', () => {
    const io = memoryIo()
    const dir = tempRoot()
    expect(recordRunVersion(dir, '1.0.0', io).previous).toBeUndefined()
    expect(io.files.get(join(dir, LAST_RUN_VERSION_FILE))).toBe('1.0.0\n')
  })

  it('reports the earlier version after an on-disk upgrade', () => {
    const io = memoryIo()
    const dir = tempRoot()
    recordRunVersion(dir, '1.0.0', io)
    expect(recordRunVersion(dir, '1.0.1', io).previous).toBe('1.0.0')
  })

  it('describes a change and stays silent otherwise', () => {
    expect(describeVersionChange(undefined, '1.0.0')).toBeUndefined()
    expect(describeVersionChange('1.0.0', '1.0.0')).toBeUndefined()
    expect(describeVersionChange('1.0.0', '1.0.1')).toBe(
      'version changed since last run: 1.0.0 → 1.0.1',
    )
    // apt can also install an older build; the wording must not claim an upgrade.
    expect(describeVersionChange('1.0.1', '1.0.0')).toBe(
      'version changed since last run: 1.0.1 → 1.0.0',
    )
  })
})
