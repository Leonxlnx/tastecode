/** How long a preload may wait for an idle moment before it runs anyway. */
const IDLE_TIMEOUT_MS = 4000

/**
 * Loads a lazily split surface while the renderer has nothing else to do, so
 * the surface's first open does not fetch, compile and style its chunk on the
 * click. A failed preload is dropped: opening the surface imports it again and
 * shows that surface's own load error.
 *
 * Without requestIdleCallback (a test DOM) nothing is preloaded; the surface
 * still loads when it opens. Returns a cancel for a preload not yet started.
 */
export function preloadWhenIdle(
  load: () => Promise<unknown>,
  timeoutMs: number = IDLE_TIMEOUT_MS,
): () => void {
  if (typeof window === 'undefined' || typeof window.requestIdleCallback !== 'function') {
    return () => {}
  }
  const handle = window.requestIdleCallback(
    () => {
      void load().catch(() => undefined)
    },
    { timeout: timeoutMs },
  )
  return () => window.cancelIdleCallback(handle)
}
