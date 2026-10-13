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
    onPageReplaced: vi.fn(),
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

  it('cancels captures on a committed page load and destruction but not hash or iframe navigation', () => {
    const test = fixture()
    test.contents.emit('did-navigate-in-page', {}, 'file:///app/index.html#settings', true)
    test.contents.emit('did-frame-navigate', {}, 'https://example.com/', 200, 'OK', false)
    expect(test.cancelCaptures).not.toHaveBeenCalled()
    test.contents.emit('did-navigate', {}, 'file:///app/index.html', 200, 'OK')
    expect(test.cancelCaptures).toHaveBeenCalledOnce()
    expect(test.onPageReplaced).toHaveBeenCalledOnce()
    test.contents.emit('destroyed')
    expect(test.cancelCaptures).toHaveBeenCalledTimes(2)
  })

  it('keeps the page state when a started navigation is blocked before it commits', () => {
    const test = fixture()
    // Electron emits did-start-navigation before will-navigate can cancel a
    // same-window link, so the old page is still loaded and listening.
    test.contents.emit('did-start-navigation', {
      url: 'file:///C:/api/users',
      isMainFrame: true,
      isSameDocument: false,
    })
    expect(test.cancelCaptures).not.toHaveBeenCalled()
    expect(test.onPageReplaced).not.toHaveBeenCalled()
  })

  it('never revives a renderer during quit', () => {
    const test = fixture()
    test.isQuitting.mockReturnValue(true)
    test.contents.emit('render-process-gone')
    expect(test.contents.reload).not.toHaveBeenCalled()
    expect(test.cancelCaptures).toHaveBeenCalledOnce()
  })
})
