import { describe, expect, it } from 'vitest'
import { allowsPreviewNavigation } from './preview-navigation.js'

describe('preview navigation', () => {
  it('keeps the capture window on its preview origin', () => {
    expect(allowsPreviewNavigation('http://127.0.0.1:5183/', 'http://127.0.0.1:5183/about')).toBe(
      true,
    )
    expect(allowsPreviewNavigation('http://127.0.0.1:5183/', 'https://example.com/')).toBe(false)
    expect(allowsPreviewNavigation('http://127.0.0.1:5183/', 'http://127.0.0.1:4311/')).toBe(false)
  })
})
