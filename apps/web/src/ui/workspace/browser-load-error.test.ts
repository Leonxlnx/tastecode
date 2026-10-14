import { describe, expect, it } from 'vitest'
import { browserLoadErrorMessage, loadRejectionFailure } from './browser-load-error.js'
import { PLAIN_HTTP_LOOPBACK_ONLY } from './browser-url.js'

describe('browserLoadErrorMessage', () => {
  it.each([
    [
      -105,
      'ERR_NAME_NOT_RESOLVED',
      'https://nope.invalid/',
      "Can't find nope.invalid. Check the address.",
    ],
    [
      -102,
      'ERR_CONNECTION_REFUSED',
      'http://127.0.0.1:4499/',
      '127.0.0.1:4499 refused the connection. Is the server running?',
    ],
    [-102, 'ERR_CONNECTION_REFUSED', 'https://example.com/', 'example.com refused the connection.'],
    [
      -107,
      'ERR_SSL_PROTOCOL_ERROR',
      'https://a.test:4432/',
      "Can't open a secure connection to a.test:4432.",
    ],
    [
      -202,
      'ERR_CERT_AUTHORITY_INVALID',
      'https://a.test/',
      "Can't open a secure connection to a.test.",
    ],
    [-118, 'ERR_CONNECTION_TIMED_OUT', 'https://a.test/', 'a.test took too long to respond.'],
    [-106, 'ERR_INTERNET_DISCONNECTED', 'https://a.test/', "You're offline."],
    [-20, 'ERR_BLOCKED_BY_CLIENT', 'http://example.com/', PLAIN_HTTP_LOOPBACK_ONLY],
    [-2, 'ERR_FAILED', 'https://a.test/', 'The page could not be loaded.'],
    [
      -999,
      'ERR_SOMETHING_NEW',
      'https://a.test/',
      'The page could not be loaded (ERR_SOMETHING_NEW).',
    ],
  ])('%i %s', (code, name, url, message) => {
    expect(browserLoadErrorMessage({ code, name, url })).toBe(message)
  })

  it('says nothing for a cancelled navigation', () => {
    expect(browserLoadErrorMessage({ code: -3, name: 'ERR_ABORTED' })).toBeUndefined()
    expect(browserLoadErrorMessage({ name: 'ABORTED' })).toBeUndefined()
  })

  it('reads bare names and falls back without a URL', () => {
    expect(browserLoadErrorMessage({ code: -105, name: 'NAME_NOT_RESOLVED' })).toBe(
      "Can't find the site. Check the address.",
    )
    expect(browserLoadErrorMessage({ code: -100, name: 'net::ERR_CONNECTION_CLOSED' })).toBe(
      'The site closed the connection.',
    )
    expect(browserLoadErrorMessage({ name: 'Something went wrong' })).toBe(
      'The page could not be loaded.',
    )
  })
})

describe('loadRejectionFailure', () => {
  it('reads the net error out of the wrapped Electron rejection', () => {
    const cause = new Error(
      "Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_NAME_NOT_RESOLVED (-105) loading 'https://nope.invalid/'",
    )
    expect(loadRejectionFailure(cause, 'https://nope.invalid/')).toEqual({
      name: 'ERR_NAME_NOT_RESOLVED',
      code: -105,
      url: 'https://nope.invalid/',
    })
    expect(loadRejectionFailure(new Error('boom'), 'https://a.test/')).toEqual({
      url: 'https://a.test/',
    })
  })
})
