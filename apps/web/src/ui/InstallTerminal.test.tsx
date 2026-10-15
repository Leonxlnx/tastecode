// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TestTransport } from '../test-transport.js'
import { InstallTerminal } from './InstallTerminal.js'

const xterm = vi.hoisted(() => ({
  instances: [] as Array<{ options: Record<string, unknown> }>,
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
    options: Record<string, unknown>
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    reset() {}
    write() {}
    attachCustomKeyEventHandler() {}
    onData() {
      return { dispose() {} }
    }
    constructor(options: Record<string, unknown> = {}) {
      this.options = options
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
  delete document.documentElement.dataset['theme']
  vi.unstubAllGlobals()
})

describe('InstallTerminal', () => {
  it('follows a theme switch without reopening the log', async () => {
    document.documentElement.dataset['theme'] = 'light'
    render(
      <InstallTerminal transport={new TestTransport()} installKey="codex" profile="workspace" />,
    )
    const instance = xterm.instances[0]!
    expect(instance.options['theme']).toMatchObject({ background: '#eff1f5' })

    act(() => {
      document.documentElement.dataset['theme'] = 'dark'
    })
    await waitFor(() => expect(instance.options['theme']).toMatchObject({ background: '#0d0d0d' }))
    expect(xterm.instances).toHaveLength(1)
  })
})
