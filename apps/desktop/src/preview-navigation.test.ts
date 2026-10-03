import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { allowsPreviewNavigation, configurePreviewNavigation } from './preview-navigation.js'

describe('preview navigation', () => {
  it('allows cross-origin iframe redirects while confining the top-level document', () => {
    const contents = new EventEmitter()
    configurePreviewNavigation(contents as unknown as WebContents, 'http://127.0.0.1:5183/')
    const preventDefault = vi.fn()
    contents.emit('will-redirect', {
      isMainFrame: false,
      url: 'https://example.com/iframe',
      preventDefault,
    })
    expect(preventDefault).not.toHaveBeenCalled()
    contents.emit('will-redirect', {
      isMainFrame: true,
      url: 'http://127.0.0.1:5183/next',
      preventDefault,
    })
    expect(preventDefault).not.toHaveBeenCalled()
    contents.emit('will-redirect', {
      isMainFrame: true,
      url: 'https://example.com/',
      preventDefault,
    })
    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('keeps the capture window on its preview origin', () => {
    expect(allowsPreviewNavigation('http://127.0.0.1:5183/', 'http://127.0.0.1:5183/about')).toBe(
      true,
    )
    expect(allowsPreviewNavigation('http://127.0.0.1:5183/', 'https://example.com/')).toBe(false)
    expect(allowsPreviewNavigation('http://127.0.0.1:5183/', 'http://127.0.0.1:4311/')).toBe(false)
  })
})
