import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from './transport.js'
import {
  beginInstall,
  beginLogin,
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
      columns: 100,
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
    await beginLogin(transport, target)
    await beginLogin(transport, target)
    expect(transport.request).toHaveBeenCalledTimes(1)
  })
})
