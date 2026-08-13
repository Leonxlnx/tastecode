// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionState, Transport } from '../transport.js'
import { TerminalPane, terminalCopyShortcut } from './TerminalPane.js'

const xterm = vi.hoisted(() => ({
  instances: [] as Array<{
    data: ((data: string) => void) | undefined
    selectionChanged: (() => void) | undefined
    selected: boolean
    write: ReturnType<typeof vi.fn>
    clear: ReturnType<typeof vi.fn>
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
    fit() {}
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

vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

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
})

afterEach(() => {
  cleanup()
  document.documentElement.style.removeProperty('--font-terminal')
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
    expect(haptics.performAppHaptic).toHaveBeenCalledWith('alignment')
    fireEvent.blur(window)

    expect(onHeightChange).toHaveBeenCalledWith(300)
    fireEvent.pointerMove(window, { clientY: 180, pointerId: 9 })
    expect(onHeightChange).toHaveBeenCalledTimes(1)
  })

  it('keeps workspace terminal status and focus framing out of the visible surface', async () => {
    const harness = fakeTransport()
    const { container } = render(
      <TerminalPane
        transport={harness.transport}
        threadId="thread-workspace"
        theme="dark"
        mode="workspace"
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
      fontSize: 17,
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

  it('opens a project terminal before a chat exists', async () => {
    const harness = fakeTransport()
    render(
      <TerminalPane
        transport={harness.transport}
        projectPath="/workspace/current-project"
        theme="dark"
        mode="workspace"
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
