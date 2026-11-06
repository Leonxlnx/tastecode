import { THREAD_IMAGE_MAX_LENGTH } from '@harness/contracts'

/**
 * Turns a file the user picked into a chat's picture. The file never leaves
 * this machine: it is decoded here, cropped to a square and re-encoded as a
 * small PNG, which also means a picked SVG is only ever drawn, never rendered
 * as markup.
 */

export const THREAD_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml'
export const THREAD_IMAGE_MAX_BYTES = 5 * 1024 * 1024

/** Keeps the 28px tile sharp on high-density displays. */
const THREAD_IMAGE_SIZE = 64
const ACCEPTED_TYPES = new Set(THREAD_IMAGE_ACCEPT.split(','))

export const THREAD_IMAGE_TYPE_ERROR = 'Use a PNG, JPEG, WebP or SVG image.'
export const THREAD_IMAGE_SIZE_ERROR = 'Choose an image under 5 MB.'
export const THREAD_IMAGE_LOAD_ERROR = "Couldn't load this image."

/**
 * Where a picture lands so it covers a square: its short side fills the square
 * and the overflow, centred, falls outside. Drawing the whole picture this way
 * also works for an SVG with no size of its own, which a source crop misreads.
 */
export function coverRect(width: number, height: number, size: number) {
  const scale = size / Math.min(width, height)
  const drawn = { width: width * scale, height: height * scale }
  return { x: (size - drawn.width) / 2, y: (size - drawn.height) / 2, ...drawn }
}

async function decode(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return image
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Resolves to the PNG data URL to store, or rejects with words to show. */
export async function readThreadImage(file: File): Promise<string> {
  if (!ACCEPTED_TYPES.has(file.type)) throw new Error(THREAD_IMAGE_TYPE_ERROR)
  if (file.size > THREAD_IMAGE_MAX_BYTES) throw new Error(THREAD_IMAGE_SIZE_ERROR)
  let encoded: string
  try {
    const image = await decode(file)
    // An SVG without its own size reports zero; it still draws at any size.
    const width = image.naturalWidth || THREAD_IMAGE_SIZE
    const height = image.naturalHeight || THREAD_IMAGE_SIZE
    const rect = coverRect(width, height, THREAD_IMAGE_SIZE)
    const canvas = document.createElement('canvas')
    canvas.width = THREAD_IMAGE_SIZE
    canvas.height = THREAD_IMAGE_SIZE
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No 2D context')
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, rect.x, rect.y, rect.width, rect.height)
    encoded = canvas.toDataURL('image/png')
  } catch {
    throw new Error(THREAD_IMAGE_LOAD_ERROR)
  }
  if (encoded.length > THREAD_IMAGE_MAX_LENGTH || !encoded.startsWith('data:image/png;base64,')) {
    throw new Error(THREAD_IMAGE_LOAD_ERROR)
  }
  return encoded
}

export type PictureInk = 'light' | 'dark'

/**
 * Whether a picture with see-through parts is drawn in mostly light or mostly
 * dark ink, from its RGBA pixels. A white logo on a clear ground disappears on
 * a pale tile and a black one on a dark tile; the tile uses this to pick a
 * plate the picture shows on. Opaque pictures and mixed ink need no plate.
 */
export function pictureInk(pixels: Uint8ClampedArray): PictureInk | undefined {
  const count = pixels.length / 4
  let clear = 0
  let weight = 0
  let lightness = 0
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3]! / 255
    if (alpha < 0.5) clear += 1
    if (alpha === 0) continue
    const luminance =
      (0.2126 * pixels[index]! + 0.7152 * pixels[index + 1]! + 0.0722 * pixels[index + 2]!) / 255
    lightness += luminance * alpha
    weight += alpha
  }
  if (count === 0 || weight === 0 || clear / count < 0.2) return undefined
  const average = lightness / weight
  if (average > 0.75) return 'light'
  if (average < 0.25) return 'dark'
  return undefined
}

const PICTURE_INK_SAMPLE = 32
const PICTURE_INK_CACHE_LIMIT = 200
const pictureInkCache = new Map<string, Promise<PictureInk | undefined>>()

/** Measures a stored picture once; a picture that cannot be read needs no plate. */
export function measurePictureInk(source: string): Promise<PictureInk | undefined> {
  const cached = pictureInkCache.get(source)
  if (cached) return cached
  const measured = (async () => {
    try {
      const image = new Image()
      image.src = source
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = PICTURE_INK_SAMPLE
      canvas.height = PICTURE_INK_SAMPLE
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) return undefined
      context.drawImage(image, 0, 0, PICTURE_INK_SAMPLE, PICTURE_INK_SAMPLE)
      return pictureInk(context.getImageData(0, 0, PICTURE_INK_SAMPLE, PICTURE_INK_SAMPLE).data)
    } catch {
      return undefined
    }
  })()
  if (pictureInkCache.size >= PICTURE_INK_CACHE_LIMIT) {
    pictureInkCache.delete(pictureInkCache.keys().next().value!)
  }
  pictureInkCache.set(source, measured)
  return measured
}
