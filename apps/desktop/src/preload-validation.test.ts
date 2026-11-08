import { describe, expect, it } from 'vitest'
import {
  droppedFilePath,
  isAppUpdateState,
  isFiniteNumber,
  isOwnServerToken,
} from './preload-validation.js'

describe('preload validation', () => {
  it('uses the native File lookup rather than a supplied path property', () => {
    const file = { path: '/forged.txt' } as unknown as File
    expect(droppedFilePath(file, () => '/native/large.zip')).toBe('/native/large.zip')
    expect(droppedFilePath(file, () => 'C:\\Users\\Test\\large.zip')).toBe(
      'C:\\Users\\Test\\large.zip',
    )
  })

  it('rejects synthetic files, invalid native paths and forged File objects', () => {
    const file = {} as File
    expect(droppedFilePath(file, () => '')).toBeUndefined()
    expect(droppedFilePath(file, () => '/native/\0secret')).toBeUndefined()
    expect(droppedFilePath(file, () => 'x'.repeat(32_769))).toBeUndefined()
    expect(
      droppedFilePath(file, () => {
        throw new TypeError('Not a File')
      }),
    ).toBeUndefined()
  })

  it('accepts valid update states and finite zoom factors', () => {
    expect(
      isAppUpdateState({
        status: 'downloading',
        currentVersion: '0.1.0-beta.1',
        version: '0.1.0-beta.2',
        progress: 55,
      }),
    ).toBe(true)
    expect(
      isAppUpdateState({ status: 'preparing', currentVersion: '0.1.2', version: '0.1.3' }),
    ).toBe(true)
    expect(isFiniteNumber(1.1)).toBe(true)
  })

  it('rejects malformed update states and non-finite zoom factors', () => {
    expect(isAppUpdateState({ status: 'ready', currentVersion: 1 })).toBe(false)
    expect(isAppUpdateState({ status: 'unknown', currentVersion: '0.1.0' })).toBe(false)
    expect(
      isAppUpdateState({ status: 'downloading', currentVersion: '0.1.0', progress: Infinity }),
    ).toBe(false)
    expect(isFiniteNumber(Number.NaN)).toBe(false)
    expect(isFiniteNumber(Infinity)).toBe(false)
  })

  it('exposes only a base64url own-server token, a valid WebSocket subprotocol', () => {
    expect(isOwnServerToken('dGhpcy1pcy1hLXRva2VuLWZvci10ZXN0cw')).toBe(true)
    for (const value of [
      undefined,
      null,
      42,
      '',
      'short',
      'has a space in it here',
      'a,b;c=d+e/f/g',
    ])
      expect(isOwnServerToken(value)).toBe(false)
  })
})
