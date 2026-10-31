/**
 * The picture behind Window background › Image.
 *
 * It never leaves the renderer and never becomes a file path: the picked file
 * is decoded, resized and re-encoded on a canvas (which also drops its EXIF
 * data, GPS position included) and kept in IndexedDB. The page shows it
 * through a blob: URL, which the CSP already allows for images.
 *
 * Two copies are kept: the resized original, and the display copy that is
 * already blurred. Blurring once here means the window paints a plain bitmap,
 * with no CSS filter to recompute while a reply streams over it.
 */

export const BACKGROUND_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/bmp',
] as const
export const MAX_BACKGROUND_IMAGE_BYTES = 40 * 1024 * 1024
/** Longest edge of the stored original, in pixels. */
export const STORED_IMAGE_EDGE = 2560
/** Longest edge of the blurred display copy; blur hides anything finer. */
export const DISPLAY_IMAGE_EDGE = 1600
/** Gaussian blur of the display copy, in its own pixels (about 18px on a 2K window). */
export const DISPLAY_IMAGE_BLUR = 14
/** Bumped whenever the display copy is made differently, so stored copies are rebuilt. */
export const DISPLAY_IMAGE_VERSION = `blur${DISPLAY_IMAGE_BLUR}@${DISPLAY_IMAGE_EDGE}`
const ENCODED_TYPE = 'image/webp'
const ENCODED_QUALITY = 0.9

export type StoredBackgroundImage = {
  original: Blob
  display: Blob
  displayVersion: string
}

export class BackgroundImageError extends Error {}

/** Why a picked file cannot become the background, or undefined when it can. */
export function backgroundImageProblem(file: { type: string; size: number }): string | undefined {
  if (!(BACKGROUND_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return 'Choose a PNG, JPEG, WebP, AVIF, GIF or BMP image.'
  }
  if (file.size > MAX_BACKGROUND_IMAGE_BYTES) return 'Choose an image under 40 MB.'
  if (file.size === 0) return 'That file is empty.'
  return undefined
}

/** The size that fits inside a square of `maxEdge`, never enlarged. */
export function fitWithin(width: number, height: number, maxEdge: number) {
  const scale = Math.min(1, maxEdge / Math.max(width, height, 1))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** A 2D canvas to draw one copy on, and how to encode what was drawn. */
type EncodingCanvas = {
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
  toBlob: () => Promise<Blob>
}

function canvasOf(width: number, height: number): EncodingCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) throw new BackgroundImageError('This window cannot draw images.')
    return {
      context,
      toBlob: () => canvas.convertToBlob({ type: ENCODED_TYPE, quality: ENCODED_QUALITY }),
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new BackgroundImageError('This window cannot draw images.')
  return {
    context,
    toBlob: () =>
      new Promise((resolve, reject) =>
        canvas.toBlob(
          (blob) =>
            blob
              ? resolve(blob)
              : reject(new BackgroundImageError('The image could not be saved.')),
          ENCODED_TYPE,
          ENCODED_QUALITY,
        ),
      ),
  }
}

async function encode(bitmap: ImageBitmap, maxEdge: number, blur: number): Promise<Blob> {
  const size = fitWithin(bitmap.width, bitmap.height, maxEdge)
  const { context, toBlob } = canvasOf(size.width, size.height)
  if (blur > 0) {
    // A blur fades towards transparent at the canvas edge. Drawing the
    // picture slightly larger keeps real pixels under the whole frame.
    const bleed = blur * 2
    context.filter = `blur(${blur}px)`
    context.drawImage(bitmap, -bleed, -bleed, size.width + bleed * 2, size.height + bleed * 2)
  } else {
    context.drawImage(bitmap, 0, 0, size.width, size.height)
  }
  return toBlob()
}

async function decode(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob)
  } catch {
    throw new BackgroundImageError('That image could not be opened.')
  }
}

/** The stored and display copies of a picked file. Throws BackgroundImageError. */
export async function prepareBackgroundImage(file: File): Promise<StoredBackgroundImage> {
  const problem = backgroundImageProblem(file)
  if (problem) throw new BackgroundImageError(problem)
  const bitmap = await decode(file)
  try {
    return {
      original: await encode(bitmap, STORED_IMAGE_EDGE, 0),
      display: await encode(bitmap, DISPLAY_IMAGE_EDGE, DISPLAY_IMAGE_BLUR),
      displayVersion: DISPLAY_IMAGE_VERSION,
    }
  } finally {
    bitmap.close()
  }
}

/** The display copy, rebuilt from the original when it was made differently. */
export async function backgroundDisplayImage(
  stored: StoredBackgroundImage,
  store: BackgroundImageStore,
): Promise<Blob> {
  if (stored.displayVersion === DISPLAY_IMAGE_VERSION) return stored.display
  const bitmap = await decode(stored.original)
  try {
    const display = await encode(bitmap, DISPLAY_IMAGE_EDGE, DISPLAY_IMAGE_BLUR)
    await store.save({ ...stored, display, displayVersion: DISPLAY_IMAGE_VERSION }).catch(() => {
      // Rebuilt again next launch; the window still shows it now.
    })
    return display
  } finally {
    bitmap.close()
  }
}

export type BackgroundImageStore = {
  load: () => Promise<StoredBackgroundImage | undefined>
  save: (image: StoredBackgroundImage) => Promise<void>
  clear: () => Promise<void>
}

const DATABASE = 'tastecode-app-background'
const OBJECT_STORE = 'images'
const RECORD = 'current'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new BackgroundImageError('This window cannot store images.'))
      return
    }
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(OBJECT_STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new BackgroundImageError('This window cannot store images.'))
  })
}

async function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(OBJECT_STORE, mode)
      const request = run(transaction.objectStore(OBJECT_STORE))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = () => reject(new BackgroundImageError('The image could not be stored.'))
      transaction.onabort = () => reject(new BackgroundImageError('The image could not be stored.'))
    })
  } finally {
    database.close()
  }
}

function isStoredImage(value: unknown): value is StoredBackgroundImage {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record['original'] instanceof Blob &&
    record['display'] instanceof Blob &&
    typeof record['displayVersion'] === 'string'
  )
}

/** The one stored background image, in this renderer's IndexedDB. */
export const indexedDbBackgroundImages: BackgroundImageStore = {
  load: async () => {
    const value = await transact<unknown>('readonly', (store) => store.get(RECORD))
    return isStoredImage(value) ? value : undefined
  },
  save: async (image) => {
    await transact('readwrite', (store) => store.put(image, RECORD))
  },
  clear: async () => {
    await transact('readwrite', (store) => store.delete(RECORD))
  },
}
