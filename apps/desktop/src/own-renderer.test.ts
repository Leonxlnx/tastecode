import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isRendererFileUrl } from './own-renderer.js'

describe('isRendererFileUrl', () => {
  it('matches only the loaded renderer file', () => {
    const index = path.resolve('resources', 'web', 'index.html')
    const url = pathToFileURL(index)
    url.hash = '/chat'
    expect(isRendererFileUrl(url.href, index)).toBe(true)
    expect(isRendererFileUrl(pathToFileURL(path.resolve('other.html')).href, index)).toBe(false)
    expect(isRendererFileUrl('https://example.com/index.html', index)).toBe(false)
  })
})
