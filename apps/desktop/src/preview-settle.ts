import { z } from 'zod'

export const MAX_PREVIEW_CAPTURE_HEIGHT = 12_000

const PreviewPageHeightMeasurementSchema = z.object({
  documentElement: z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  body: z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
const PreviewViewportHeightSchema = z
  .number()
  .finite()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)

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

export const PREVIEW_PAGE_HEIGHT_SCRIPT = `(() => ({
  documentElement: document.documentElement.scrollHeight,
  body: document.body?.scrollHeight ?? 0,
}))()`

export function boundedPreviewPageHeight(measurement: unknown, viewportHeight: number): number {
  const parsedMeasurement = PreviewPageHeightMeasurementSchema.safeParse(measurement)
  const parsedViewportHeight = PreviewViewportHeightSchema.safeParse(viewportHeight)
  if (!parsedMeasurement.success || !parsedViewportHeight.success) {
    throw new Error('preview returned an invalid page height')
  }

  return Math.min(
    MAX_PREVIEW_CAPTURE_HEIGHT,
    Math.max(
      parsedViewportHeight.data,
      parsedMeasurement.data.documentElement,
      parsedMeasurement.data.body,
    ),
  )
}
