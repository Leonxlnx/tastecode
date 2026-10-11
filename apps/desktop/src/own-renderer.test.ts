import { describe, expect, it } from 'vitest'
import { isRendererFileUrl, rendererFileUrl } from './own-renderer.js'

describe('isRendererFileUrl', () => {
  it('matches the loaded renderer whatever case Windows started it with', () => {
    const index = 'c:\\Users\\me\\AppData\\Local\\Programs\\TasteCode\\resources\\web\\index.html'
    const url =
      'file:///C:/Users/me/AppData/Local/Programs/TasteCode/resources/web/index.html#/chat?x=1'
    expect(isRendererFileUrl(url, index, true)).toBe(true)
  })

  it('rejects other files and schemes', () => {
    const index = 'C:\\TasteCode\\resources\\web\\index.html'
    expect(isRendererFileUrl('file:///C:/TasteCode/resources/web/other.html', index, true)).toBe(
      false,
    )
    expect(isRendererFileUrl('file:///D:/TasteCode/resources/web/index.html', index, true)).toBe(
      false,
    )
    expect(isRendererFileUrl('https://example.com/index.html', index, true)).toBe(false)
  })

  it('stays exact on case-sensitive POSIX paths', () => {
    const index = '/Applications/TasteCode.app/Contents/Resources/web/index.html'
    expect(isRendererFileUrl(`file://${index}`, index, false)).toBe(true)
    expect(isRendererFileUrl(`file://${index.toLowerCase()}`, index, false)).toBe(false)
  })

  it('recognizes the URL it loads the renderer from', () => {
    // Chromium reports the canonical form of whatever URL was loaded.
    const loaded = (index: string) => new URL(rendererFileUrl(index)).href
    const windows = 'C:\\Program Files\\TasteCode\\resources\\web\\index.html'
    const posix = '/Applications/TasteCode.app/Contents/Resources/web/index.html'
    expect(isRendererFileUrl(loaded(windows), windows, true)).toBe(true)
    expect(isRendererFileUrl(loaded(posix), posix, false)).toBe(true)
  })
})
