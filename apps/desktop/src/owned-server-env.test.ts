import { describe, expect, it } from 'vitest'
import { ownedServerEnvironment } from './owned-server-env.js'

const html = (url: string) =>
  `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' ${url}; img-src 'self'">`

describe('owned server endpoint', () => {
  it('uses the packaged renderer endpoint instead of an inherited port override', () => {
    const inherited = {
      HARNESS_PORT: '5555',
      HARNESS_HOST: '0.0.0.0',
      HARNESS_RENDERER_ORIGIN: 'http://127.0.0.1:5183',
      PATH: 'retained',
    }
    expect(ownedServerEnvironment(inherited, html('ws://127.0.0.1:4311'))).toEqual({
      HARNESS_PORT: '4311',
      HARNESS_HOST: '127.0.0.1',
      HARNESS_RENDERER_ORIGIN: 'file://',
      PATH: 'retained',
    })
    expect(inherited.HARNESS_PORT).toBe('5555')
  })

  it('honors a custom endpoint compiled into the renderer and its CSP', () => {
    expect(ownedServerEnvironment({}, html('ws://127.0.0.1:5555')).HARNESS_PORT).toBe('5555')
  })

  it('preserves isolated server ports while trusting only the file renderer', () => {
    expect(ownedServerEnvironment({ HARNESS_PORT: '5555' })).toEqual({
      HARNESS_PORT: '5555',
      HARNESS_RENDERER_ORIGIN: 'file://',
    })
  })

  it.each(['wss://example.com/', 'ws://192.168.1.1:4311', 'ws://user:pass@127.0.0.1:4311'])(
    'rejects an unsupported packaged endpoint %s',
    (url) => {
      expect(() => ownedServerEnvironment({}, html(url))).toThrow('loopback')
    },
  )

  it('rejects a missing or ambiguous endpoint instead of splitting server and renderer', () => {
    expect(() => ownedServerEnvironment({}, '<html></html>')).toThrow('no local server endpoint')
    expect(() =>
      ownedServerEnvironment({}, html('ws://127.0.0.1:4311 ws://127.0.0.1:5555')),
    ).toThrow('no local server endpoint')
  })
})
