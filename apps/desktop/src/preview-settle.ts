export const PREVIEW_SETTLE_SCRIPT = `(async () => {
  const wait = delay => new Promise(resolve => setTimeout(resolve, delay))
  const frame = () => new Promise(resolve => {
    const fallback = setTimeout(resolve, 100)
    requestAnimationFrame(() => {
      clearTimeout(fallback)
      resolve()
    })
  })
  const start = { x: scrollX, y: scrollY }
  const images = Promise.allSettled(Array.from(document.images).map(image => {
    if (image.complete) {
      return typeof image.decode === 'function' ? image.decode().catch(() => undefined) : undefined
    }
    return new Promise(resolve => {
      image.addEventListener('load', resolve, { once: true })
      image.addEventListener('error', resolve, { once: true })
    })
  }))

  await frame()
  const pageHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
  const step = Math.max(1, innerHeight * 0.8)
  for (let y = 0, count = 0; y < pageHeight && count < 40; y += step, count += 1) {
    scrollTo(0, y)
    await frame()
  }
  await Promise.all([
    Promise.race([
      Promise.allSettled(document.getAnimations().map(animation => animation.finished)),
      wait(1000),
    ]),
    Promise.race([document.fonts?.ready, wait(2000)]),
    Promise.race([images, wait(2000)]),
  ])
  scrollTo(start.x, start.y)
  await frame()
  await frame()
})()`

export const PREVIEW_PAGE_HEIGHT_SCRIPT = `(() => Math.min(
  12000,
  Math.max(innerHeight, document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
))()`

export const MAX_PREVIEW_HEIGHT = 12_000

/** Page measurements cross a trust boundary before reaching native bitmap allocation. */
export function previewCaptureHeight(value: unknown, viewportHeight: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('Invalid preview page height')
  }
  return Math.min(MAX_PREVIEW_HEIGHT, Math.max(viewportHeight, Math.ceil(value)))
}
