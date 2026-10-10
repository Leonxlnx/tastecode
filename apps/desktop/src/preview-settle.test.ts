import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PREVIEW_PAGE_HEIGHT_SCRIPT,
  PREVIEW_SETTLE_SCRIPT,
  previewCaptureHeight,
  previewPageHeights,
} from './preview-settle.js'

afterEach(() => vi.useRealTimers())

describe('preview capture settling', () => {
  it('waits for decoded and pending images before the final paint frames', async () => {
    const decode = vi.fn(async () => undefined)
    const pendingListeners = new Map<string, () => void>()
    const frame = vi.fn((resolve: () => void) => resolve())
    const scrollTo = vi.fn()
    const pending = {
      complete: false,
      removeEventListener: vi.fn(),
      addEventListener: (name: string, listener: () => void) => {
        pendingListeners.set(name, listener)
      },
    }

    // SAFETY: PREVIEW_SETTLE_SCRIPT ends with an async IIFE and returns Promise<void>.
    const settled = vm.runInNewContext(PREVIEW_SETTLE_SCRIPT, {
      Array,
      Promise,
      document: {
        body: { scrollHeight: 1800 },
        documentElement: { scrollHeight: 1800 },
        fonts: { ready: Promise.resolve() },
        getAnimations: () => [],
        images: [{ complete: true, decode }, pending],
      },
      requestAnimationFrame: frame,
      cancelAnimationFrame: vi.fn(),
      clearTimeout,
      performance,
      innerHeight: 844,
      scrollTo,
      scrollX: 0,
      scrollY: 120,
      setTimeout,
    }) as Promise<void>

    await vi.waitFor(() => expect(pendingListeners.get('load')).toBeDefined())
    pending.complete = true
    pendingListeners.get('load')?.()
    await settled

    // Once in the first image pass and once in the pass for late images.
    expect(decode).toHaveBeenCalledTimes(2)
    expect(frame).toHaveBeenCalledTimes(6)
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 120, behavior: 'instant' })
  })

  it('bounds whole-page captures to a safe bitmap height', () => {
    expect(
      vm.runInNewContext(PREVIEW_PAGE_HEIGHT_SCRIPT, {
        document: {
          body: { scrollHeight: 20_000, children: [] },
          documentElement: { scrollHeight: 20_000 },
        },
        innerHeight: 844,
        Math,
      }),
    ).toEqual({ body: 20_000, documentElement: 20_000, scrollContainer: 0 })
  })

  function scrollBox(box: {
    top?: number
    left?: number
    width: number
    height: number
    contentHeight: number
    /** A classic horizontal scrollbar takes this much of the box. */
    scrollbar?: number
    overflowY?: string
    visible?: boolean
    children?: unknown[]
    shadow?: unknown[]
  }) {
    const top = box.top ?? 0
    const left = box.left ?? 0
    return {
      clientWidth: box.width,
      clientHeight: box.height - (box.scrollbar ?? 0),
      offsetHeight: box.height,
      scrollHeight: box.contentHeight,
      overflowY: box.overflowY ?? 'auto',
      checkVisibility: () => box.visible ?? true,
      getBoundingClientRect: () => ({
        top,
        left,
        bottom: top + box.height,
        right: left + box.width,
      }),
      children: box.children ?? [],
      shadowRoot: box.shadow ? { children: box.shadow } : null,
    }
  }

  function measure(elements: unknown[], viewport = { width: 1440, height: 1000 }) {
    return vm.runInNewContext(PREVIEW_PAGE_HEIGHT_SCRIPT, {
      document: {
        body: { scrollHeight: viewport.height, children: elements },
        documentElement: { scrollHeight: viewport.height },
      },
      getComputedStyle: (element: { overflowY: string }) => ({ overflowY: element.overflowY }),
      innerWidth: viewport.width,
      innerHeight: viewport.height,
      scrollY: 0,
    }) as unknown
  }

  it('reports what a full-screen scroll container hides below its first screen', () => {
    // html, body { height: 100% } main { height: 100%; overflow-y: auto } with three
    // sections, inside the app's root element.
    const main = scrollBox({ width: 1440, height: 1000, contentHeight: 3000 })
    const value = measure([
      scrollBox({ width: 1440, height: 1000, contentHeight: 1000, children: [main] }),
    ])
    expect(value).toEqual({ documentElement: 1000, body: 1000, scrollContainer: 2000 })
    // The bitmap still holds one screen, so the capture now reads as cut short.
    expect(previewPageHeights(value, 1000)).toEqual({ documentHeight: 3000, capturedHeight: 1000 })
  })

  it('takes the largest page scroller and ignores scroll boxes that are page content', () => {
    const value = measure([
      // A code block, a box clipped without scrolling, and a panel that starts below the first screen.
      scrollBox({ width: 600, height: 200, contentHeight: 900 }),
      scrollBox({ width: 1440, height: 1000, contentHeight: 9000, overflowY: 'hidden' }),
      scrollBox({ top: 1200, width: 1440, height: 800, contentHeight: 6000 }),
      // A sidebar layout inside an app shell's open shadow root: the content pane
      // scrolls beside a fixed navigation column.
      scrollBox({
        width: 1440,
        height: 1000,
        contentHeight: 1000,
        shadow: [
          scrollBox({ width: 1180, height: 1000, contentHeight: 4200 }),
          scrollBox({ width: 260, height: 1000, contentHeight: 1600 }),
        ],
      }),
      // One pixel of rounding is not hidden content.
      scrollBox({ width: 1440, height: 1000, contentHeight: 1001 }),
    ])
    expect(value).toMatchObject({ scrollContainer: 3200 })
  })

  it('finds a shallow page scroller beside a list larger than the scan bound', () => {
    const list = scrollBox({
      width: 1440,
      height: 1000,
      contentHeight: 1000,
      children: Array.from({ length: 25_000 }, () =>
        scrollBox({ width: 10, height: 10, contentHeight: 10 }),
      ),
    })
    const main = scrollBox({ width: 1440, height: 1000, contentHeight: 3000 })
    expect(measure([main, list])).toMatchObject({ scrollContainer: 2000 })
  })

  it('ignores closed drawers and modals and a full-height gallery scrollbar', () => {
    const value = measure(
      [
        // A mobile drawer moved off screen, and a modal hidden until it opens.
        scrollBox({ left: -300, width: 300, height: 844, contentHeight: 1200 }),
        scrollBox({ width: 390, height: 844, contentHeight: 2000, visible: false }),
        // overflow-x: auto makes overflow-y auto too. Full-height slides then
        // overflow the box by exactly the scrollbar a Windows or Linux build draws.
        scrollBox({ width: 390, height: 844, contentHeight: 844, scrollbar: 17 }),
      ],
      { width: 390, height: 844 },
    )
    expect(value).toMatchObject({ scrollContainer: 0 })
  })

  it('rejects an invalid scroll container measurement', () => {
    for (const scrollContainer of [-1, 1.5, NaN, '200', Number.MAX_SAFE_INTEGER]) {
      expect(() =>
        previewPageHeights({ body: 1000, documentElement: 1000, scrollContainer }, 1000),
      ).toThrow('Invalid preview page height')
    }
  })

  it('finishes with suspended frames, fonts, and images and releases every wait', async () => {
    vi.useFakeTimers()
    const callbacks = new Map<number, () => void>()
    let nextFrame = 0
    const listeners = new Map<string, () => void>()
    const scrollTo = vi.fn()
    const never = new Promise(() => {})
    const result = vm.runInNewContext(PREVIEW_SETTLE_SCRIPT, {
      document: {
        documentElement: { scrollHeight: 800 },
        body: { scrollHeight: 800 },
        fonts: { ready: never },
        getAnimations: () => [{ finished: never }],
        images: [
          {
            complete: false,
            addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
            removeEventListener: (name: string) => listeners.delete(name),
          },
        ],
      },
      requestAnimationFrame: (callback: () => void) => {
        callbacks.set(++nextFrame, callback)
        return nextFrame
      },
      cancelAnimationFrame: (id: number) => callbacks.delete(id),
      setTimeout,
      clearTimeout,
      performance,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 140,
      scrollTo,
    }) as Promise<void>
    await vi.advanceTimersByTimeAsync(4000)
    await result
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 140, behavior: 'instant' })
    expect(listeners.size).toBe(0)
    expect(callbacks.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  function scrollingPage(options: {
    innerHeight: number
    height: number
    onScroll?: (top: number, page: { height: number; images: unknown[] }) => void
  }) {
    const page = { height: options.height, images: [] as unknown[] }
    const tops: number[] = []
    const settled = vm.runInNewContext(PREVIEW_SETTLE_SCRIPT, {
      document: {
        get body() {
          return { scrollHeight: page.height }
        },
        get documentElement() {
          return { scrollHeight: page.height }
        },
        fonts: { ready: Promise.resolve() },
        getAnimations: () => [],
        get images() {
          return page.images
        },
      },
      requestAnimationFrame: (resolve: () => void) => resolve(),
      cancelAnimationFrame: vi.fn(),
      setTimeout,
      clearTimeout,
      performance,
      innerHeight: options.innerHeight,
      scrollX: 0,
      scrollY: 0,
      scrollTo: ({ top }: { top: number }) => {
        tops.push(top)
        options.onScroll?.(top, page)
      },
    }) as Promise<void>
    return { settled, tops }
  }

  it('reaches the bottom of the capped capture on a short viewport', async () => {
    const { settled, tops } = scrollingPage({ innerHeight: 240, height: 20_000 })
    await settled
    expect(Math.max(...tops) + 240).toBeGreaterThanOrEqual(12_000)
  })

  it('follows a page that grows while it is scrolled', async () => {
    const { settled, tops } = scrollingPage({
      innerHeight: 800,
      height: 1800,
      onScroll: (top, page) => {
        if (top > 0 && page.height < 5000) page.height = 5000
      },
    })
    await settled
    expect(Math.max(...tops) + 800).toBeGreaterThanOrEqual(5000)
  })

  it('waits for images that scrolling inserted', async () => {
    let loaded = false
    const { settled } = scrollingPage({
      innerHeight: 800,
      height: 1800,
      onScroll: (top, page) => {
        if (top === 0 || page.images.length) return
        const image = {
          complete: false,
          removeEventListener: vi.fn(),
          addEventListener: (name: string, listener: () => void) => {
            if (name === 'load')
              setTimeout(() => {
                loaded = true
                image.complete = true
                listener()
              }, 50)
          },
        }
        page.images.push(image)
      },
    })
    await settled
    expect(loaded).toBe(true)
  })

  it('ignores hostile page Math and bounds valid raw measurements', () => {
    const value = vm.runInNewContext(PREVIEW_PAGE_HEIGHT_SCRIPT, {
      document: {
        body: { scrollHeight: 800, children: [] },
        documentElement: { scrollHeight: 800 },
      },
      Math: new Proxy(
        {},
        {
          get: () => {
            throw new Error('Untrusted Math')
          },
        },
      ),
    })
    expect(previewCaptureHeight(value, 844)).toBe(844)
    expect(previewCaptureHeight({ body: 100_000_000, documentElement: 100_000_000 }, 844)).toBe(
      12_000,
    )
    expect(previewCaptureHeight({ body: 0, documentElement: 1800 }, 844)).toBe(1800)
  })

  it.each([
    NaN,
    Infinity,
    -Infinity,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    '1200',
    null,
    undefined,
  ])('rejects invalid DOM and viewport measurements: %s', (value) => {
    expect(() => previewCaptureHeight({ body: value, documentElement: 0 }, 844)).toThrow(
      'Invalid preview page height',
    )
    expect(() => previewCaptureHeight({ body: 0, documentElement: value }, 844)).toThrow(
      'Invalid preview page height',
    )
    expect(() => previewCaptureHeight({ body: 0, documentElement: 0 }, value as number)).toThrow(
      'Invalid preview page height',
    )
  })

  it.each([null, undefined, 1000, {}, { body: 0 }, { documentElement: 0 }])(
    'rejects malformed measurement objects: %s',
    (value) => {
      expect(() => previewCaptureHeight(value, 844)).toThrow('Invalid preview page height')
    },
  )

  it('accepts an empty document but rejects a zero viewport', () => {
    expect(previewCaptureHeight({ body: 0, documentElement: 0 }, 844)).toBe(844)
    expect(() => previewCaptureHeight({ body: 0, documentElement: 0 }, 0)).toThrow(
      'Invalid preview page height',
    )
  })
})
