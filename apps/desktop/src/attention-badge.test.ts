import { describe, expect, it } from 'vitest'
import { badgeBitmap, badgeDescription } from './attention-badge.js'

function pixel(bitmap: Buffer, size: number, x: number, y: number) {
  const offset = (y * size + x) * 4
  return {
    b: bitmap[offset]!,
    g: bitmap[offset + 1]!,
    r: bitmap[offset + 2]!,
    a: bitmap[offset + 3]!,
  }
}

describe('badgeBitmap', () => {
  it('draws nothing for no chats', () => {
    expect(badgeBitmap(0, 32)).toBeUndefined()
    expect(badgeBitmap(-1, 32)).toBeUndefined()
    expect(badgeBitmap(Number.NaN, 32)).toBeUndefined()
  })

  it('refuses sizes the taskbar never asks for', () => {
    expect(badgeBitmap(1, 4)).toBeUndefined()
    expect(badgeBitmap(1, 16.5)).toBeUndefined()
    expect(badgeBitmap(1, 1_000)).toBeUndefined()
  })

  it('draws an amber dot with a dark ring and transparent corners', () => {
    const size = 32
    const bitmap = badgeBitmap(3, size)!
    expect(bitmap.byteLength).toBe(size * size * 4)
    expect(pixel(bitmap, size, 0, 0).a).toBe(0)
    expect(pixel(bitmap, size, size - 1, size - 1).a).toBe(0)
    // The middle of the dot: the needs-you amber, opaque.
    expect(pixel(bitmap, size, 16, 16)).toEqual({ r: 0xf2, g: 0xc9, b: 0x4c, a: 255 })
    // Just outside the dot (radius 11.2 px), inside the ring: dark and opaque.
    const ring = pixel(bitmap, size, 16 + 12, 16)
    expect(ring.a).toBe(255)
    expect(ring.r).toBeLessThan(0x30)
  })

  it('draws the same dot for every count, so the taskbar never shows a cramped number', () => {
    const pictures = new Set(
      [1, 2, 9, 10, 250].map((count) => badgeBitmap(count, 24)!.toString('base64')),
    )
    expect(pictures.size).toBe(1)
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
