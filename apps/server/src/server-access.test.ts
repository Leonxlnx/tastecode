import { describe, expect, it } from 'vitest'
import { assertSafeBind, hasAccess } from './server.js'

describe('server access token', () => {
  it('leaves native loopback clients open when no token is configured', () => {
    expect(hasAccess(undefined, undefined)).toBe(true)
  })

  it('rejects arbitrary browser origins when no token is configured', () => {
    expect(hasAccess(undefined, undefined, 'https://attacker.example')).toBe(false)
    expect(hasAccess(undefined, undefined, 'null')).toBe(false)
    expect(hasAccess(undefined, undefined, 'null', 'Mozilla/5.0 Electron/43.2.0')).toBe(true)
    expect(hasAccess(undefined, undefined, 'http://127.0.0.1:5183')).toBe(true)
    expect(hasAccess(undefined, undefined, 'file://')).toBe(true)
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

  it('lets an originless CLI use a token-protected server only through loopback', () => {
    expect(hasAccess('/', 'ephemeral-dev-token', undefined, undefined, '127.0.0.1')).toBe(true)
    expect(hasAccess('/', 'ephemeral-dev-token', undefined, undefined, '::ffff:127.0.0.1')).toBe(
      true,
    )
    expect(hasAccess('/', 'ephemeral-dev-token', undefined, undefined, '100.101.22.33')).toBe(false)
    expect(
      hasAccess('/', 'ephemeral-dev-token', 'https://attacker.example', undefined, '127.0.0.1'),
    ).toBe(false)
  })
})
