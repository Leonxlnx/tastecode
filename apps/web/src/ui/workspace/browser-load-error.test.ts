import { describe, expect, it } from 'vitest'
import { browserLoadFailureView, loadRejectionFailure } from './browser-load-error.js'
import { PLAIN_HTTP_LOOPBACK_ONLY } from './browser-url.js'

describe('browserLoadFailureView', () => {
  it.each([
    [
      -105,
      'ERR_NAME_NOT_RESOLVED',
      'https://nope.invalid/',
      "Can't reach nope.invalid",
      'No site answers at this address. Check it for typos.',
    ],
    [
      -102,
      'ERR_CONNECTION_REFUSED',
      'http://127.0.0.1:4499/',
      "Can't reach 127.0.0.1:4499",
      'Nothing is listening on this port. Is the server running?',
    ],
    [
      -102,
      'ERR_CONNECTION_REFUSED',
      'https://example.com/',
      "Can't reach example.com",
      'The site refused the connection.',
    ],
    [
      -107,
      'ERR_SSL_PROTOCOL_ERROR',
      'https://a.test:4432/',
      "Can't reach a.test:4432",
      'A secure connection could not be made.',
    ],
    [
      -202,
      'ERR_CERT_AUTHORITY_INVALID',
      'https://a.test/',
      "Can't reach a.test",
      'A secure connection could not be made.',
    ],
    [
      -118,
      'ERR_CONNECTION_TIMED_OUT',
      'https://a.test/',
      "Can't reach a.test",
      'The site took too long to respond.',
    ],
    [
      -106,
      'ERR_INTERNET_DISCONNECTED',
      'https://a.test/',
      "Can't reach a.test",
      "You're offline. Check your connection and try again.",
    ],
    [
      -20,
      'ERR_BLOCKED_BY_CLIENT',
      'http://example.com/',
      "Can't reach example.com",
      PLAIN_HTTP_LOOPBACK_ONLY,
    ],
    [-2, 'ERR_FAILED', 'https://a.test/', "Can't reach a.test", 'The page could not be loaded.'],
    [
      -999,
      'ERR_SOMETHING_NEW',
      'https://a.test/',
      "Can't reach a.test",
      'The page could not be loaded (ERR_SOMETHING_NEW).',
    ],
  ])('%i %s', (code, name, url, title, detail) => {
    expect(browserLoadFailureView({ code, name, url })).toEqual({ title, detail })
  })

  it('names the host only in the title, so the sentence never repeats it', () => {
    const view = browserLoadFailureView({
      code: -105,
      name: 'ERR_NAME_NOT_RESOLVED',
      url: 'https://nonexistent-host.invalid/',
    })
    expect(view?.title).toBe("Can't reach nonexistent-host.invalid")
    expect(view?.detail).not.toContain('nonexistent-host.invalid')
  })

  it('says nothing for a cancelled navigation', () => {
    expect(browserLoadFailureView({ code: -3, name: 'ERR_ABORTED' })).toBeUndefined()
    expect(browserLoadFailureView({ name: 'ABORTED' })).toBeUndefined()
  })

  it('reads bare names and falls back without a URL', () => {
    expect(browserLoadFailureView({ code: -105, name: 'NAME_NOT_RESOLVED' })).toEqual({
      title: "Can't reach this page",
      detail: 'No site answers at this address. Check it for typos.',
    })
    expect(browserLoadFailureView({ code: -100, name: 'net::ERR_CONNECTION_CLOSED' })).toEqual({
      title: "Can't reach this page",
      detail: 'The connection closed before the page loaded.',
    })
    expect(browserLoadFailureView({ name: 'Something went wrong' })?.detail).toBe(
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
