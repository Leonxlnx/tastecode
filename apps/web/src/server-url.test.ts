import { describe, expect, it } from 'vitest'
import { serverUrl } from './server-url.js'

describe('serverUrl', () => {
  it('adds the access token from the URL fragment', () => {
    expect(serverUrl('ws://100.64.0.1:4311', '#access_token=phone-secret')).toBe(
      'ws://100.64.0.1:4311/?token=phone-secret',
    )
  })

  it('keeps the normal loopback URL unchanged', () => {
    expect(serverUrl('ws://127.0.0.1:4311', '')).toBe('ws://127.0.0.1:4311')
  })
})
