import { statSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { quoteCmdArgument, spawnCli } from './cli.js'
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
  vi.resetAllMocks()
})

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
    spawnCli('git', ['status'], { ...options, env: { ...options.env, Path: ';C:\\tools' } })
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
