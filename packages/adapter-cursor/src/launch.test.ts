import { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { spawnOwned } from '@harness/proc/kill'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findCursorWindowsLauncher, runCursorAgent } from './launch.js'

vi.mock('@harness/proc/kill', async (original) => ({
  ...(await original<typeof import('@harness/proc/kill')>()),
  spawnOwned: vi.fn(),
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

class FakeChild extends ChildProcess {
  override stdin = new PassThrough()
  override stdout = new PassThrough()
  override stderr = new PassThrough()
  override stdio: [PassThrough, PassThrough, PassThrough, null, null] = [
    this.stdin,
    this.stdout,
    this.stderr,
    null,
    null,
  ]

  kill(): boolean {
    return true
  }
}

describe('Cursor Windows launcher', () => {
  let localAppData = ''

  beforeEach(() => {
    localAppData = mkdtempSync(path.join(tmpdir(), 'cursor-launch-'))
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
    vi.unstubAllEnvs()
    vi.mocked(spawnOwned).mockReset()
    rmSync(localAppData, { recursive: true, force: true })
  })

  const install = (version: string, files = ['node.exe', 'index.js']) => {
    const directory = path.join(localAppData, 'cursor-agent', 'versions', version)
    mkdirSync(directory, { recursive: true })
    for (const file of files) writeFileSync(path.join(directory, file), '')
    return directory
  }

  it('picks the newest complete version the way cursor-agent.ps1 does', () => {
    // 2026.7.9 sorts after 2026.07.23 as text; the shim compares dates.
    install('2026.7.9-0a1b2c')
    install('2026.07.23-e383d2b')
    const newest = install('2026.07.23-14-05-09-ff00aa')
    install('2026.08.01-dead01', ['index.js'])
    install('latest')

    expect(findCursorWindowsLauncher({ LOCALAPPDATA: localAppData })).toEqual({
      node: path.join(newest, 'node.exe'),
      script: path.join(newest, 'index.js'),
      env: {
        CURSOR_INVOKED_AS: 'cursor-agent.cmd',
        NODE_COMPILE_CACHE: path.join(localAppData, 'cursor-compile-cache'),
      },
    })
  })

  it('finds nothing when cursor-agent is not installed in the standard place', () => {
    expect(findCursorWindowsLauncher({})).toBeUndefined()
    expect(findCursorWindowsLauncher({ LOCALAPPDATA: localAppData })).toBeUndefined()
  })

  it('runs short commands through the bundled node and captures their answer', async () => {
    // Through cursor-agent.cmd every read also starts cmd.exe and PowerShell,
    // which pushed `status` past its time limit on a busy machine.
    const directory = install('2026.07.23-e383d2b')
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    vi.stubEnv('LOCALAPPDATA', localAppData)
    const child = new FakeChild()
    vi.mocked(spawnOwned).mockImplementation(() => child)
    let stdinEnded = false
    child.stdin.on('finish', () => {
      stdinEnded = true
    })

    const result = runCursorAgent('cursor-agent', ['status'])
    child.stdout.end('✓ Logged in as developer@example.com\n')
    child.stderr.end()
    setImmediate(() => child.emit('close', 0, null))

    await expect(result).resolves.toEqual({
      code: 0,
      signal: null,
      stdout: '✓ Logged in as developer@example.com\n',
      stderr: '',
    })
    expect(spawnOwned).toHaveBeenCalledWith(
      path.join(directory, 'node.exe'),
      [path.join(directory, 'index.js'), 'status'],
      expect.objectContaining({ windowsHide: true }),
    )
    expect(stdinEnded).toBe(true)
  })
})
