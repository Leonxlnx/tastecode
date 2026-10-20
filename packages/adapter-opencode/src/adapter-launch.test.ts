import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { nativeShimTarget, spawnCli } from '@harness/proc'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenCodeAdapter } from './adapter.js'

const EXECUTABLE = 'C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe'

vi.mock('@harness/proc', async (original) => ({
  ...(await original<typeof import('@harness/proc')>()),
  nativeShimTarget: vi.fn(),
  spawnCli: vi.fn(),
}))

afterEach(() => vi.resetAllMocks())

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: undefined,
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn(() => {
      child.exitCode = 0
      child.emit('close', 0)
      return true
    }),
  })
  return child
}

describe('OpenCode server launch', () => {
  it.each([
    ['opencode.exe itself when npm installed it', EXECUTABLE, EXECUTABLE],
    ['the opencode command for any other install', undefined, 'opencode'],
  ])('starts %s', async (_case, target, expected) => {
    const child = fakeChild()
    vi.mocked(nativeShimTarget).mockResolvedValue(target)
    // SAFETY: The launch reads stdout, stderr, lifecycle events and the kill
    // surface that killTree needs; the double implements each of them.
    vi.mocked(spawnCli).mockReturnValue(child as unknown as ReturnType<typeof spawnCli>)
    const adapter = new OpenCodeAdapter()
    const starting = adapter.start()
    await vi.waitFor(() => expect(spawnCli).toHaveBeenCalledTimes(1))
    expect(vi.mocked(spawnCli).mock.calls[0]?.slice(0, 2)).toEqual([
      expected,
      ['serve', '--hostname=127.0.0.1', '--port=0'],
    ])
    await adapter.dispose()
    child.stdout.write('opencode server listening on http://127.0.0.1:9\n')
    await expect(starting).rejects.toThrow('stopped while it was starting')
    expect(child.kill).toHaveBeenCalled()
  })

  it('passes extra config beside the MCP block and extra variables to the serve', async () => {
    const child = fakeChild()
    vi.mocked(nativeShimTarget).mockResolvedValue(undefined)
    // SAFETY: as above, the double implements what the launch and killTree read.
    vi.mocked(spawnCli).mockReturnValue(child as unknown as ReturnType<typeof spawnCli>)
    const adapter = new OpenCodeAdapter({
      config: { enabled_providers: ['openai'] },
      environment: { XDG_DATA_HOME: '/tmp/isolated' },
      mcpServers: [
        {
          id: 'docs',
          enabled: true,
          transport: { type: 'remote', url: 'https://example.com/mcp' },
        },
      ],
    })
    const starting = adapter.start()
    await vi.waitFor(() => expect(spawnCli).toHaveBeenCalledTimes(1))
    const env = vi.mocked(spawnCli).mock.calls[0]?.[2]?.env ?? {}
    expect(env['XDG_DATA_HOME']).toBe('/tmp/isolated')
    expect(env['OPENCODE_SERVER_USERNAME']).toBe('opencode')
    expect(JSON.parse(env['OPENCODE_CONFIG_CONTENT'] ?? '{}')).toEqual({
      enabled_providers: ['openai'],
      mcp: { docs: { type: 'remote', url: 'https://example.com/mcp', enabled: true } },
    })
    await adapter.dispose()
    await expect(starting).rejects.toThrow('stopped while it was starting')
  })

  it('starts no serve when disposed while it looked for the executable', async () => {
    let found!: (target: string | undefined) => void
    vi.mocked(nativeShimTarget).mockReturnValue(new Promise((resolve) => (found = resolve)))
    const adapter = new OpenCodeAdapter()
    const starting = adapter.start()
    await vi.waitFor(() => expect(nativeShimTarget).toHaveBeenCalledTimes(1))
    const disposed = adapter.dispose()
    found(EXECUTABLE)
    await disposed
    await expect(starting).rejects.toThrow('stopped while it was starting')
    expect(spawnCli).not.toHaveBeenCalled()
  })
})
