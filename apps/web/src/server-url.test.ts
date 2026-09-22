import { describe, expect, it } from 'vitest'
import { runtimeServerPort, serverBaseUrl } from './server-url.js'

describe('runtimeServerPort', () => {
  it('reads the port the shell put on the page URL', () => {
    expect(runtimeServerPort('?harnessPort=4423')).toBe(4423)
    expect(runtimeServerPort('?harnessPort=4423&other=1')).toBe(4423)
  })

  it('ignores a missing or unusable parameter', () => {
    expect(runtimeServerPort('')).toBeUndefined()
    expect(runtimeServerPort('?other=1')).toBeUndefined()
    expect(runtimeServerPort('?harnessPort=abc')).toBeUndefined()
    expect(runtimeServerPort('?harnessPort=80')).toBeUndefined()
    expect(runtimeServerPort('?harnessPort=65536')).toBeUndefined()
  })
})

describe('serverBaseUrl', () => {
  it('uses an explicit development URL when provided', () => {
    expect(serverBaseUrl('ws://127.0.0.1:4400')).toBe('ws://127.0.0.1:4400')
    expect(serverBaseUrl('ws://127.0.0.1:4400', 4423)).toBe('ws://127.0.0.1:4400')
  })

  it('builds the loopback socket from the runtime port', () => {
    expect(serverBaseUrl(undefined, 4423)).toBe('ws://127.0.0.1:4423')
  })

  it('defaults to the loopback control socket', () => {
    expect(serverBaseUrl(undefined)).toBe('ws://127.0.0.1:4311')
  })
})
