import { describe, expect, it } from 'vitest'
import { parseServerPort, resolveServerPort } from './server-port.js'

describe('parseServerPort', () => {
  it('accepts an unprivileged port', () => {
    expect(parseServerPort('4423')).toBe(4423)
    expect(parseServerPort('1024')).toBe(1024)
    expect(parseServerPort('65535')).toBe(65_535)
  })

  it('rejects privileged and out-of-range ports', () => {
    expect(parseServerPort('80')).toBeUndefined()
    expect(parseServerPort('1023')).toBeUndefined()
    expect(parseServerPort('65536')).toBeUndefined()
    expect(parseServerPort('0')).toBeUndefined()
  })

  it('rejects anything that is not whole digits', () => {
    expect(parseServerPort('abc')).toBeUndefined()
    expect(parseServerPort('4423.5')).toBeUndefined()
    expect(parseServerPort('-4423')).toBeUndefined()
    expect(parseServerPort(' 4423')).toBeUndefined()
    expect(parseServerPort('4423 ')).toBeUndefined()
    expect(parseServerPort('')).toBeUndefined()
  })
})

describe('resolveServerPort', () => {
  it('falls back to the shared default when unset', () => {
    expect(resolveServerPort(undefined)).toBe(4311)
  })

  it('uses a valid configured port', () => {
    expect(resolveServerPort('4423')).toBe(4423)
  })

  it('falls back on invalid input instead of failing', () => {
    expect(resolveServerPort('abc')).toBe(4311)
    expect(resolveServerPort('80')).toBe(4311)
  })
})
