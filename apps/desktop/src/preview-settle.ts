export const PREVIEW_SETTLE_SCRIPT = `(async () => {
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
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
  await Promise.race([
    Promise.allSettled(document.getAnimations().map(animation => animation.finished)),
    new Promise(resolve => setTimeout(resolve, 1000)),
  ])
  await document.fonts?.ready
  await Promise.race([images, new Promise(resolve => setTimeout(resolve, 2000))])
  await frame()
  await frame()
})()`
