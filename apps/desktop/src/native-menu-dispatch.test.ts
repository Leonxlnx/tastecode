import { describe, expect, it } from 'vitest'
import type { NativeMenuActionMessage } from './menu-contract.js'
import { isNativeMenuActionMessage } from './menu-contract.js'
import { NativeMenuDispatch } from './native-menu-dispatch.js'

function target() {
  const sent: NativeMenuActionMessage[] = []
  let destroyed = false
  return {
    sent,
    destroy: () => {
      destroyed = true
    },
    isDestroyed: () => destroyed,
    send: (_channel: 'harness:menuAction', message: NativeMenuActionMessage) => {
      sent.push(message)
    },
  }
}

describe('native menu dispatch', () => {
  it('holds actions for a loading window until its listener is ready', () => {
    const dispatch = new NativeMenuDispatch<ReturnType<typeof target>>()
    const window = target()

    dispatch.send(window, { action: 'settings', source: 'menu' })
    expect(window.sent).toEqual([])
    dispatch.markReady(window)
    expect(window.sent).toEqual([{ action: 'settings', source: 'menu' }])
    dispatch.send(window, { action: 'newChat', source: 'accelerator' })
    expect(window.sent).toHaveLength(2)
  })

  it('waits again after a reload and drops actions for a destroyed window', () => {
    const dispatch = new NativeMenuDispatch<ReturnType<typeof target>>()
    const window = target()
    dispatch.markReady(window)

    dispatch.reset(window)
    dispatch.send(window, { action: 'commandPalette', source: 'menu' })
    expect(window.sent).toEqual([])
    window.destroy()
    dispatch.markReady(window)
    dispatch.send(window, { action: 'newChat', source: 'menu' })
    expect(window.sent).toEqual([])
  })

  it('accepts only a known action with its source', () => {
    expect(isNativeMenuActionMessage({ action: 'settings', source: 'accelerator' })).toBe(true)
    expect(isNativeMenuActionMessage('settings')).toBe(false)
    expect(isNativeMenuActionMessage({ action: 'settings', source: 'keyboard' })).toBe(false)
    expect(isNativeMenuActionMessage({ action: 'run', source: 'menu' })).toBe(false)
    expect(isNativeMenuActionMessage({ action: 'settings', source: 'menu', extra: true })).toBe(
      false,
    )
  })
})
