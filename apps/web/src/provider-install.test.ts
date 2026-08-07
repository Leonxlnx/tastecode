import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from './transport.js'
import {
  beginInstall,
  beginLogin,
  deviceCode,
  firstAuthUrl,
  installKey,
  installState,
  lastPrintableLine,
  loginKey,
  resetInstalls,
} from './provider-install.js'

afterEach(() => {
  vi.restoreAllMocks()
  resetInstalls()
})

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

describe('lastPrintableLine', () => {
  it('reports the last line a human would see, without terminal control noise', () => {
    const log = [
      `${ESC}]0;npm${BEL}`, // OSC title update
      `${ESC}[32madded 12 packages${ESC}[0m`,
      '',
      '  ',
    ].join('\r\n')
    expect(lastPrintableLine(log)).toBe('added 12 packages')
  })

  it('treats a bare carriage return as a line break, the way progress bars use it', () => {
    expect(lastPrintableLine('downloading 10%\rdownloading 99%')).toBe('downloading 99%')
  })

  it('is empty when nothing printable arrived yet', () => {
    expect(lastPrintableLine(`${ESC}[2J`)).toBe('')
  })
})

describe('deviceCode', () => {
  it('finds a labelled user code', () => {
    expect(deviceCode('Enter the code: WDJB-MJHT to continue')).toBe('WDJB-MJHT')
    expect(deviceCode('Your one-time code 384756 expires in 15 minutes')).toBe('384756')
  })

  it('finds a bare dashed code without a label', () => {
    expect(deviceCode('First, copy this\n\n  ABCD-1234\n\nthen press Enter')).toBe('ABCD-1234')
  })

  it('never reads a code out of a URL', () => {
    expect(deviceCode('Visit https://example.com/activate?user_code=WDJB-MJHT')).toBeUndefined()
    expect(deviceCode('https://github.com/login/device and code XKCD-4096\n')).toBe('XKCD-4096')
  })

  it('ignores prose and control noise', () => {
    expect(deviceCode(`${ESC}[32mWaiting for browser approval...${ESC}[0m`)).toBeUndefined()
    expect(deviceCode('open your dashboard for details')).toBeUndefined()
  })
})

describe('beginInstall', () => {
  function fakeTransport() {
    const channels = new Map<string, Set<(data: unknown) => void>>()
    const transport = {
      request: vi.fn(async () => ({ terminalId: 'term-1' })),
      on: vi.fn((channel: string, listener: (data: unknown) => void) => {
        const listeners = channels.get(channel) ?? new Set()
        listeners.add(listener)
        channels.set(channel, listeners)
        return () => listeners.delete(listener)
      }),
    } as unknown as Transport
    const emit = (channel: string, data: unknown) => {
      for (const listener of channels.get(channel) ?? []) listener(data)
    }
    return { transport, emit }
  }

  it('tracks one run per target and does not start a second while one is going', async () => {
    const { transport } = fakeTransport()
    const target = { provider: 'acp' as const, agent: 'gemini' }
    await beginInstall(transport, target)
    await beginInstall(transport, target)
    expect(transport.request).toHaveBeenCalledTimes(1)
    expect(installState(installKey(target))?.phase).toBe('running')
  })

  it('keeps the log and marks failure with the exit code when the command dies', async () => {
    const { transport, emit } = fakeTransport()
    const target = { provider: 'opencode' as const }
    await beginInstall(transport, target)

    emit('terminal.output', { terminalId: 'term-1', data: 'npm ERR! EACCES\r\n' })
    emit('terminal.exit', { terminalId: 'term-1', exitCode: 243 })

    const state = installState(installKey(target))
    expect(state?.phase).toBe('failed')
    expect(state?.exitCode).toBe(243)
    expect(state?.lastLine).toBe('npm ERR! EACCES')
    expect(state?.log).toContain('EACCES')
  })

  it('marks success on a clean exit so the UI can refresh the provider list', async () => {
    const { transport, emit } = fakeTransport()
    const target = { provider: 'opencode' as const }
    await beginInstall(transport, target)

    emit('terminal.exit', { terminalId: 'term-1', exitCode: 0 })
    expect(installState(installKey(target))?.phase).toBe('succeeded')
  })
})

describe('beginLogin', () => {
  function fakeTransport() {
    const transport = {
      request: vi.fn(async () => ({ terminalId: 'term-login-1' })),
      on: vi.fn(() => () => {}),
    } as unknown as Transport
    return transport
  }

  it('asks the server to launch the sign-in CLI, never naming a command', async () => {
    const transport = fakeTransport()
    await beginLogin(transport, { provider: 'acp', agent: 'gemini' })
    expect(transport.request).toHaveBeenCalledWith('providers.launch', {
      provider: 'acp',
      agent: 'gemini',
      columns: 320,
      rows: 30,
    })
  })

  it('keeps a login and an install for the same target apart in the store', async () => {
    const transport = fakeTransport()
    const target = { provider: 'opencode' as const }
    await beginInstall(transport, target)
    await beginLogin(transport, target)
    expect(loginKey(target)).not.toBe(installKey(target))
    expect(installState(installKey(target))?.phase).toBe('running')
    expect(installState(loginKey(target))?.phase).toBe('running')
    expect(transport.request).toHaveBeenCalledTimes(2)
  })

  it('reattaches instead of launching twice while a login is running', async () => {
    const transport = fakeTransport()
    const target = { provider: 'acp' as const, agent: 'kimi' }
    await beginLogin(transport, target, () => {})
    await beginLogin(transport, target, () => {})
    expect(transport.request).toHaveBeenCalledTimes(1)
  })

  it('opens the first auth URL the CLI prints, exactly once', async () => {
    const channels = new Map<string, Set<(data: unknown) => void>>()
    const transport = {
      request: vi.fn(async () => ({ terminalId: 'term-login-2' })),
      on: vi.fn((channel: string, listener: (data: unknown) => void) => {
        const listeners = channels.get(channel) ?? new Set()
        listeners.add(listener)
        channels.set(channel, listeners)
        return () => listeners.delete(listener)
      }),
    } as unknown as Transport
    const emit = (channel: string, data: unknown) => {
      for (const listener of channels.get(channel) ?? []) listener(data)
    }
    const opened: string[] = []

    await beginLogin(transport, { provider: 'acp', agent: 'gemini' }, (url) => opened.push(url))
    emit('terminal.output', { terminalId: 'term-login-2', data: 'Starting sign-in...\r\n' })
    emit('terminal.output', {
      terminalId: 'term-login-2',
      data: 'Open this URL: https://accounts.example.test/auth?code=abc\r\n',
    })
    emit('terminal.output', {
      terminalId: 'term-login-2',
      data: 'Or later https://example.test/other\r\n',
    })

    expect(opened).toEqual(['https://accounts.example.test/auth?code=abc'])
    expect(installState(loginKey({ provider: 'acp', agent: 'gemini' }))?.openedAuthUrl).toBe(
      'https://accounts.example.test/auth?code=abc',
    )
  })
})

describe('firstAuthUrl', () => {
  const ESCAPE = String.fromCharCode(27)

  it('finds the URL under terminal control noise', () => {
    expect(firstAuthUrl(`${ESCAPE}[32mVisit https://x.test/login?a=1${ESCAPE}[0m now`)).toBe(
      'https://x.test/login?a=1',
    )
  })

  it('is empty when the CLI has not printed a link yet', () => {
    expect(firstAuthUrl('warming up...')).toBeUndefined()
  })
})
