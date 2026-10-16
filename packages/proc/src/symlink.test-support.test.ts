import { existsSync, mkdtempSync, symlinkSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canCreateSymlinks } from './symlink.test-support.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    mkdtempSync: vi.fn(actual.mkdtempSync),
    symlinkSync: vi.fn(actual.symlinkSync),
  }
})

afterEach(() => {
  vi.mocked(mkdtempSync).mockClear()
  vi.mocked(symlinkSync).mockReset()
})

function failSymlink(code: string) {
  vi.mocked(symlinkSync).mockImplementationOnce(() => {
    throw Object.assign(new Error(`${code}: symlink`), { code })
  })
}

function probeDirectoryRemoved() {
  const [created] = vi.mocked(mkdtempSync).mock.results
  return created?.type === 'return' && !existsSync(String(created.value))
}

describe('symlink capability probe', () => {
  it('reports support when the link is created', () => {
    vi.mocked(symlinkSync).mockImplementationOnce(() => {})

    expect(canCreateSymlinks()).toBe(true)
    expect(probeDirectoryRemoved()).toBe(true)
  })

  it.each(['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'])(
    'reports no support when the host denies the link with %s',
    (code) => {
      failSymlink(code)

      expect(canCreateSymlinks()).toBe(false)
      expect(probeDirectoryRemoved()).toBe(true)
    },
  )

  it('rethrows any other failure instead of hiding a broken fixture', () => {
    failSymlink('EEXIST')

    expect(() => canCreateSymlinks()).toThrow('EEXIST')
    expect(probeDirectoryRemoved()).toBe(true)
  })
})
