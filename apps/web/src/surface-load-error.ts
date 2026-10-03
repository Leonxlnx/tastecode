/**
 * A lazily imported surface whose module failed to load. Chromium caches a
 * failed dynamic import for the page's lifetime, so rendering again re-throws
 * the same failure; only a window reload fetches the module again.
 */
export class SurfaceLoadError extends Error {
  constructor(cause: unknown) {
    super('A part of the app failed to load', { cause })
    this.name = 'SurfaceLoadError'
  }
}

export function surfaceLoadFailed(cause: unknown): never {
  throw new SurfaceLoadError(cause)
}
