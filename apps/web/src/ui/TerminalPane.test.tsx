// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionState, Transport } from '../transport.js'
import { TerminalPane } from './TerminalPane.js'

const xterm = vi.hoisted(() => ({
  instances: [] as Array<{
    data: ((data: string) => void) | undefined
    selectionChanged: (() => void) | undefined
    selected: boolean
    write: ReturnType<typeof vi.fn>
    clear: ReturnType<typeof vi.fn>
  }>,
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options = {}
    data: ((data: string) => void) | undefined
    selectionChanged: (() => void) | undefined
    selected = false
    write = vi.fn()
    clear = vi.fn()
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
    constructor() {
      xterm.instances.push(this)
    }
  },
}))

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  xterm.instances.length = 0
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('TerminalPane', () => {
  it('opens, streams, reconnects, copies, and closes one session terminal', async () => {
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
    await waitFor(() =>
      expect(
        harness.request.mock.calls.filter(([method]) => method === 'terminal.open'),
      ).toHaveLength(initialOpenCount + 1),
    )

    act(() => harness.emit('terminal.exit', { terminalId: 'terminal-1', exitCode: 0 }))
    expect(screen.getByText('Exited (0)')).toBeTruthy()
    fireEvent.click(screen.getByTitle('Restart terminal'))
    await waitFor(() =>
      expect(
        harness.request.mock.calls.filter(([method]) => method === 'terminal.open'),
      ).toHaveLength(initialOpenCount + 2),
    )
    fireEvent.click(screen.getByTitle('Close terminal'))
    expect(onClose).toHaveBeenCalledOnce()

    view.unmount()
    expect(harness.request).toHaveBeenCalledWith('terminal.close', {
      terminalId: 'terminal-1',
    })
    expect(
      harness.request.mock.calls.filter(([method]) => method === 'terminal.close'),
    ).toHaveLength(1)
  })
})

function fakeTransport() {
  let state: ConnectionState = 'open'
  const stateListeners = new Set<(value: ConnectionState) => void>()
  const channelListeners = new Map<string, Set<(value: unknown) => void>>()
  const request = vi.fn((method: string) =>
    Promise.resolve(method === 'terminal.open' ? { terminalId: 'terminal-1' } : {}),
  )
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
