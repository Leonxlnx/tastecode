import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCliOptions, runHeadlessCli } from './headless-cli.js'

const mocks = vi.hoisted(() => ({
  startServer: vi.fn((_options: { rendererOrigin?: string }) => ({
    close: async () => undefined,
  })),
}))
vi.mock('./server.js', () => ({ startServer: mocks.startServer }))

afterEach(() => {
  vi.restoreAllMocks()
  mocks.startServer.mockClear()
})

describe('headless CLI', () => {
  it('parses the serve command and listener port', () => {
    expect(parseCliOptions(['serve', '--port', '4400'])).toEqual({
      command: 'serve',
      port: 4400,
    })
  })

  it('uses the environment port and rejects invalid arguments', () => {
    expect(parseCliOptions(['serve'], { HARNESS_PORT: '5500' })).toEqual({
      command: 'serve',
      port: 5500,
    })
    expect(() => parseCliOptions(['pair'])).toThrow('Unknown argument: pair')
    expect(() => parseCliOptions(['--port', '70000'])).toThrow('between 1 and 65535')
  })

  it('trusts no HTTP renderer origin unless one is configured', async () => {
    // No renderer runs beside a headless server, so whatever page answers on
    // the dev renderer's port must not reach the control socket.
    vi.spyOn(process, 'once').mockReturnValue(process)
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    await runHeadlessCli(['serve'], {})
    await runHeadlessCli(['serve'], { HARNESS_RENDERER_ORIGIN: 'http://127.0.0.1:6100' })

    expect(mocks.startServer.mock.calls.map(([options]) => options.rendererOrigin)).toEqual([
      'file://',
      'http://127.0.0.1:6100',
    ])
  })
})
