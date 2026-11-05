import { afterEach, expect, it, vi } from 'vitest'

vi.mock('./kill.js', () => ({
  spawnOwned: vi.fn(() => ({})),
  killTree: vi.fn(),
  leaveRunning: vi.fn(),
}))

import { setCommandOverride, spawnCli } from './cli.js'
import { spawnOwned } from './kill.js'

const originalPlatform = process.platform

afterEach(() => {
  setCommandOverride('test-provider')
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.clearAllMocks()
})

it('routes an overridden Windows batch file through the escaped cmd launcher', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  setCommandOverride('test-provider', 'C:\\Program Files\\Tools & Co\\provider.cmd')
  spawnCli('test-provider', ['argument & more'])
  expect(spawnOwned).toHaveBeenCalledOnce()
  const [command, args, options] = vi.mocked(spawnOwned).mock.calls[0]!
  expect(command).toBe('cmd.exe')
  expect(args.slice(0, 4)).toEqual(['/d', '/s', '/v:off', '/c'])
  expect(args[4]).toContain('Program^ Files')
  expect(args[4]).toContain('Tools^ ^&^ Co')
  expect(args[4]).toContain('argument^^^ ^^^&^^^ more')
  expect(options.windowsVerbatimArguments).toBe(true)
})
