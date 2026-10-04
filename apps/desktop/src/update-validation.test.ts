import { describe, expect, it } from 'vitest'
import { InvalidUpdateError, invalidDmgToolOutput, isInvalidUpdate } from './update-validation.js'

describe('invalid source updates', () => {
  it('discards explicit package and native signature rejections', () => {
    expect(isInvalidUpdate(new InvalidUpdateError('Wrong app'))).toBe(true)
    expect(
      isInvalidUpdate(
        Object.assign(new Error('Wrong publisher'), { code: 'ERR_UPDATER_INVALID_SIGNATURE' }),
      ),
    ).toBe(true)
    expect(isInvalidUpdate(new Error('Native signature mismatch'))).toBe(true)
  })

  it.each([
    ['hdiutil', 'hdiutil: attach failed - image not recognized'],
    ['codesign', 'code object is not signed at all'],
    ['codesign', 'a sealed resource is missing or invalid'],
    ['codesign', 'code or signature modified'],
  ] as const)('recognizes concrete %s validation output', (tool, stderr) => {
    expect(invalidDmgToolOutput(tool, Object.assign(new Error('Command failed'), { stderr }))).toBe(
      true,
    )
  })

  it.each(['hdiutil', 'codesign'] as const)('retains bytes on operational %s failures', (tool) => {
    for (const message of [
      'spawn ENOENT',
      'Operation timed out',
      'resource busy',
      'permission denied',
    ]) {
      const error = new Error(message)
      expect(invalidDmgToolOutput(tool, error)).toBe(false)
      expect(isInvalidUpdate(error)).toBe(false)
    }
  })
})
