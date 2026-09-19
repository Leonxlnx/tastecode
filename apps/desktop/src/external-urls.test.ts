import { describe, expect, it } from 'vitest'
import { assertSupportedExternalUrl, isSupportedExternalUrl } from './external-urls.js'

describe('external url policy', () => {
  it('allows only http(s) for external opens', () => {
    expect(isSupportedExternalUrl('https://example.com/docs')).toBe(true)
    expect(isSupportedExternalUrl('http://127.0.0.1:4311/preview')).toBe(true)
    for (const value of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
      'ftp://example.com/file',
      'mailto:someone@example.com',
      'about:blank',
      '',
      'not a url',
      undefined,
      null,
      42,
    ]) {
      expect(isSupportedExternalUrl(value)).toBe(false)
    }
  })

  it('names the rejected scheme so the failure is actionable', () => {
    expect(assertSupportedExternalUrl('https://example.com/')).toBe('https://example.com/')
    expect(() => assertSupportedExternalUrl('file:///etc/passwd')).toThrow('file:')
    expect(() => assertSupportedExternalUrl('javascript:alert(1)')).toThrow('javascript:')
    expect(() => assertSupportedExternalUrl('not a url')).toThrow('only http(s)')
    expect(() => assertSupportedExternalUrl(undefined)).toThrow('only http(s)')
  })
})
