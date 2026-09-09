export const PREVIEW_SETTLE_SCRIPT = `(async () => {
  const timers = new Set()
  const frames = new Set()
  const listeners = []
  const start = { x: scrollX, y: scrollY }
  const bounded = (promise, delay) => new Promise(resolve => {
    const timer = setTimeout(() => { timers.delete(timer); resolve() }, delay)
    timers.add(timer)
    Promise.resolve(promise).then(finish, finish)
    function finish() { clearTimeout(timer); timers.delete(timer); resolve() }
  })
  const frame = () => new Promise(resolve => {
    let id
    let finished = false
    const finish = () => {
      finished = true
      clearTimeout(timer)
      timers.delete(timer)
      if (id !== undefined) { cancelAnimationFrame(id); frames.delete(id) }
      resolve()
    }
    const timer = setTimeout(finish, 100)
    timers.add(timer)
    id = requestAnimationFrame(finish)
    if (!finished) frames.add(id)
  })
  try {
    const images = Promise.allSettled(Array.from(document.images).map(image => {
      if (image.complete) {
        return typeof image.decode === 'function' ? image.decode().catch(() => undefined) : undefined
      }
      return new Promise(resolve => {
        image.addEventListener('load', resolve, { once: true })
        image.addEventListener('error', resolve, { once: true })
        listeners.push(() => {
          image.removeEventListener('load', resolve)
          image.removeEventListener('error', resolve)
        })
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
      bounded(Promise.allSettled(document.getAnimations().map(animation => animation.finished)), 1000),
      bounded(document.fonts?.ready, 2000),
      bounded(images, 2000),
    ])
    scrollTo(start.x, start.y)
    await frame()
    await frame()
  } finally {
    scrollTo(start.x, start.y)
    for (const timer of timers) clearTimeout(timer)
    for (const id of frames) cancelAnimationFrame(id)
    for (const remove of listeners) remove()
  }
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
