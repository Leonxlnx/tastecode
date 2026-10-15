import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareDmgUpdate } from './dmg-update.js'
import { InvalidUpdateError } from './update-validation.js'

type Result = { stdout: string; stderr: string }

const mocks = vi.hoisted(() => ({
  run: vi.fn<(file: string, args: string[]) => Promise<Result>>(),
  readdir: vi.fn<(target: string) => Promise<string[]>>(),
  stat: vi.fn<(target: string) => Promise<{ dev: number }>>(),
}))

// Every macOS tool and file system call is replaced, so the cleanup paths that
// a real Mac only reaches under a stuck volume can run on any platform.
vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _options: unknown,
    callback: (error: unknown, result?: Result) => void,
  ) => {
    mocks.run(file, args).then(
      (result) => callback(null, result),
      (error: unknown) => callback(error),
    )
  },
}))

vi.mock('node:fs/promises', () => ({
  mkdir: async () => undefined,
  readdir: mocks.readdir,
  lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
  stat: mocks.stat,
}))

const directory = path.join(os.tmpdir(), 'tastecode-update-mocked')
const mount = path.join(directory, 'volume')
const ok = (stdout = ''): Result => ({ stdout, stderr: '' })
const busy = () => new Error('hdiutil: detach failed - Resource busy')

function tools(detach: (args: string[]) => Promise<Result>) {
  mocks.run.mockImplementation(async (file, args) => {
    const tool = path.basename(file)
    if (tool === 'hdiutil' && args[0] === 'detach') return detach(args)
    if (tool === 'plutil')
      return ok(args[1] === 'CFBundleIdentifier' ? 'dev.tastecode.desktop\n' : '0.1.3\n')
    return ok()
  })
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  mocks.run.mockReset()
  mocks.readdir.mockReset().mockResolvedValue(['Taste Code.app'])
  // The mount point sits on another device while the update image is attached.
  mocks.stat.mockReset().mockImplementation(async (target) => ({ dev: target === mount ? 2 : 1 }))
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
})

describe('DMG update cleanup', () => {
  it('forces the detach when a plain detach fails', async () => {
    tools(async (args) => {
      if (!args.includes('-force')) throw busy()
      return ok()
    })

    await expect(prepareDmgUpdate('update.dmg', directory, '0.1.3')).resolves.toBe(
      path.join(directory, 'update.zip'),
    )
    expect(mocks.run.mock.calls.filter(([, args]) => args[0] === 'detach')).toEqual([
      ['/usr/bin/hdiutil', ['detach', mount]],
      ['/usr/bin/hdiutil', ['detach', '-force', mount]],
    ])
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps a prepared update when even the forced detach fails', async () => {
    tools(async () => {
      throw busy()
    })

    await expect(prepareDmgUpdate('update.dmg', directory, '0.1.3')).resolves.toBe(
      path.join(directory, 'update.zip'),
    )
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/detach.*Resource busy/)
  })

  it('keeps a prepared update when the mount point cannot be inspected', async () => {
    tools(async () => ok())
    mocks.stat.mockRejectedValue(new Error('EIO: i/o error, stat'))

    await expect(prepareDmgUpdate('update.dmg', directory, '0.1.3')).resolves.toBe(
      path.join(directory, 'update.zip'),
    )
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/EIO/)
  })

  it('reports the original refusal when cleanup fails as well', async () => {
    tools(async () => {
      throw busy()
    })
    mocks.readdir.mockResolvedValue([])

    const result = prepareDmgUpdate('update.dmg', directory, '0.1.3')
    // The refusal decides that the download is discarded instead of retried.
    await expect(result).rejects.toBeInstanceOf(InvalidUpdateError)
    await expect(result).rejects.toThrow(/exactly one app/)
    expect(warn).toHaveBeenCalledOnce()
  })
})
