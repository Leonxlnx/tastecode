import { describe, expect, it } from 'vitest'
import { assertSafeBind, hasAccess } from './server.js'

describe('server access token', () => {
  it('leaves the loopback server open when no token is configured', () => {
    expect(hasAccess(undefined, undefined)).toBe(true)
  })

  it('refuses an unauthenticated external bind', () => {
    expect(() => assertSafeBind('0.0.0.0', undefined)).toThrow('HARNESS_ACCESS_TOKEN')
    expect(() => assertSafeBind('192.168.1.4', '')).toThrow('HARNESS_ACCESS_TOKEN')
    expect(() => assertSafeBind('0.0.0.0', 'secret')).not.toThrow()
    expect(() => assertSafeBind('127.0.0.1', undefined)).not.toThrow()
    expect(() => assertSafeBind('::1', undefined)).not.toThrow()
  })

  it('requires the exact configured token', () => {
    expect(hasAccess('/?token=correct-token', 'correct-token')).toBe(true)
    expect(hasAccess('/?token=wrong-token', 'correct-token')).toBe(false)
    expect(hasAccess('/', 'correct-token')).toBe(false)
  })
})
