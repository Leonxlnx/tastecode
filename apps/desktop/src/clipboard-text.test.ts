import { describe, expect, it } from 'vitest'
import { clipboardText, MAX_CLIPBOARD_TEXT_BYTES } from './clipboard-text.js'

describe('clipboardText', () => {
  it('accepts complete long chat messages beyond the former 64 KiB limit', () => {
    const response = 'a'.repeat(64 * 1024 + 1)

    expect(clipboardText(response)).toBe(response)
  })

  it('rejects empty, non-text, and unreasonably large renderer payloads', () => {
    expect(() => clipboardText('')).toThrow('Invalid clipboard text')
    expect(() => clipboardText(new Uint8Array([1]))).toThrow('Invalid clipboard text')
    expect(() => clipboardText('a'.repeat(MAX_CLIPBOARD_TEXT_BYTES + 1))).toThrow(
      'Invalid clipboard text',
    )
  })

  it('bounds multibyte text by its UTF-8 payload rather than UTF-16 length', () => {
    const response = '€'.repeat(Math.floor(MAX_CLIPBOARD_TEXT_BYTES / 3) + 1)
    expect(response.length).toBeLessThan(MAX_CLIPBOARD_TEXT_BYTES)
    expect(Buffer.byteLength(response, 'utf8')).toBeGreaterThan(MAX_CLIPBOARD_TEXT_BYTES)

    expect(() => clipboardText(response)).toThrow('Invalid clipboard text')
  })
})
