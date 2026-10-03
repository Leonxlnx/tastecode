/**
 * React.lazy retains a rejected import, so rendering the surface again throws
 * the same failure. A window reload starts a fresh module graph.
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
