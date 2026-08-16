export const PREVIEW_SETTLE_SCRIPT = `(async () => {
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
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
  await Promise.race([
    Promise.allSettled(document.getAnimations().map(animation => animation.finished)),
    new Promise(resolve => setTimeout(resolve, 1000)),
  ])
  await document.fonts?.ready
  await Promise.race([images, new Promise(resolve => setTimeout(resolve, 2000))])
  scrollTo(start.x, start.y)
  await frame()
  await frame()
})()`

export const PREVIEW_PAGE_HEIGHT_SCRIPT = `(() => Math.min(
  12000,
  Math.max(innerHeight, document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
))()`
