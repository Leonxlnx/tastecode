import { describe, expect, it } from 'vitest'
import { clipboardText, MAX_CLIPBOARD_TEXT_LENGTH } from './clipboard-text.js'

describe('clipboardText', () => {
  it('accepts complete long chat messages beyond the former 64 KiB limit', () => {
    const response = 'a'.repeat(64 * 1024 + 1)

    expect(clipboardText(response)).toBe(response)
  })

  it('rejects empty, non-text, and unreasonably large renderer payloads', () => {
    expect(() => clipboardText('')).toThrow('Invalid clipboard text')
    expect(() => clipboardText(new Uint8Array([1]))).toThrow('Invalid clipboard text')
    expect(() => clipboardText('a'.repeat(MAX_CLIPBOARD_TEXT_LENGTH + 1))).toThrow(
      'Invalid clipboard text',
    )
  })
})
