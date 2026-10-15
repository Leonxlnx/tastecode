import { describe, expect, it } from 'vitest'
import { browserAddress, PLAIN_HTTP_LOOPBACK_ONLY } from './browser-url.js'

describe('browserAddress', () => {
  it('defaults public hostnames to HTTPS', () => {
    expect(browserAddress('example.com/path')).toEqual({ url: 'https://example.com/path' })
    expect(browserAddress('  example.com  ')).toEqual({ url: 'https://example.com/' })
    expect(browserAddress('https://192.168.0.10/')).toEqual({ url: 'https://192.168.0.10/' })
  })

  it('keeps local development addresses on HTTP', () => {
    expect(browserAddress('localhost:4311').url).toBe('http://127.0.0.1:4311/')
    expect(browserAddress('http://[::1]:4311').url).toBe('http://127.0.0.1:4311/')
    expect(browserAddress('[::1]:4311').url).toBe('http://127.0.0.1:4311/')
    expect(browserAddress('127.0.0.1:5183/preview').url).toBe('http://127.0.0.1:5183/preview')
    expect(browserAddress('localhost:3000?x').url).toBe('http://127.0.0.1:3000/?x')
    expect(browserAddress('127.0.0.1:3000#frag').url).toBe('http://127.0.0.1:3000/#frag')
  })

  it('treats *.localhost and 0.0.0.0 as loopback like the desktop shell does', () => {
    expect(browserAddress('myapp.localhost:4432').url).toBe('http://myapp.localhost:4432/')
    expect(browserAddress('http://api.myapp.localhost/').url).toBe('http://api.myapp.localhost/')
    expect(browserAddress('0.0.0.0:4432').url).toBe('http://127.0.0.1:4432/')
    expect(browserAddress('http://0.0.0.0:5173/app').url).toBe('http://127.0.0.1:5173/app')
  })

  it('refuses plain HTTP off loopback with the reason instead of loading it', () => {
    expect(browserAddress('http://example.com/')).toEqual({ error: PLAIN_HTTP_LOOPBACK_ONLY })
    expect(browserAddress('192.168.0.10:5173')).toEqual({ error: PLAIN_HTTP_LOOPBACK_ONLY })
    expect(browserAddress('[fe80::1]:5173')).toEqual({ error: PLAIN_HTTP_LOOPBACK_ONLY })
  })

  it('refuses text that is not an address', () => {
    expect(browserAddress('')).toEqual({ error: 'Enter a URL.' })
    expect(browserAddress('not a url')).toEqual({ error: 'Enter a valid URL.' })
    expect(browserAddress('javascript:alert(1)')).toEqual({ error: 'Enter a valid URL.' })
  })

  it('rejects privileged protocols', () => {
    expect(browserAddress('file:///tmp/private')).toEqual({
      error: 'Enter a valid HTTP or HTTPS URL.',
    })
    expect(browserAddress('javascript://alert(1)').url).toBeUndefined()
  })
})
