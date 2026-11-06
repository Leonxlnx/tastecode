import { describe, expect, it } from 'vitest'
import {
  coverRect,
  pictureInk,
  readThreadImage,
  THREAD_IMAGE_MAX_BYTES,
  THREAD_IMAGE_SIZE_ERROR,
  THREAD_IMAGE_TYPE_ERROR,
} from './thread-image.js'

describe('thread images', () => {
  it('covers the square with a wide, tall or square picture, centred', () => {
    expect(coverRect(400, 100, 64)).toEqual({ x: -96, y: 0, width: 256, height: 64 })
    expect(coverRect(100, 400, 64)).toEqual({ x: 0, y: -96, width: 64, height: 256 })
    expect(coverRect(150, 150, 64)).toEqual({ x: 0, y: 0, width: 64, height: 64 })
  })

  it('names the ink of a picture with see-through parts, and nothing else', () => {
    // A picture of `total` pixels: `inked` of one colour, the rest clear or filled.
    const picture = (total: number, inked: number, ink: number, rest: 'clear' | number) => {
      const pixels = new Uint8ClampedArray(total * 4)
      for (let index = 0; index < total; index++) {
        const value = index < inked ? ink : rest === 'clear' ? 0 : rest
        pixels.set([value, value, value, index < inked || rest !== 'clear' ? 255 : 0], index * 4)
      }
      return pixels
    }
    expect(pictureInk(picture(100, 40, 255, 'clear'))).toBe('light')
    expect(pictureInk(picture(100, 40, 0, 'clear'))).toBe('dark')
    // Mid-grey ink, an opaque picture, and an empty one need no plate.
    expect(pictureInk(picture(100, 40, 128, 'clear'))).toBeUndefined()
    expect(pictureInk(picture(100, 40, 255, 255))).toBeUndefined()
    expect(pictureInk(picture(100, 0, 255, 'clear'))).toBeUndefined()
    expect(pictureInk(new Uint8ClampedArray())).toBeUndefined()
  })

  it('refuses a file it cannot store before decoding it', async () => {
    await expect(
      readThreadImage(new File(['gif'], 'logo.gif', { type: 'image/gif' })),
    ).rejects.toThrow(THREAD_IMAGE_TYPE_ERROR)
    await expect(
      readThreadImage(
        new File([new Uint8Array(THREAD_IMAGE_MAX_BYTES + 1)], 'logo.png', { type: 'image/png' }),
      ),
    ).rejects.toThrow(THREAD_IMAGE_SIZE_ERROR)
  })
})
