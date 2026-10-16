import { statSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateCommandCache, quoteCmdArgument, spawnCli } from './cli.js'
import { spawnOwned } from './kill.js'

vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  statSync: vi.fn(),
}))
vi.mock('./kill.js', () => ({ spawnOwned: vi.fn(), killTree: vi.fn() }))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const options = {
  cwd: 'C:\\work',
  replaceEnv: true,
  env: { Path: 'C:\\tools', PATHEXT: '.EXE;.CMD' },
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  vi.mocked(statSync).mockImplementation(() => {
    throw new Error('not found')
  })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  invalidateCommandCache()
  vi.useRealTimers()
  vi.resetAllMocks()
})

/** Make exactly these files exist for the mocked statSync. */
function files(...existing: string[]) {
  vi.mocked(statSync).mockImplementation((filename) => {
    if (!existing.includes(String(filename))) throw new Error('not found')
    return { isFile: () => true } as ReturnType<typeof statSync>
  })
}

describe('Windows CLI dispatch', () => {
  it('resolves extensionless native CLIs without sending their arguments through cmd', () => {
    vi.mocked(statSync).mockImplementation((filename) => {
      if (filename !== 'C:\\tools\\gh.EXE') throw new Error('not found')
      return { isFile: () => true } as ReturnType<typeof statSync>
    })
    const args = ['api', 'repos/owner/repo/pulls/7/files?per_page=100&page=1']
    spawnCli('gh', args, options)
    expect(spawnOwned).toHaveBeenCalledWith(
      'C:\\tools\\gh.EXE',
      args,
      expect.objectContaining({ cwd: options.cwd, env: options.env }),
    )
    expect(vi.mocked(spawnOwned).mock.calls[0]?.[2]).not.toHaveProperty('windowsVerbatimArguments')
  })

  it('never resolves a bare command from the working directory', () => {
    vi.mocked(statSync).mockImplementation((filename) => {
      if (filename !== 'C:\\work\\git.CMD' && filename !== 'C:\\tools\\git.EXE') {
        throw new Error('not found')
      }
      return { isFile: () => true } as ReturnType<typeof statSync>
    })
    spawnCli('git', ['status'], { ...options, env: { ...options.env, Path: ';"";C:\\tools' } })
    expect(spawnOwned).toHaveBeenCalledWith('C:\\tools\\git.EXE', ['status'], expect.anything())
  })

  it('still resolves a command with a path separator against the working directory', () => {
    vi.mocked(statSync).mockImplementation((filename) => {
      if (filename !== 'C:\\work\\bin\\agent.EXE') throw new Error('not found')
      return { isFile: () => true } as ReturnType<typeof statSync>
    })
    spawnCli('bin\\agent', [], options)
    expect(spawnOwned).toHaveBeenCalledWith('C:\\work\\bin\\agent.EXE', [], expect.anything())
  })

  it('keeps cmd.exe from searching the working directory for an unresolved command', () => {
    spawnCli('missing-tool', [], options)
    expect(spawnOwned).toHaveBeenCalledWith(
      'cmd.exe',
      expect.anything(),
      expect.objectContaining({
        env: { ...options.env, NoDefaultCurrentDirectoryInExePath: '1' },
      }),
    )
  })

  it('escapes a forwarding shim command and both argument parses', () => {
    vi.mocked(statSync).mockImplementation((filename) => {
      if (filename !== 'C:\\tools\\agent.CMD') throw new Error('not found')
      return { isFile: () => true } as ReturnType<typeof statSync>
    })
    const args = ['safe', 'a&b', '%PATH%', '!NAME!', '"quotes"']
    spawnCli('agent', args, options)
    expect(spawnOwned).toHaveBeenCalledWith(
      'cmd.exe',
      [
        '/d',
        '/s',
        '/v:off',
        '/c',
        `"C:\\tools\\agent.CMD ${args.map((arg) => quoteCmdArgument(arg, true)).join(' ')}"`,
      ],
      expect.objectContaining({ windowsVerbatimArguments: true, env: options.env }),
    )
  })

  it('escapes command paths containing spaces and cmd operators', () => {
    spawnCli('C:\\tool & kit\\agent.cmd', ['safe'], options)
    expect(spawnOwned).toHaveBeenCalledWith(
      'cmd.exe',
      ['/d', '/s', '/v:off', '/c', '"C:\\tool^ ^&^ kit\\agent.cmd safe"'],
      expect.objectContaining({ windowsVerbatimArguments: true }),
    )
  })

  it('rejects line breaks before starting a shell', () => {
    expect(() => spawnCli('agent.cmd', ['first\nsecond'], options)).toThrow('line breaks')
    expect(spawnOwned).not.toHaveBeenCalled()
  })
})

describe('Windows command lookup cache', () => {
  const search = {
    cwd: 'C:\\work',
    replaceEnv: true,
    env: { Path: 'C:\\a;C:\\b;C:\\tools', PATHEXT: '.EXE;.CMD' },
  }
  const launched = () => vi.mocked(spawnOwned).mock.calls.at(-1)

  it('keeps PATH order before PATHEXT order', () => {
    files('C:\\a\\gh.CMD', 'C:\\b\\gh.EXE')
    spawnCli('gh', [], search)
    expect(launched()?.[1]).toEqual(['/d', '/s', '/v:off', '/c', '"C:\\a\\gh.CMD"'])
  })

  it('reuses a found command after one stat', () => {
    files('C:\\tools\\gh.EXE')
    spawnCli('gh', [], search)
    // C:\a and C:\b each miss .EXE and .CMD before C:\tools has gh.EXE.
    expect(statSync).toHaveBeenCalledTimes(5)
    vi.mocked(statSync).mockClear()
    spawnCli('gh', ['status'], search)
    expect(statSync).toHaveBeenCalledTimes(1)
    expect(launched()).toEqual(['C:\\tools\\gh.EXE', ['status'], expect.anything()])
  })

  it('searches again when the found file is gone', () => {
    files('C:\\tools\\gh.EXE')
    spawnCli('gh', [], search)
    files('C:\\b\\gh.EXE')
    spawnCli('gh', [], search)
    expect(launched()?.[0]).toBe('C:\\b\\gh.EXE')
  })

  it('looks for a missing command again after a few seconds', () => {
    vi.useFakeTimers()
    spawnCli('fresh-cli', [], search)
    expect(launched()?.[0]).toBe('cmd.exe')
    files('C:\\tools\\fresh-cli.EXE')
    vi.mocked(statSync).mockClear()
    spawnCli('fresh-cli', [], search)
    expect(statSync).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5_001)
    spawnCli('fresh-cli', [], search)
    expect(launched()?.[0]).toBe('C:\\tools\\fresh-cli.EXE')
  })

  it('forgets every lookup when asked, so a finished install is found at once', () => {
    spawnCli('fresh-cli', [], search)
    files('C:\\tools\\fresh-cli.EXE')
    invalidateCommandCache()
    spawnCli('fresh-cli', [], search)
    expect(launched()?.[0]).toBe('C:\\tools\\fresh-cli.EXE')
  })

  it('keys a lookup by the PATH it searched', () => {
    files('C:\\tools\\gh.EXE', 'C:\\other\\gh.EXE')
    spawnCli('gh', [], search)
    spawnCli('gh', [], { ...search, env: { ...search.env, Path: 'C:\\other' } })
    expect(launched()?.[0]).toBe('C:\\other\\gh.EXE')
  })
})
