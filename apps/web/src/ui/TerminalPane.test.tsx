// @vitest-environment happy-dom
import { Profiler, StrictMode, useLayoutEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResultOf } from '@harness/contracts'
import type { ConnectionState, Transport } from '../transport.js'
import { TerminalPane, terminalCopyShortcut } from './TerminalPane.js'

const xterm = vi.hoisted(() => ({
  fitRows: 24,
  instances: [] as Array<{
    rows: number
    data: ((data: string) => void) | undefined
    selectionChanged: (() => void) | undefined
    selected: boolean
    write: ReturnType<typeof vi.fn>
    clear: ReturnType<typeof vi.fn>
    reset: ReturnType<typeof vi.fn>
    clearTextureAtlas: ReturnType<typeof vi.fn>
    options: Record<string, unknown>
    unicode: { activeVersion: string }
  }>,
}))

const haptics = vi.hoisted(() => ({
  performAppHaptic: vi.fn(),
  prepareAppHaptics: vi.fn(),
}))

vi.mock('../haptics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../haptics.js')>()),
  appHapticsEnabled: () => true,
  performAppHaptic: haptics.performAppHaptic,
  prepareAppHaptics: haptics.prepareAppHaptics,
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {
      const instance = xterm.instances.at(-1)
      if (instance) instance.rows = xterm.fitRows
    }
  },
}))

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class {},
}))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    dispose() {}
  },
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown>
    data: ((data: string) => void) | undefined
    selectionChanged: (() => void) | undefined
    selected = false
    write = vi.fn()
    clear = vi.fn()
    reset = vi.fn()
    clearTextureAtlas = vi.fn()
    unicode = { activeVersion: '6' }
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    attachCustomKeyEventHandler() {}
    hasSelection() {
      return this.selected
    }
    getSelection() {
      return this.selected ? 'copied output' : ''
    }
    onData(callback: (data: string) => void) {
      this.data = callback
      return { dispose() {} }
    }
    onSelectionChange(callback: () => void) {
      this.selectionChanged = callback
      return { dispose() {} }
    }
    constructor(options: Record<string, unknown> = {}) {
      this.options = options
      xterm.instances.push(this)
    }
  },
}))

beforeEach(() => {
  haptics.performAppHaptic.mockClear()
  haptics.prepareAppHaptics.mockClear()
  document.documentElement.style.setProperty(
    '--font-terminal',
    "'JetBrainsMono Nerd Font Mono', monospace",
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  xterm.instances.length = 0
  xterm.fitRows = 24
})

afterEach(() => {
  cleanup()
  document.documentElement.style.removeProperty('--font-terminal')
  document.documentElement.style.removeProperty('--terminal-workspace-bg')
  document.documentElement.style.removeProperty('--rail-glass')
  delete document.documentElement.dataset['theme']
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('TerminalPane', () => {
  it('prepares an inactive renderer without opening a shell until activation', async () => {
    const harness = fakeTransport()
    const view = render(
      <TerminalPane
        transport={harness.transport}
        threadId="thread-idle"
        height={260}
        theme="dark"
        active={false}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => expect(xterm.instances).toHaveLength(1))
    expect(harness.request).not.toHaveBeenCalledWith('terminal.open', expect.anything())

    view.rerender(
      <TerminalPane
        transport={harness.transport}
        threadId="thread-idle"
        height={260}
        theme="dark"
        active
        onClose={vi.fn()}
      />,
    )

    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('terminal.open', {
        threadId: 'thread-idle',
        columns: 80,
        rows: 24,
      }),
    )
    await screen.findByText('Connected')

    const instance = xterm.instances[0]!
    act(() => harness.emit('terminal.output', { terminalId: 'terminal-1', data: 'visible' }))
    expect(instance.write).toHaveBeenLastCalledWith('visible')

    view.rerender(
      <TerminalPane
        transport={harness.transport}
        threadId="thread-idle"
        height={260}
        theme="dark"
        active={false}
        onClose={vi.fn()}
      />,
    )
    act(() => harness.emit('terminal.output', { terminalId: 'terminal-1', data: 'hidden' }))
    expect(instance.write).toHaveBeenCalledWith('hidden')

    view.rerender(
      <TerminalPane
        transport={harness.transport}
        threadId="thread-idle"
        height={260}
        theme="dark"
        active
        onClose={vi.fn()}
      />,
    )
    act(() => harness.emit('terminal.output', { terminalId: 'terminal-1', data: 'resumed' }))
    expect(instance.write).toHaveBeenLastCalledWith('resumed')
  })

  it('opens, streams, reconnects, copies, and detaches one session terminal', async () => {
    const harness = fakeTransport()
    const copy = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: copy },
    })
    const onClose = vi.fn()
    const view = render(
      <StrictMode>
        <TerminalPane
          transport={harness.transport}
          threadId="thread-1"
          height={260}
          theme="dark"
          onHeightChange={vi.fn()}
          onClose={onClose}
        />
      </StrictMode>,
    )

    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('terminal.open', {
        threadId: 'thread-1',
        columns: 80,
        rows: 24,
      }),
    )
    const initialOpenCount = harness.request.mock.calls.filter(
      ([method]) => method === 'terminal.open',
    ).length
    const instance = xterm.instances.at(-1)
    expect(instance).toBeTruthy()

    act(() => harness.emit('terminal.output', { terminalId: 'terminal-1', data: 'ready\r\n' }))
    expect(instance?.write).toHaveBeenCalledWith('ready\r\n')

    act(() => instance?.data?.('pwd\r'))
    expect(harness.request).toHaveBeenCalledWith('terminal.input', {
      terminalId: 'terminal-1',
      data: 'pwd\r',
    })

    if (instance) instance.selected = true
    act(() => instance?.selectionChanged?.())
    fireEvent.click(screen.getByTitle('Copy selection'))
    expect(copy).toHaveBeenCalledWith('copied output')

    act(() => harness.setState('reconnecting'))
    expect(screen.getByText('Reconnecting…')).toBeTruthy()
    act(() => harness.setState('open'))
    await screen.findByText('Connected')
    expect(
      harness.request.mock.calls.filter(([method]) => method === 'terminal.open'),
    ).toHaveLength(initialOpenCount)
    expect(harness.request).toHaveBeenCalledWith('terminal.status', {
      terminalId: 'terminal-1',
    })

    fireEvent.click(screen.getByTitle('Hide terminal'))
    expect(onClose).toHaveBeenCalledOnce()

    view.unmount()
    expect(
      harness.request.mock.calls.filter(([method]) => method === 'terminal.close'),
    ).toHaveLength(0)
  })

  it.each(['oldgapne', 'oldgapnew'])(
    'replays missed output once with a racing snapshot of %s',
    async (snapshotOutput) => {
      const reply = deferred<ResultOf<'terminal.status'>>()
      let recovering = false
      const harness = fakeTransport((method) => {
        if (method === 'terminal.status' && recovering) return reply.promise
        return undefined
      })
      render(
        <TerminalPane
          transport={harness.transport}
          threadId="replay"
          theme="dark"
          onClose={vi.fn()}
        />,
      )
      await screen.findByText('Connected')
      const instance = xterm.instances.at(-1)!
      act(() =>
        harness.emit('terminal.output', { terminalId: 'terminal-1', data: 'old', outputOffset: 0 }),
      )
      recovering = true
      act(() => harness.setState('reconnecting'))
      act(() => harness.setState('open'))
      await waitFor(() =>
        expect(
          harness.request.mock.calls.filter(([method]) => method === 'terminal.status'),
        ).toHaveLength(2),
      )
      act(() => {
        harness.emit('terminal.output', { terminalId: 'terminal-1', data: 'new', outputOffset: 6 })
        instance.data?.('blocked input')
      })
      expect(written(instance)).toBe('old')
      expect(harness.request).not.toHaveBeenCalledWith('terminal.input', expect.anything())
      await act(async () =>
        reply.resolve({
          status: 'running',
          output: snapshotOutput,
          outputOffset: 0,
          exitCode: null,
        }),
      )
      expect(written(instance)).toBe('oldgapnew')
      act(() => {
        harness.emit('terminal.output', { terminalId: 'terminal-1', data: 'new', outputOffset: 6 })
        harness.emit('terminal.output', { terminalId: 'terminal-1', data: 'new!', outputOffset: 6 })
        instance.data?.('ready input')
      })
      expect(written(instance)).toBe('oldgapnew!')
      expect(harness.request).toHaveBeenCalledWith('terminal.input', {
        terminalId: 'terminal-1',
        data: 'ready input',
      })
      expect(
        harness.request.mock.calls.filter(([method]) => method === 'terminal.open'),
      ).toHaveLength(1)
    },
  )

  it('merges output before the open reply with the initial snapshot exactly once', async () => {
    const opened = deferred<{ terminalId: string }>()
    const harness = fakeTransport((method) => {
      if (method === 'terminal.open') return opened.promise
      if (method === 'terminal.status')
        return { status: 'running', output: 'prompt', outputOffset: 0, exitCode: null }
      return undefined
    })
    render(
      <TerminalPane
        transport={harness.transport}
        threadId="early-output"
        theme="dark"
        onClose={vi.fn()}
      />,
    )
    act(() => {
      harness.emit('terminal.output', { terminalId: 'unrelated', data: 'ignore', outputOffset: 0 })
      harness.emit('terminal.output', { terminalId: 'terminal-1', data: 'prompt', outputOffset: 0 })
    })
    await act(async () => opened.resolve({ terminalId: 'terminal-1' }))
    await screen.findByText('Connected')
    expect(written(xterm.instances.at(-1)!)).toBe('prompt')
  })

  it.each(['offline', 'recovering'])(
    'closes a removed keyed terminal once while %s',
    async (connection) => {
      const harness = fakeTransport()
      const view = render(
        <TerminalPane
          terminalKey="offline-tab"
          transport={harness.transport}
          threadId="offline"
          theme="dark"
          mode="workspace"
          onClose={vi.fn()}
        />,
      )
      await screen.findByText('Connected')
      act(() => harness.setState('reconnecting'))
      if (connection === 'recovering') act(() => harness.setState('open'))
      view.unmount()
      await act(async () => undefined)
      expect(harness.transport.state).toBe(connection === 'offline' ? 'reconnecting' : 'open')
      expect(
        harness.request.mock.calls.filter(([method]) => method === 'terminal.close'),
      ).toHaveLength(connection === 'offline' ? 0 : 1)
      act(() => harness.setState('open'))
      await act(async () => undefined)
      expect(harness.request).toHaveBeenCalledWith('terminal.close', { terminalId: 'terminal-1' })
      expect(
        harness.request.mock.calls.filter(([method]) => method === 'terminal.close'),
      ).toHaveLength(1)
      expect(
        harness.request.mock.calls.filter(([method]) => method === 'terminal.open'),
      ).toHaveLength(1)
    },
  )

  it('closes each owner when a workspace tab changes thread and is then removed', async () => {
    const harness = fakeTransport((method, params) =>
      method === 'terminal.open' ? { terminalId: params['threadId'] } : undefined,
    )
    const onClose = vi.fn()
    const view = render(
      <TerminalPane
        terminalKey="shared-tab"
        transport={harness.transport}
        threadId="owner-A"
        theme="dark"
        mode="workspace"
        onClose={onClose}
      />,
    )
    await screen.findByText('Connected')
    view.rerender(
      <TerminalPane
        terminalKey="shared-tab"
        transport={harness.transport}
        threadId="owner-B"
        theme="dark"
        mode="workspace"
        onClose={onClose}
      />,
    )
    await screen.findByText('Connected')
    expect(harness.request).toHaveBeenCalledWith('terminal.close', { terminalId: 'owner-A' })
    expect(harness.request).not.toHaveBeenCalledWith('terminal.close', { terminalId: 'owner-B' })
    view.unmount()
    await act(async () => undefined)
    expect(harness.request).toHaveBeenCalledWith('terminal.close', { terminalId: 'owner-B' })
  })

  it('closes a late open reply for the former owner despite the new owner lease', async () => {
    const opened = deferred<{ terminalId: string }>()
    const harness = fakeTransport((method, params) => {
      if (method === 'terminal.open')
        return params['threadId'] === 'owner-A' ? opened.promise : { terminalId: 'owner-B' }
      return undefined
    })
    const view = render(
      <TerminalPane
        terminalKey="late-tab"
        transport={harness.transport}
        threadId="owner-A"
        theme="dark"
        onClose={vi.fn()}
      />,
    )
    view.rerender(
      <TerminalPane
        terminalKey="late-tab"
        transport={harness.transport}
        threadId="owner-B"
        theme="dark"
        onClose={vi.fn()}
      />,
    )
    await screen.findByText('Connected')
    await act(async () => opened.resolve({ terminalId: 'owner-A' }))
    expect(harness.request).toHaveBeenCalledWith('terminal.close', { terminalId: 'owner-A' })
    expect(harness.request).not.toHaveBeenCalledWith('terminal.close', { terminalId: 'owner-B' })
  })

  it.each(['snapshot', 'live event'] as const)(
    'handles an exit from the %s during recovery without spawning a replacement',
    async (exitSource) => {
      const reply = deferred<ResultOf<'terminal.status'>>()
      let recovering = false
      const harness = fakeTransport((method) =>
        method === 'terminal.status' && recovering ? reply.promise : undefined,
      )
      const onClose = vi.fn()
      const view = render(
        <TerminalPane
          transport={harness.transport}
          threadId="exited"
          theme="dark"
          onClose={onClose}
        />,
      )
      await screen.findByText('Connected')
      recovering = true
      act(() => harness.setState('reconnecting'))
      act(() => harness.setState('open'))
      if (exitSource === 'live event') {
        act(() => harness.emit('terminal.exit', { terminalId: 'terminal-1', exitCode: 7 }))
      }
      await act(async () =>
        reply.resolve({
          status: exitSource === 'snapshot' ? 'exited' : 'running',
          output: 'last output',
          outputOffset: 0,
          exitCode: exitSource === 'snapshot' ? 7 : null,
        }),
      )
      expect(written(xterm.instances.at(-1)!)).toBe('last output')
      expect(onClose).toHaveBeenCalledOnce()
      view.rerender(
        <TerminalPane
          transport={harness.transport}
          threadId="exited"
          theme="dark"
          active={false}
          onClose={onClose}
        />,
      )
      view.rerender(
        <TerminalPane
          transport={harness.transport}
          threadId="exited"
          theme="dark"
          onClose={onClose}
        />,
      )
      act(() => harness.emit('terminal.exit', { terminalId: 'terminal-1', exitCode: 7 }))
      expect(onClose).toHaveBeenCalledOnce()
      expect(
        harness.request.mock.calls.filter(([method]) => method === 'terminal.open'),
      ).toHaveLength(1)
    },
  )

  it('shows a lost terminal after server restart and resets only when the user restarts it', async () => {
    let phase: 'initial' | 'missing' | 'restarted' = 'initial'
    const harness = fakeTransport((method) => {
      if (method === 'terminal.open')
        return { terminalId: phase === 'restarted' ? 'terminal-new' : 'terminal-1' }
      if (method === 'terminal.status')
        return phase === 'missing'
          ? { status: 'unknown', output: '', outputOffset: 0, exitCode: null }
          : {
              status: 'running',
              output: phase === 'restarted' ? 'new shell' : 'old shell',
              outputOffset: 0,
              exitCode: null,
            }
      return undefined
    })
    render(
      <TerminalPane
        terminalKey="restart-tab"
        transport={harness.transport}
        threadId="restart"
        theme="dark"
        mode="workspace"
        onClose={vi.fn()}
      />,
    )
    await screen.findByText('Connected')
    const instance = xterm.instances.at(-1)!
    phase = 'missing'
    act(() => harness.setState('reconnecting'))
    act(() => harness.setState('open'))
    const error = await screen.findByText(
      'This terminal is no longer available. The server may have restarted.',
    )
    expect(error.classList.contains('visually-hidden')).toBe(false)
    expect(
      harness.request.mock.calls.filter(([method]) => method === 'terminal.open'),
    ).toHaveLength(1)
    expect(instance.reset).not.toHaveBeenCalled()
    act(() => harness.setState('reconnecting'))
    act(() => harness.setState('open'))
    expect(screen.getByTitle('Restart terminal')).toBeTruthy()
    expect(
      screen.getByText('This terminal is no longer available. The server may have restarted.'),
    ).toBeTruthy()
    act(() => instance.data?.('must not reach old shell'))
    expect(harness.request).not.toHaveBeenCalledWith('terminal.input', expect.anything())
    phase = 'restarted'
    instance.write.mockClear()
    fireEvent.click(screen.getByTitle('Restart terminal'))
    await screen.findByText('Connected')
    expect(instance.reset).toHaveBeenCalledOnce()
    expect(written(instance)).toBe('new shell')
    act(() =>
      harness.emit('terminal.output', {
        terminalId: 'terminal-1',
        data: 'old late chunk',
        outputOffset: 9,
      }),
    )
    expect(written(instance)).toBe('new shell')
  })

  it.each(['reply', 'error'] as const)(
    'ignores an old recovery %s after another disconnect',
    async (result) => {
      const stale = deferred<ResultOf<'terminal.status'>>()
      let statusRequests = 0
      const harness = fakeTransport((method) => {
        if (method !== 'terminal.status') return undefined
        statusRequests += 1
        if (statusRequests === 2) return stale.promise
        return {
          status: 'running',
          output: statusRequests === 3 ? 'current' : '',
          outputOffset: 0,
          exitCode: null,
        }
      })
      const onClose = vi.fn()
      render(
        <TerminalPane
          transport={harness.transport}
          threadId="stale"
          theme="dark"
          onClose={onClose}
        />,
      )
      await screen.findByText('Connected')
      act(() => harness.setState('reconnecting'))
      act(() => harness.setState('open'))
      await waitFor(() => expect(statusRequests).toBe(2))
      act(() => harness.setState('reconnecting'))
      act(() => harness.setState('open'))
      await screen.findByText('Connected')
      await act(async () => {
        if (result === 'error') stale.reject(new Error('old connection failed'))
        else
          stale.resolve({ status: 'exited', output: 'stale output', outputOffset: 0, exitCode: 0 })
      })
      expect(written(xterm.instances.at(-1)!)).toBe('current')
      expect(screen.getByText('Connected')).toBeTruthy()
      expect(onClose).not.toHaveBeenCalled()
    },
  )

  it('reports output that expired from the server buffer and does not duplicate the retained tail', async () => {
    let recovering = false
    const harness = fakeTransport((method) =>
      method === 'terminal.status' && recovering
        ? { status: 'running', output: 'tail', outputOffset: 200_000, exitCode: null }
        : undefined,
    )
    render(
      <TerminalPane
        transport={harness.transport}
        threadId="truncated"
        theme="dark"
        onClose={vi.fn()}
      />,
    )
    await screen.findByText('Connected')
    recovering = true
    act(() => harness.setState('reconnecting'))
    act(() => harness.setState('open'))
    await screen.findByText('Connected')
    act(() =>
      harness.emit('terminal.output', {
        terminalId: 'terminal-1',
        data: 'tail',
        outputOffset: 200_000,
      }),
    )
    expect(written(xterm.instances.at(-1)!)).toBe(
      '\r\n[Some terminal output is no longer available.]\r\ntail',
    )
  })

  it('recovers an inactive terminal without opening a new shell', async () => {
    let recovering = false
    const harness = fakeTransport((method) =>
      method === 'terminal.status' && recovering
        ? { status: 'running', output: 'hidden output', outputOffset: 0, exitCode: null }
        : undefined,
    )
    const onClose = vi.fn()
    const view = render(
      <TerminalPane
        transport={harness.transport}
        threadId="inactive-recovery"
        theme="dark"
        onClose={onClose}
      />,
    )
    await screen.findByText('Connected')
    view.rerender(
      <TerminalPane
        transport={harness.transport}
        threadId="inactive-recovery"
        theme="dark"
        active={false}
        onClose={onClose}
      />,
    )
    recovering = true
    act(() => harness.setState('reconnecting'))
    act(() => harness.setState('open'))
    await screen.findByText('Connected')
    expect(written(xterm.instances.at(-1)!)).toBe('hidden output')
    expect(
      harness.request.mock.calls.filter(([method]) => method === 'terminal.open'),
    ).toHaveLength(1)
  })

  it('resumes with a new size after recovery even if the old size was already sent', async () => {
    const harness = fakeTransport()
    render(
      <TerminalPane
        transport={harness.transport}
        threadId="resize-recovery"
        theme="dark"
        onClose={vi.fn()}
      />,
    )
    await screen.findByText('Connected')
    const viewport = document.querySelector<HTMLElement>('.terminal-pane__viewport')!
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 300 },
    })
    act(() => harness.setState('reconnecting'))
    xterm.fitRows = 30
    act(() => harness.setState('open'))
    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('terminal.resize', {
        terminalId: 'terminal-1',
        columns: 80,
        rows: 30,
      }),
    )
  })

  it('keeps a shell leased when the old Strict Mode open resolves after the new one', async () => {
    const first = deferred<{ terminalId: string }>()
    const second = deferred<{ terminalId: string }>()
    let opens = 0
    const harness = fakeTransport((method) =>
      method === 'terminal.open' ? (++opens === 1 ? first.promise : second.promise) : undefined,
    )
    const view = render(
      <StrictMode>
        <TerminalPane
          terminalKey="strict-delayed"
          transport={harness.transport}
          threadId="strict-owner"
          theme="dark"
          onClose={vi.fn()}
        />
      </StrictMode>,
    )
    await act(async () => second.resolve({ terminalId: 'terminal-1' }))
    await screen.findByText('Connected')
    await act(async () => first.resolve({ terminalId: 'terminal-1' }))
    expect(
      harness.request.mock.calls.filter(([method]) => method === 'terminal.close'),
    ).toHaveLength(0)
    view.unmount()
    await act(async () => undefined)
    expect(harness.request.mock.calls.filter(([method]) => method === 'terminal.close')).toEqual([
      ['terminal.close', { terminalId: 'terminal-1' }],
    ])
  })

  it('does not share a lease with the same owner on another transport', async () => {
    const first = fakeTransport()
    const second = fakeTransport()
    const view = render(
      <TerminalPane
        terminalKey="transport-tab"
        transport={first.transport}
        threadId="same-owner"
        theme="dark"
        onClose={vi.fn()}
      />,
    )
    await screen.findByText('Connected')
    view.rerender(
      <TerminalPane
        terminalKey="transport-tab"
        transport={second.transport}
        threadId="same-owner"
        theme="dark"
        onClose={vi.fn()}
      />,
    )
    await screen.findByText('Connected')
    expect(first.request).toHaveBeenCalledWith('terminal.close', { terminalId: 'terminal-1' })
    expect(second.request).not.toHaveBeenCalledWith('terminal.close', expect.anything())
  })

  it('keeps a keyed shell alive across the Strict Mode remount', async () => {
    const harness = fakeTransport()
    const onClose = vi.fn()
    const view = render(
      <StrictMode>
        <TerminalPane
          terminalKey="right-terminal"
          transport={harness.transport}
          projectPath="/workspace/project"
          theme="dark"
          onClose={onClose}
        />
      </StrictMode>,
    )

    await waitFor(() =>
      expect(
        harness.request.mock.calls.filter(([method]) => method === 'terminal.open'),
      ).toHaveLength(2),
    )
    await act(async () => undefined)
    expect(harness.request.mock.calls.filter(([method]) => method === 'terminal.close')).toEqual([])
    expect(onClose).not.toHaveBeenCalled()

    view.unmount()
    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('terminal.close', {
        terminalId: 'terminal-1',
      }),
    )
  })

  it('closes the inline pane when its shell exits', async () => {
    const harness = fakeTransport()
    const onClose = vi.fn()
    render(
      <TerminalPane
        transport={harness.transport}
        threadId="thread-exit"
        height={260}
        theme="dark"
        onClose={onClose}
      />,
    )

    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('terminal.open', {
        threadId: 'thread-exit',
        columns: 80,
        rows: 24,
      }),
    )

    act(() => harness.emit('terminal.exit', { terminalId: 'terminal-1', exitCode: 0 }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.queryByText('Exited (0)')).toBeNull()
  })

  it('ends terminal resizing when the window loses focus', async () => {
    const harness = fakeTransport()
    const onHeightChange = vi.fn()
    render(
      <TerminalPane
        transport={harness.transport}
        threadId="thread-resize"
        height={260}
        theme="dark"
        onHeightChange={onHeightChange}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('terminal.open', {
        threadId: 'thread-resize',
        columns: 80,
        rows: 24,
      }),
    )

    const handle = screen.getByRole('separator', { name: 'Resize terminal' })
    fireEvent.pointerEnter(handle)
    fireEvent.pointerDown(handle, { clientY: 260, pointerId: 9 })
    fireEvent.pointerMove(window, { clientY: 220, pointerId: 9 })
    expect(haptics.prepareAppHaptics).toHaveBeenCalled()
    fireEvent.blur(window)

    expect(haptics.performAppHaptic).toHaveBeenCalledWith('alignment')
    expect(onHeightChange).toHaveBeenCalledWith(300)
    fireEvent.pointerMove(window, { clientY: 180, pointerId: 9 })
    expect(onHeightChange).toHaveBeenCalledTimes(1)
  })

  it('coalesces a burst of pointer resize work outside React', async () => {
    const harness = fakeTransport()
    const onHeightChange = vi.fn()
    let updateCommits = 0
    render(
      <Profiler
        id="terminal-resize"
        onRender={(_id, phase) => {
          if (phase === 'update') updateCommits += 1
        }}
      >
        <TerminalPane
          transport={harness.transport}
          threadId="thread-resize-baseline"
          height={260}
          theme="dark"
          onHeightChange={onHeightChange}
          onClose={vi.fn()}
        />
      </Profiler>,
    )
    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('terminal.open', {
        threadId: 'thread-resize-baseline',
        columns: 80,
        rows: 24,
      }),
    )
    await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy())
    updateCommits = 0

    const handle = screen.getByRole('separator', { name: 'Resize terminal' })
    fireEvent.pointerDown(handle, { clientY: 400, pointerId: 10 })
    for (let index = 0; index < 120; index += 1) {
      fireEvent.pointerMove(window, { clientY: 399 - index, pointerId: 10 })
    }

    expect(updateCommits).toBe(0)
    fireEvent.pointerUp(window, { clientY: 280, pointerId: 10 })
    expect(updateCommits).toBe(1)
    expect(onHeightChange).toHaveBeenCalledWith(380)
    expect(screen.getByLabelText('Session terminal').style.height).toBe('380px')
    expect(haptics.performAppHaptic).toHaveBeenCalledTimes(1)
  })

  it('does not repeat a PTY resize request for unchanged rows and columns', async () => {
    let resizeObserverCallback: ResizeObserverCallback | undefined
    const callbackObserver: ResizeObserver = {
      disconnect() {},
      observe() {},
      unobserve() {},
    }
    let frameId = 0
    const frames = new Map<number, FrameRequestCallback>()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeObserverCallback = callback
        }
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return []
        }
      },
    )
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameId += 1
      frames.set(frameId, callback)
      return frameId
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    const flushFrames = () => {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(performance.now())
    }
    const harness = fakeTransport()
    render(
      <TerminalPane
        transport={harness.transport}
        threadId="thread-resize-requests"
        height={260}
        theme="dark"
        onHeightChange={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('terminal.open', {
        threadId: 'thread-resize-requests',
        columns: 80,
        rows: 24,
      }),
    )
    await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy())
    const viewport = document.querySelector<HTMLElement>('.terminal-pane__viewport')
    if (!viewport) throw new Error('Terminal viewport not found')
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 300 },
    })
    frames.clear()
    harness.request.mockClear()
    xterm.fitRows = 25
    if (!resizeObserverCallback) throw new Error('Resize observer not ready')

    for (let index = 0; index < 10; index += 1) {
      resizeObserverCallback([], callbackObserver)
      flushFrames()
    }

    expect(
      harness.request.mock.calls.filter(([method]) => method === 'terminal.resize'),
    ).toHaveLength(1)
  })

  it('keeps workspace terminal status and focus framing out of the visible surface', async () => {
    const harness = fakeTransport()
    const { container } = render(
      <TerminalPane
        transport={harness.transport}
        threadId="thread-workspace"
        theme="dark"
        mode="workspace"
        onClose={vi.fn()}
      />,
    )

    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('terminal.open', {
        threadId: 'thread-workspace',
        columns: 80,
        rows: 24,
      }),
    )

    expect(container.querySelector('.terminal-pane__header')).toBeNull()
    expect(container.querySelector('.terminal-pane__status')).toBeNull()
    expect(screen.getByText('Connected').classList.contains('visually-hidden')).toBe(true)
    expect(container.querySelector('.terminal-pane__viewport')).toBeTruthy()
    expect(xterm.instances.at(-1)?.options).toMatchObject({
      cursorStyle: 'block',
      drawBoldTextInBrightColors: false,
      fontFamily: expect.stringContaining('JetBrainsMono Nerd Font Mono'),
      fontSize: 13,
      fontWeight: 400,
      fontWeightBold: 700,
      lineHeight: 1,
      minimumContrastRatio: 1.5,
      rescaleOverlappingGlyphs: true,
      scrollback: 10_000,
      theme: {
        background: '#0d0d0d',
        foreground: '#d8dee9',
        red: '#cc6566',
        blue: '#82a2be',
      },
    })
    expect(xterm.instances.at(-1)?.unicode.activeVersion).toBe('11')
  })

  it.each([
    ['workspace', { background: '#eff1f5' }, { background: '#0d0d0d' }],
    ['inline', { red: '#ca4a55' }, { red: '#e06c75' }],
  ] as const)(
    'repaints a %s terminal once the app applies a theme switch',
    async (mode, light, dark) => {
      const harness = fakeTransport()
      // App writes the theme onto the root in its own layout effect, which
      // React runs after the terminal's.
      function App(props: { theme: 'light' | 'dark' }) {
        useLayoutEffect(() => {
          document.documentElement.dataset['theme'] = props.theme
        }, [props.theme])
        return (
          <TerminalPane
            transport={harness.transport}
            threadId="thread-theme"
            theme={props.theme}
            mode={mode}
            onClose={vi.fn()}
          />
        )
      }
      document.documentElement.dataset['theme'] = 'light'
      const view = render(<App theme="light" />)
      const instance = xterm.instances[0]!
      expect(instance.options['theme']).toMatchObject(light)

      view.rerender(<App theme="dark" />)
      await waitFor(() => expect(instance.options['theme']).toMatchObject(dark))
      view.rerender(<App theme="light" />)
      await waitFor(() => expect(instance.options['theme']).toMatchObject(light))
      expect(xterm.instances).toHaveLength(1)
    },
  )

  it('repaints when the backdrop changes the terminal background, and only then', async () => {
    const harness = fakeTransport()
    render(
      <TerminalPane
        transport={harness.transport}
        threadId="thread-backdrop"
        theme="dark"
        mode="workspace"
        onClose={vi.fn()}
      />,
    )
    const instance = xterm.instances[0]!
    const initial = instance.options['theme']

    await act(async () => document.documentElement.style.setProperty('--rail-glass', '0.2'))
    expect(instance.options['theme']).toBe(initial)

    act(() => document.documentElement.style.setProperty('--terminal-workspace-bg', '#1b1f2a'))
    await waitFor(() =>
      expect(instance.options['theme']).toMatchObject({
        background: '#1b1f2a',
        cursorAccent: '#1b1f2a',
      }),
    )
  })

  it('closes a workspace terminal tab when its shell exits', async () => {
    const harness = fakeTransport()
    const onClose = vi.fn()
    render(
      <TerminalPane
        transport={harness.transport}
        threadId="thread-workspace-exit"
        theme="dark"
        mode="workspace"
        onClose={onClose}
      />,
    )

    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('terminal.open', {
        threadId: 'thread-workspace-exit',
        columns: 80,
        rows: 24,
      }),
    )

    act(() => harness.emit('terminal.exit', { terminalId: 'terminal-1', exitCode: 0 }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it.each(['', 'ready\r\n'])(
    'shows a workspace skeleton until the terminal connects with output %j',
    async (output) => {
      const snapshot = deferred<ResultOf<'terminal.status'>>()
      const harness = fakeTransport((method) =>
        method === 'terminal.status' ? snapshot.promise : undefined,
      )
      const { container } = render(
        <TerminalPane
          transport={harness.transport}
          threadId="workspace-loading"
          theme="dark"
          mode="workspace"
          onClose={vi.fn()}
        />,
      )
      const status = screen.getByRole('status')
      const viewport = container.querySelector('.terminal-pane__viewport')!
      expect(status.textContent).toBe('Connecting terminal…')
      expect(viewport.contains(status)).toBe(true)
      expect(viewport.getAttribute('aria-busy')).toBe('true')
      expect(status.querySelectorAll('.skeleton')).toHaveLength(5)
      expect(screen.getByText('Connecting…').classList.contains('visually-hidden')).toBe(true)
      expect(xterm.instances).toHaveLength(1)
      await waitFor(() =>
        expect(harness.request).toHaveBeenCalledWith('terminal.status', {
          terminalId: 'terminal-1',
        }),
      )

      await act(async () =>
        snapshot.resolve({ status: 'running', output, outputOffset: 0, exitCode: null }),
      )
      expect(screen.queryByRole('status')).toBeNull()
      expect(viewport.getAttribute('aria-busy')).toBe('false')
      expect(container.querySelector('.terminal-pane__viewport')).toBe(viewport)
      expect(written(xterm.instances[0]!)).toBe(output)
      expect(screen.getByText('Connected').classList.contains('visually-hidden')).toBe(true)
      act(() =>
        harness.emit('terminal.output', {
          terminalId: 'terminal-1',
          data: 'next',
          outputOffset: output.length,
        }),
      )
      expect(screen.queryByRole('status')).toBeNull()
      expect(written(xterm.instances[0]!)).toBe(`${output}next`)
    },
  )

  it('removes the workspace skeleton when connecting fails', async () => {
    const opened = deferred<{ terminalId: string }>()
    const harness = fakeTransport((method) =>
      method === 'terminal.open' ? opened.promise : undefined,
    )
    const { container } = render(
      <TerminalPane
        transport={harness.transport}
        threadId="workspace-loading-error"
        theme="dark"
        mode="workspace"
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByRole('status').textContent).toBe('Connecting terminal…')
    await act(async () => opened.reject(new Error('Shell unavailable')))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('Shell unavailable').classList.contains('visually-hidden')).toBe(false)
    expect(container.querySelector('.terminal-pane__viewport')?.getAttribute('aria-busy')).toBe(
      'false',
    )
  })

  it('keeps the existing inline connecting text without a workspace skeleton', async () => {
    const opened = deferred<{ terminalId: string }>()
    const harness = fakeTransport((method) =>
      method === 'terminal.open' ? opened.promise : undefined,
    )
    render(
      <TerminalPane
        transport={harness.transport}
        threadId="inline-loading"
        theme="dark"
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('Connecting…').classList.contains('visually-hidden')).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()
    await act(async () => opened.resolve({ terminalId: 'terminal-1' }))
    expect(screen.getByText('Connected')).toBeTruthy()
  })

  it('opens a project terminal before a chat exists', async () => {
    const harness = fakeTransport()
    render(
      <TerminalPane
        transport={harness.transport}
        projectPath="/workspace/current-project"
        theme="dark"
        mode="workspace"
        onClose={vi.fn()}
      />,
    )

    await waitFor(() =>
      expect(harness.request).toHaveBeenCalledWith('terminal.open', {
        projectPath: '/workspace/current-project',
        columns: 80,
        rows: 24,
      }),
    )
  })

  it('uses native copy chords without stealing interrupt on Windows and Linux', () => {
    const key = (overrides: Partial<KeyboardEvent> = {}) => ({
      altKey: false,
      ctrlKey: false,
      key: 'c',
      metaKey: false,
      shiftKey: false,
      type: 'keydown',
      ...overrides,
    })

    expect(terminalCopyShortcut(key({ metaKey: true }), true, true)).toBe(true)
    expect(terminalCopyShortcut(key({ ctrlKey: true, shiftKey: true }), true, false)).toBe(true)
    expect(terminalCopyShortcut(key({ ctrlKey: true }), true, false)).toBe(false)
    expect(terminalCopyShortcut(key({ ctrlKey: true, shiftKey: true }), false, false)).toBe(false)
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function written(instance: { write: ReturnType<typeof vi.fn> }) {
  return instance.write.mock.calls.map(([data]) => data).join('')
}

function fakeTransport(handle?: (method: string, params: Record<string, unknown>) => unknown) {
  let state: ConnectionState = 'open'
  const stateListeners = new Set<(value: ConnectionState) => void>()
  const channelListeners = new Map<string, Set<(value: unknown) => void>>()
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    const result = handle?.(method, params)
    if (result !== undefined) return result
    if (method === 'terminal.open') return { terminalId: 'terminal-1' }
    if (method === 'terminal.status')
      return { status: 'running', output: '', outputOffset: 0, exitCode: null }
    return {}
  })
  const transport = {
    get state() {
      return state
    },
    onState(listener: (value: ConnectionState) => void) {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    on(channel: string, listener: (value: unknown) => void) {
      const listeners = channelListeners.get(channel) ?? new Set()
      listeners.add(listener)
      channelListeners.set(channel, listeners)
      return () => listeners.delete(listener)
    },
    request,
  } as unknown as Transport

  return {
    transport,
    request,
    emit(channel: string, value: unknown) {
      for (const listener of channelListeners.get(channel) ?? []) listener(value)
    },
    setState(value: ConnectionState) {
      state = value
      for (const listener of stateListeners) listener(value)
    },
  }
}
