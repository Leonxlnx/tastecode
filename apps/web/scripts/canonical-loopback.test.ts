import { describe, expect, it } from 'vitest'
import { canonicalLoopbackRedirect } from './canonical-loopback.js'

describe('canonicalLoopbackRedirect', () => {
  it('redirects localhost and IPv6 loopback GET/HEAD requests to 127.0.0.1', () => {
    expect(canonicalLoopbackRedirect('GET', 'localhost:5183', '/', 5183)).toBe(
      'http://127.0.0.1:5183/',
    )
    expect(canonicalLoopbackRedirect('HEAD', 'LOCALHOST:5183', '/chat?id=1', 5183)).toBe(
      'http://127.0.0.1:5183/chat?id=1',
    )
    expect(canonicalLoopbackRedirect('GET', '[::1]:5183', '/settings', 5183)).toBe(
      'http://127.0.0.1:5183/settings',
    )
  })

  it('leaves canonical 127.0.0.1, other hosts, and non-GET/HEAD requests alone', () => {
    expect(canonicalLoopbackRedirect('GET', '127.0.0.1:5183', '/', 5183)).toBeUndefined()
    expect(canonicalLoopbackRedirect('GET', 'localhost:3000', '/', 5183)).toBeUndefined()
    expect(canonicalLoopbackRedirect('GET', 'example.com:5183', '/', 5183)).toBeUndefined()
    expect(canonicalLoopbackRedirect('POST', 'localhost:5183', '/', 5183)).toBeUndefined()
  })

  it('collapses leading slashes so protocol-relative URLs cannot open-redirect', () => {
    expect(canonicalLoopbackRedirect('GET', 'localhost:5183', '//evil.example/path', 5183)).toBe(
      'http://127.0.0.1:5183/evil.example/path',
    )
  })
})
