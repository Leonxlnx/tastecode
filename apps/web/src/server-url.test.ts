import { describe, expect, it } from 'vitest'
import { serverBaseUrl } from './server-url.js'

describe('serverBaseUrl', () => {
  it('uses an explicit development URL when provided', () => {
    expect(serverBaseUrl('ws://127.0.0.1:4400')).toBe('ws://127.0.0.1:4400')
  })

  it('defaults to the loopback control socket', () => {
    expect(serverBaseUrl(undefined)).toBe('ws://127.0.0.1:4311')
  })
})
