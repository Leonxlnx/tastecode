import { describe, expect, it } from 'vitest'
import { browserUrl } from './browser-url.js'

describe('browserUrl', () => {
  it('defaults public hostnames to HTTPS', () => {
    expect(browserUrl('example.com/path')).toBe('https://example.com/path')
  })

  it('keeps local development addresses on HTTP', () => {
    expect(browserUrl('localhost:4311')).toBe('http://127.0.0.1:4311/')
    expect(browserUrl('http://[::1]:4311')).toBe('http://127.0.0.1:4311/')
    expect(browserUrl('127.0.0.1:5183/preview')).toBe('http://127.0.0.1:5183/preview')
  })

  it('rejects privileged protocols', () => {
    expect(browserUrl('file:///tmp/private')).toBeUndefined()
    expect(browserUrl('javascript://alert(1)')).toBeUndefined()
  })
})
