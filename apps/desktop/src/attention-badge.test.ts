import { describe, expect, it } from 'vitest'
import { badgeBitmap, badgeDescription, badgeLabel } from './attention-badge.js'

function pixel(bitmap: Buffer, size: number, x: number, y: number) {
  const offset = (y * size + x) * 4
  return {
    b: bitmap[offset]!,
    g: bitmap[offset + 1]!,
    r: bitmap[offset + 2]!,
    a: bitmap[offset + 3]!,
  }
}

describe('badgeLabel', () => {
  it('counts up to nine and then says 9+', () => {
    expect(badgeLabel(1)).toBe('1')
    expect(badgeLabel(9)).toBe('9')
    expect(badgeLabel(10)).toBe('9+')
    expect(badgeLabel(250)).toBe('9+')
  })

  it('says nothing for no chats', () => {
    expect(badgeLabel(0)).toBe('')
    expect(badgeLabel(-1)).toBe('')
    expect(badgeLabel(Number.NaN)).toBe('')
  })
})

describe('badgeBitmap', () => {
  it('draws nothing for zero', () => {
    expect(badgeBitmap(0, 32)).toBeUndefined()
  })

  it('refuses sizes the taskbar never asks for', () => {
    expect(badgeBitmap(1, 4)).toBeUndefined()
    expect(badgeBitmap(1, 16.5)).toBeUndefined()
    expect(badgeBitmap(1, 1_000)).toBeUndefined()
  })

  it('fills a square of BGRA pixels with a disc and transparent corners', () => {
    const size = 32
    const bitmap = badgeBitmap(3, size)!
    expect(bitmap.byteLength).toBe(size * size * 4)
    expect(pixel(bitmap, size, 0, 0).a).toBe(0)
    expect(pixel(bitmap, size, size - 1, size - 1).a).toBe(0)
    // Inside the disc, clear of the digit: the needs-you amber, opaque.
    expect(pixel(bitmap, size, 4, 16)).toEqual({ r: 0xf2, g: 0xc9, b: 0x4c, a: 255 })
  })

  it('draws the digit in dark ink', () => {
    const size = 32
    // The stem of the 1 runs down the middle of the disc.
    const stem = pixel(badgeBitmap(1, size)!, size, 16, 18)
    expect(stem.a).toBe(255)
    expect(stem.r).toBeLessThan(0x40)
  })

  it('draws a different picture for every label', () => {
    const pictures = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((count) => badgeBitmap(count, 24)!.toString('base64')),
    )
    expect(pictures.size).toBe(10)
  })

  it('keeps colour within alpha, as premultiplied pixels must', () => {
    const bitmap = badgeBitmap(8, 20)!
    for (let offset = 0; offset < bitmap.byteLength; offset += 4) {
      const alpha = bitmap[offset + 3]!
      expect(
        Math.max(bitmap[offset]!, bitmap[offset + 1]!, bitmap[offset + 2]!),
      ).toBeLessThanOrEqual(alpha)
    }
  })
})

describe('badgeDescription', () => {
  it('reads the count as a sentence', () => {
    expect(badgeDescription(1)).toBe('1 chat needs you')
    expect(badgeDescription(4)).toBe('4 chats need you')
  })
})
