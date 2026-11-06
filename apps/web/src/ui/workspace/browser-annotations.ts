import { z } from 'zod'
import { sliceCodeUnits } from '../../slice-code-units.js'

const coordinate = z.number().finite().min(-10_000_000).max(10_000_000)
const Box = z.object({
  x: coordinate,
  y: coordinate,
  width: coordinate.nonnegative(),
  height: coordinate.nonnegative(),
})
const Target = z.object({
  selector: z.string().min(1).max(2048),
  tag: z.string().min(1).max(64),
  text: z.string().max(1000),
  box: Box,
})
export const AnnotationProbe = z.object({
  width: z.number().positive().max(10000),
  height: z.number().positive().max(10000),
  /** One entry per requested selector; null when that element is gone. */
  targets: z.array(Target.nullable()).max(21),
  /** The element under the requested point. */
  hit: Target.nullable(),
})
export type AnnotationTarget = z.infer<typeof Target>
export type AnnotationBox = z.infer<typeof Box>
export type BrowserAnnotation = AnnotationTarget & {
  /** Stable identity within a round; the number people see is the pin's position. */
  number: number
  comment: string
  url: string
  title: string
  image?: string | undefined
}
export type AnnotationDraft = { text: string; attachments: string[] }

export function annotationText(value: string, limit: number): string {
  // Include bidi controls: page content must not disguise the surrounding quotation.
  return value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

/**
 * The user's own words, not page content: lines stay, and so do the format characters
 * that join emoji and scripts such as Persian and Hindi. Only control characters go.
 */
export function annotationComment(value: string): string {
  const clean = value
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/[^\P{Cc}\n\t]/gu, '')
    .trim()
  return sliceCodeUnits(clean, 2000).trimEnd()
}

/** Zero-width characters alone would save as a comment nobody can see or read. */
export function annotationCommentReady(value: string): boolean {
  return /[^\s\p{Cc}\p{Cf}]/u.test(value)
}

/** Pixel bounds from the actual capture, not a guessed devicePixelRatio or host scale. */
export function annotationCrop(
  box: AnnotationBox,
  viewport: { width: number; height: number },
  pixels: { width: number; height: number },
) {
  const left = Math.max(0, box.x)
  const top = Math.max(0, box.y)
  const right = Math.min(viewport.width, box.x + box.width)
  const bottom = Math.min(viewport.height, box.y + box.height)
  if (right <= left || bottom <= top) return undefined
  const x = Math.floor((left * pixels.width) / viewport.width)
  const y = Math.floor((top * pixels.height) / viewport.height)
  return {
    x,
    y,
    width: Math.ceil((right * pixels.width) / viewport.width) - x,
    height: Math.ceil((bottom * pixels.height) / viewport.height) - y,
  }
}

/**
 * Where the comment box sits in the browser area, all in host pixels: under the
 * element, else over it, else inside its top edge when it fills the page. It
 * never leaves the area, so a short or narrow viewport still shows all of it.
 */
export function annotationPopoverPlace(
  box: AnnotationBox,
  area: { width: number; height: number },
  size: { width: number; height: number },
) {
  const gap = 10
  const margin = 12
  const clamp = (value: number, max: number) => Math.max(margin, Math.min(value, max))
  const bottom = box.y + box.height
  const fitsBelow = bottom + gap + size.height + margin <= area.height
  const fitsAbove = box.y - gap - size.height >= margin
  const top = fitsBelow ? bottom + gap : fitsAbove ? box.y - gap - size.height : box.y + margin
  return {
    left: clamp(box.x, area.width - size.width - margin),
    top: clamp(top, area.height - size.height - margin),
  }
}

/**
 * Serialized into the guest, so it must stand alone. No writes, listeners,
 * globals, IPC or host values. Classes stay in the path because they are what
 * an agent can search the source for.
 */
export function annotationSelector(element: Element, depth = 0): string {
  if (depth > 20) return '[unavailable-shadow-path]'
  const parts: string[] = []
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.localName === 'html' && parts.length > 0) break
    const root = current.getRootNode() as Document | ShadowRoot
    if (
      current.id &&
      current.id.length <= 512 &&
      root.querySelectorAll('#' + CSS.escape(current.id)).length === 1
    ) {
      parts.unshift('#' + CSS.escape(current.id))
      break
    }
    if (parts.length >= 64) break
    const name = current.localName
    const classes = Array.from(current.classList)
      .filter((value) => /^[A-Za-z_-][\w-]{0,39}$/.test(value))
      .slice(0, 2)
      .map((value) => '.' + CSS.escape(value))
      .join('')
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter((s) => s.localName === name)
      : []
    const position =
      siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')' : ''
    parts.unshift(CSS.escape(name) + classes + position)
  }
  const root = element.getRootNode()
  return (
    (root instanceof ShadowRoot ? annotationSelector(root.host, depth + 1) + ' >>> ' : '') +
    parts.join(' > ')
  )
}

export type ProbeRequest = {
  selectors?: string[]
  point?: { x: number; y: number }
  /** Page text is read only for a chosen element: every hover runs this probe. */
  withText?: boolean
  /** Scrolled from `point` before measuring, so pins move in the same frame as the page. */
  scroll?: { dx: number; dy: number }
}

export function annotationProbeScript(request: ProbeRequest): string {
  // Passed as an argument, not by name: a minified build renames module functions,
  // and a reference by name would throw in the guest of a packaged app only.
  return `(${pageProbe.toString()})(${JSON.stringify(request)}, ${annotationSelector.toString()})`
}

function pageProbe(request: ProbeRequest, selectorOf: (element: Element) => string) {
  const atPoint = (x: number, y: number) => {
    let element = document.elementFromPoint(x, y)
    for (let depth = 0; depth < 20 && element?.shadowRoot; depth++) {
      const inner = element.shadowRoot.elementFromPoint(x, y)
      if (!inner || inner === element) break
      element = inner
    }
    return element
  }
  if (request.scroll) {
    const { dx, dy } = request.scroll
    let element = request.point
      ? atPoint(request.point.x * innerWidth, request.point.y * innerHeight)
      : null
    while (element && element !== document.scrollingElement) {
      const style = getComputedStyle(element)
      if (
        /(auto|scroll)/.test(style.overflowY + style.overflowX) &&
        (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth)
      )
        break
      element = element.parentElement ?? (element.getRootNode() as ShadowRoot).host
    }
    ;(element ?? document.scrollingElement)?.scrollBy({ left: dx, top: dy, behavior: 'instant' })
  }
  const resolve = (selector: string) => {
    let root: Document | ShadowRoot = document
    let element: Element | null = null
    const steps = selector.split(' >>> ')
    for (const [index, step] of steps.entries()) {
      // A page can leave a selector it cannot read; that pin is gone, not the whole probe.
      try {
        element = root.querySelector(step)
      } catch {
        return null
      }
      if (!element) return null
      if (index < steps.length - 1) {
        if (!element.shadowRoot) return null
        root = element.shadowRoot
      }
    }
    return element
  }
  const snippet = (element: Element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let text = ''
    for (let count = 0; count < 200 && text.length < 1000; count++) {
      const node = walker.nextNode()
      if (!node) break
      if (/^(SCRIPT|STYLE|NOSCRIPT)$/.test(node.parentElement?.tagName ?? '')) continue
      // Separate text nodes are separate words: a heading runs straight into its paragraph.
      text += ' ' + (node.textContent ?? '').slice(0, 1000 - text.length)
    }
    return text
  }
  const describe = (element: Element | null, withText: boolean) => {
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return {
      selector: selectorOf(element).slice(0, 2048),
      tag: element.localName.slice(0, 64),
      text: withText ? snippet(element) : '',
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    }
  }
  return {
    width: innerWidth,
    height: innerHeight,
    targets: (request.selectors ?? []).map((selector) => describe(resolve(selector), false)),
    hit: request.point
      ? describe(
          atPoint(request.point.x * innerWidth, request.point.y * innerHeight),
          request.withText === true,
        )
      : null,
  }
}
