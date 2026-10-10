import { PAGE_SCROLLER_SOURCE } from './preview-page-scroller.js'

export const MAX_PREVIEW_HEIGHT = 12_000
const MAX_PREVIEW_HEIGHT_SOURCE = String(MAX_PREVIEW_HEIGHT)
export const PREVIEW_SETTLE_BUDGET_MS = 5_500
const PREVIEW_SETTLE_BUDGET_SOURCE = String(PREVIEW_SETTLE_BUDGET_MS)

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
  // Images are collected after scrolling: lazy loaders swap sources and add
  // new images while the page moves.
  const imagesSettled = () => Promise.allSettled(Array.from(document.images).map(image => {
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
  const pageHeight = () => Math.min(
    ${MAX_PREVIEW_HEIGHT_SOURCE},
    Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
  )
  // One budget per viewport: four viewports must still fit the capture timeout.
  const budgetEnd = performance.now() + ${PREVIEW_SETTLE_BUDGET_SOURCE}
  const remaining = delay => Math.max(0, Math.min(delay, budgetEnd - performance.now()))
  try {
    await frame()
    // Visit everything the bitmap can hold, remeasuring as lazy content grows.
    // The step count follows from the capped height, bounded by a deadline.
    const step = Math.max(1, innerHeight * 0.8)
    const maxSteps = Math.ceil(${MAX_PREVIEW_HEIGHT_SOURCE} / step) + 1
    const scrollEnd = performance.now() + 3000
    for (let y = 0, count = 0; count < maxSteps && performance.now() < scrollEnd; count += 1) {
      scrollTo({ left: 0, top: y, behavior: 'instant' })
      await frame()
      if (y + innerHeight >= pageHeight()) break
      y += step
    }
    await Promise.all([
      bounded(Promise.allSettled(document.getAnimations().map(animation => animation.finished)), remaining(1000)),
      bounded(document.fonts?.ready, remaining(2000)),
      bounded(imagesSettled(), remaining(2000)),
    ])
    // A second pass catches images inserted or swapped while the first ones loaded.
    await bounded(imagesSettled(), remaining(1000))
    scrollTo({ left: start.x, top: start.y, behavior: 'instant' })
    await frame()
    await frame()
  } finally {
    scrollTo({ left: start.x, top: start.y, behavior: 'instant' })
    for (const timer of timers) clearTimeout(timer)
    for (const id of frames) cancelAnimationFrame(id)
    for (const remove of listeners) remove()
  }
})()`

export const PREVIEW_PAGE_HEIGHT_SCRIPT = `(() => {
  ${PAGE_SCROLLER_SOURCE}
  // The largest page scroller says how much of the page the document height leaves out.
  const elements = document.body ? document.body.getElementsByTagName('*') : []
  let scrollContainer = 0
  for (let index = 0; index < elements.length && index < 20000; index += 1) {
    const hidden = pageScrollerOverflow(elements[index])
    if (hidden > scrollContainer) scrollContainer = hidden
  }
  return {
    documentElement: document.documentElement.scrollHeight,
    body: document.body?.scrollHeight ?? 0,
    scrollContainer,
  }
})()`

/** Validate raw DOM measurements before they reach native bitmap allocation. */
export function previewCaptureHeight(value: unknown, viewportHeight: number): number {
  return previewPageHeights(value, viewportHeight).capturedHeight
}

/**
 * The capture is cut at MAX_PREVIEW_HEIGHT, and never holds what a page scroller
 * hides below its first screen; the document height says how much was left out.
 */
export function previewPageHeights(value: unknown, viewportHeight: number) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('documentElement' in value) ||
    !('body' in value) ||
    !validHeight(value.documentElement) ||
    !validHeight(value.body) ||
    !validHeight(viewportHeight) ||
    viewportHeight === 0
  ) {
    throw new Error('Invalid preview page height')
  }
  const scrollContainer = 'scrollContainer' in value ? value.scrollContainer : 0
  const pageHeight = Math.max(viewportHeight, value.documentElement, value.body)
  if (!validHeight(scrollContainer) || !validHeight(pageHeight + scrollContainer)) {
    throw new Error('Invalid preview page height')
  }
  const documentHeight = pageHeight + scrollContainer
  return { documentHeight, capturedHeight: Math.min(MAX_PREVIEW_HEIGHT, pageHeight) }
}

function validHeight(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
