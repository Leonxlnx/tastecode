import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { configureRendererLifecycle } from './renderer-lifecycle.js'

function fixture() {
  const contents = Object.assign(new EventEmitter(), {
    reload: vi.fn(),
    isDestroyed: vi.fn(() => false),
  })
  const options = {
    cancelCaptures: vi.fn(),
    isQuitting: vi.fn(() => false),
    onRepeatedCrash: vi.fn(),
  }
  configureRendererLifecycle(contents as unknown as WebContents, options)
  return { contents, ...options }
}

describe('renderer lifecycle', () => {
  it('recovers a crashed renderer once without restarting the server or looping', () => {
    const test = fixture()
    test.contents.emit('render-process-gone')
    expect(test.contents.reload).toHaveBeenCalledOnce()
    test.contents.emit('render-process-gone')
    expect(test.contents.reload).toHaveBeenCalledOnce()
    expect(test.onRepeatedCrash).toHaveBeenCalledOnce()
    expect(test.cancelCaptures).toHaveBeenCalledTimes(2)
  })

  it('cancels captures on reload and destruction but not hash or iframe navigation', () => {
    const test = fixture()
    test.contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    test.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(test.cancelCaptures).not.toHaveBeenCalled()
    test.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(test.cancelCaptures).toHaveBeenCalledOnce()
    test.contents.emit('destroyed')
    expect(test.cancelCaptures).toHaveBeenCalledTimes(2)
  })

  it('never revives a renderer during quit', () => {
    const test = fixture()
    test.isQuitting.mockReturnValue(true)
    test.contents.emit('render-process-gone')
    expect(test.contents.reload).not.toHaveBeenCalled()
    expect(test.cancelCaptures).toHaveBeenCalledOnce()
  })
})
