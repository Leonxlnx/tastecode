// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResultOf } from '@harness/contracts'
import {
  beginGitHubSetup,
  beginInstall,
  beginLogin,
  beginUpdate,
  installState,
  resetInstalls,
} from './provider-install.js'
import { TestTransport } from './test-transport.js'
import { InstallTerminal } from './ui/InstallTerminal.js'

const terminal = vi.hoisted(() => ({ writes: [] as string[], resets: 0 }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100
    rows = 30
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    attachCustomKeyEventHandler() {}
    onData() {
      return { dispose() {} }
    }
    reset() {
      terminal.resets += 1
      terminal.writes = []
    }
    write(data: string) {
      terminal.writes.push(data)
    }
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))
vi.mock('./ui/TerminalPane.js', () => ({
  copyTerminalSelection() {},
  terminalCopyShortcut() {
    return false
  },
  terminalFont() {
    return 'monospace'
  },
  terminalTheme() {
    return {}
  },
}))

afterEach(() => {
  cleanup()
  resetInstalls()
  terminal.writes = []
  terminal.resets = 0
  vi.restoreAllMocks()
})
const running = (): ResultOf<'terminal.status'> => ({
  status: 'running',
  output: '',
  outputOffset: 0,
  exitCode: null,
})

describe('terminal jobs', () => {
  it('shows prompts and final failures after crossing the retained output cap', async () => {
    const transport = new TestTransport((method) =>
      method === 'terminal.status' ? running() : { terminalId: 'terminal' },
    )
    await beginInstall(transport, { provider: 'codex' })
    render(<InstallTerminal transport={transport} installKey="codex" />)
    act(() =>
      transport.emit('terminal.output', {
        terminalId: 'terminal',
        data: 'x'.repeat(200_000),
        outputOffset: 0,
      }),
    )
    act(() =>
      transport.emit('terminal.output', {
        terminalId: 'terminal',
        data: '\r\nContinue? ',
        outputOffset: 200_000,
      }),
    )
    act(() =>
      transport.emit('terminal.output', {
        terminalId: 'terminal',
        data: '\r\nFinal failure\r\n',
        outputOffset: 200_012,
      }),
    )
    act(() => transport.emit('terminal.exit', { terminalId: 'terminal', exitCode: 1 }))
    expect(installState('codex')?.log).toHaveLength(200_000)
    expect(installState('codex')?.logOffset).toBeGreaterThan(0)
    expect(terminal.writes.join('')).toContain('Continue?')
    expect(terminal.writes.join('')).toContain('Final failure')
    expect(installState('codex')?.phase).toBe('failed')
  })

  it.each([
    [
      'codex',
      (transport: TestTransport) => beginInstall(transport, { provider: 'codex' }),
      'providers.install',
    ],
    [
      'login:codex',
      (transport: TestTransport) => beginLogin(transport, { provider: 'codex' }, () => {}),
      'providers.launch',
    ],
    [
      'pull-requests:github:login',
      (transport: TestTransport) => beginGitHubSetup(transport, 'login'),
      'pullRequests.setup',
    ],
    [
      'update:codex',
      (transport: TestTransport) => beginUpdate(transport, 'codex'),
      'providers.update',
    ],
  ] as const)(
    'recovers a missed exit for %s without launching another job',
    async (key, begin, method) => {
      let status = running()
      const transport = new TestTransport((name) =>
        name === 'terminal.status' ? status : { terminalId: 'terminal' },
      )
      await begin(transport)
      transport.emitState('reconnecting')
      status = {
        status: 'exited',
        output: 'Done after reconnect',
        outputOffset: 500_000,
        exitCode: 0,
      }
      transport.emitState('open')
      await vi.waitFor(() => expect(installState(key)?.phase).toBe('succeeded'))
      expect(installState(key)?.log).toBe('Done after reconnect')
      expect(installState(key)?.logOffset).toBe(500_000)
      expect(transport.requests.filter((request) => request.method === method)).toHaveLength(1)
    },
  )

  it('merges live output arriving ahead of a status reply by absolute position', async () => {
    let reply!: (status: ResultOf<'terminal.status'>) => void
    let delayed = false
    const transport = new TestTransport((method) => {
      if (method !== 'terminal.status') return { terminalId: 'terminal' }
      return delayed
        ? new Promise((resolve) => {
            reply = resolve
          })
        : running()
    })
    await beginInstall(transport, { provider: 'codex' })
    await Promise.resolve()
    transport.emit('terminal.output', { terminalId: 'terminal', data: 'old', outputOffset: 0 })
    delayed = true
    transport.emitState('reconnecting')
    transport.emitState('open')
    transport.emit('terminal.output', { terminalId: 'terminal', data: 'new', outputOffset: 3 })
    reply({ status: 'running', output: 'oldne', outputOffset: 0, exitCode: null })
    await vi.waitFor(() => expect(installState('codex')?.log).toBe('oldnew'))
    transport.emit('terminal.output', { terminalId: 'terminal', data: 'new', outputOffset: 3 })
    expect(installState('codex')?.log).toBe('oldnew')
  })

  it('releases an unknown terminal and deduplicates overlapping starts', async () => {
    let finish!: (value: { terminalId: string }) => void
    const transport = new TestTransport((method) =>
      method === 'terminal.status'
        ? { status: 'unknown', output: '', outputOffset: 0, exitCode: null }
        : new Promise((resolve) => {
            finish = resolve
          }),
    )
    const first = beginInstall(transport, { provider: 'codex' })
    const second = beginInstall(transport, { provider: 'codex' })
    expect(transport.requests).toHaveLength(1)
    finish({ terminalId: 'gone' })
    await Promise.all([first, second])
    await vi.waitFor(() => expect(installState('codex')?.phase).toBe('failed'))
    expect(installState('codex')?.lastLine).toContain('no longer available')
  })

  it('preserves offsets across early output gaps before the start reply names the terminal', async () => {
    let finish!: (value: { terminalId: string }) => void
    const transport = new TestTransport((method) =>
      method === 'terminal.status'
        ? running()
        : new Promise((resolve) => {
            finish = resolve
          }),
    )
    const starting = beginInstall(transport, { provider: 'codex' })
    transport.emit('terminal.output', { terminalId: 'terminal', outputOffset: 100, data: 'old' })
    transport.emit('terminal.output', { terminalId: 'terminal', outputOffset: 200, data: 'new' })
    transport.emit('terminal.output', { terminalId: 'terminal', outputOffset: 200, data: 'new' })
    finish({ terminalId: 'terminal' })
    await starting
    expect(installState('codex')).toMatchObject({ log: 'new', logOffset: 200 })
  })
})
