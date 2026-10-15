import { describe, expect, it } from 'vitest'
import { browserPageLabel } from './browser-page.js'

describe('browserPageLabel', () => {
  it('prefers the page title, then the host, then New tab', () => {
    expect(browserPageLabel({ url: 'https://example.com/docs', title: '  Docs · Example ' })).toBe(
      'Docs · Example',
    )
    expect(browserPageLabel({ url: 'http://127.0.0.1:5173/app', title: '' })).toBe('127.0.0.1:5173')
    expect(browserPageLabel({ url: '', title: '' })).toBe('New tab')
    expect(browserPageLabel(undefined)).toBe('New tab')
  })
})
