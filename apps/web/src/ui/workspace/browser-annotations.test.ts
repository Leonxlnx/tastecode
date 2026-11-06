// @vitest-environment happy-dom
import path from 'node:path'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AnnotationProbe,
  annotationCrop,
  annotationPopoverPlace,
  annotationProbeScript,
  annotationSelector,
  annotationComment,
  annotationCommentReady,
  annotationText,
} from './browser-annotations.js'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('annotation selectors', () => {
  it('uses unique escaped ids and disambiguates duplicate ids with a DOM path', () => {
    document.body.innerHTML =
      '<main id="a:b"><p>One</p><p>Two</p></main><div id="duplicate"></div><div id="duplicate"></div>'
    const paragraph = document.querySelectorAll('p')[1]!
    expect(annotationSelector(paragraph)).toBe('#a\\:b > p:nth-of-type(2)')
    expect(document.querySelector(annotationSelector(paragraph))).toBe(paragraph)
    const duplicate = document.querySelectorAll('div')[1]!
    expect(document.querySelector(annotationSelector(duplicate))).toBe(duplicate)
  })
  it('describes open shadow boundaries and pins an iframe itself', () => {
    const host = document.createElement('div')
    host.id = 'component'
    document.body.append(host)
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<button id="inside">Save</button>'
    expect(annotationSelector(shadow.querySelector('button')!)).toBe('#component >>> #inside')
    document.body.innerHTML = '<iframe id="frame"></iframe>'
    expect(annotationSelector(document.querySelector('iframe')!)).toBe('#frame')
  })
  it('pulls data without adding DOM, listeners or global state, and reports vanished elements', () => {
    document.body.innerHTML = '<p id="sample">Page text</p>'
    const before = document.documentElement.outerHTML
    const globals = Object.keys(window)
    const result = AnnotationProbe.parse(
      window.eval(annotationProbeScript({ selectors: ['#sample', '#gone'] })),
    )
    expect(result.targets[0]?.tag).toBe('p')
    expect(result.targets[1]).toBeNull()
    expect(document.documentElement.outerHTML).toBe(before)
    expect(Object.keys(window)).toEqual(globals)
  })

  it('keeps classes an agent can search for, and needs no position for a lone sibling', () => {
    document.body.innerHTML =
      '<section class="hero md:flex"><h1 class="hero-title">Hi</h1></section><section></section>'
    expect(annotationSelector(document.querySelector('h1')!)).toBe(
      'body > section.hero:nth-of-type(1) > h1.hero-title',
    )
  })

  it('still runs in the guest after a minified build renames module functions', async () => {
    const bundled = await build({
      entryPoints: [path.resolve('src/ui/workspace/browser-annotations.ts')],
      bundle: true,
      minify: true,
      format: 'iife',
      globalName: 'annotations',
      write: false,
    })
    const minified = new Function(`${bundled.outputFiles[0]!.text}; return annotations`)() as {
      annotationProbeScript: typeof annotationProbeScript
    }
    const script = minified.annotationProbeScript({ selectors: ['#sample'] })
    expect(script).not.toContain('annotationSelector')
    document.body.innerHTML = '<p id="sample">Page text</p>'
    expect(AnnotationProbe.parse(window.eval(script)).targets[0]?.selector).toBe('#sample')
  }, 15000)

  it('reads page text only for a chosen element, with words kept apart', () => {
    document.body.innerHTML = '<div id="card"><h2>One</h2><p>Two</p><style>.x{}</style></div>'
    const point = { x: 0, y: 0 }
    document.elementFromPoint = () => document.querySelector('#card')
    const hover = AnnotationProbe.parse(window.eval(annotationProbeScript({ point })))
    expect(hover.hit?.text).toBe('')
    const chosen = AnnotationProbe.parse(
      window.eval(annotationProbeScript({ point, withText: true })),
    )
    expect(annotationText(chosen.hit!.text, 100)).toBe('One Two')
  })
})

describe('where the comment box goes', () => {
  const area = { width: 500, height: 600 }
  const size = { width: 296, height: 130 }
  const place = (x: number, y: number, width: number, height: number) =>
    annotationPopoverPlace({ x, y, width, height }, area, size)

  it('prefers under the element, then over it', () => {
    expect(place(40, 100, 200, 50)).toEqual({ left: 40, top: 160 })
    expect(place(40, 500, 200, 50)).toEqual({ left: 40, top: 360 })
  })

  it('stays inside the area for an element that fills it or hangs off an edge', () => {
    expect(place(0, 0, 500, 600)).toEqual({ left: 12, top: 12 })
    expect(place(450, 100, 200, 50).left).toBe(192)
    expect(place(-80, 100, 200, 50).left).toBe(12)
  })
})

describe('untrusted annotation content', () => {
  it('rejects forged, excessive or non-finite guest results before the host uses them', () => {
    const target = {
      selector: '#a',
      tag: 'a',
      text: 'a',
      box: { x: 0, y: 0, width: 20, height: 20 },
    }
    const valid = { width: 800, height: 600, targets: [target], hit: null }
    expect(AnnotationProbe.safeParse(valid).success).toBe(true)
    expect(AnnotationProbe.safeParse({ ...valid, width: Infinity }).success).toBe(false)
    expect(AnnotationProbe.safeParse({ ...valid, targets: Array(22).fill(target) }).success).toBe(
      false,
    )
    expect(
      AnnotationProbe.safeParse({ ...valid, hit: { ...target, selector: 'x'.repeat(2049) } })
        .success,
    ).toBe(false)
    expect(
      AnnotationProbe.safeParse({
        ...valid,
        targets: [{ ...target, box: { x: 0, y: 0, width: -1, height: 20 } }],
      }).success,
    ).toBe(false)
  })
})

describe('annotation crop pixels', () => {
  it.each([1, 1.25, 2, 3])(
    'clips scrolled CSS coordinates at DPR %s independently of host scaling',
    (dpr) => {
      expect(
        annotationCrop(
          { x: 10, y: -20, width: 80, height: 60 },
          { width: 400, height: 800 },
          { width: 400 * dpr, height: 800 * dpr },
        ),
      ).toEqual({
        x: Math.floor(10 * dpr),
        y: 0,
        width: Math.ceil(90 * dpr) - Math.floor(10 * dpr),
        height: 40 * dpr,
      })
    },
  )
  it('clips the right/bottom and rejects an off-screen or empty element', () => {
    expect(
      annotationCrop(
        { x: 390, y: 790, width: 80, height: 60 },
        { width: 400, height: 800 },
        { width: 800, height: 1600 },
      ),
    ).toEqual({ x: 780, y: 1580, width: 20, height: 20 })
    expect(
      annotationCrop(
        { x: 0, y: -100, width: 20, height: 10 },
        { width: 400, height: 800 },
        { width: 800, height: 1600 },
      ),
    ).toBeUndefined()
  })
})

describe("the user's comment", () => {
  it('keeps lines and the characters that join emoji and scripts', () => {
    const family = '\u{1F469}\u200D\u{1F4BB}'
    const persian = '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645'
    const hindi = '\u0915\u094D\u200D\u0937'
    expect(annotationComment(`  ${family} first\r\n${persian}\u2028${hindi}\u0007 `)).toBe(
      `${family} first\n${persian}\n${hindi}`,
    )
  })

  it('stops at the length limit without splitting a character', () => {
    const limited = annotationComment(`${'a'.repeat(1999)}\u{1F600}`)
    expect(limited).toBe('a'.repeat(1999))
  })

  it('does not count what cannot be seen as a comment', () => {
    for (const empty of ['', '  \n ', '\u200B', '\u200D \u200C', '\uFEFF\u2060']) {
      expect(annotationCommentReady(empty)).toBe(false)
    }
    expect(annotationCommentReady('\u200Bfix')).toBe(true)
    expect(annotationCommentReady('\u{1F44D}')).toBe(true)
  })
})

it('reports a selector the page cannot read as gone, and still reads the others', () => {
  document.body.innerHTML = '<p id="sample">Page text</p>'
  const query = document.querySelector.bind(document)
  vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
    if (selector === 'div[') throw new DOMException('Not a selector', 'SyntaxError')
    return query(selector)
  })
  const result = AnnotationProbe.parse(
    window.eval(annotationProbeScript({ selectors: ['div[', '#sample'] })),
  )
  vi.restoreAllMocks()
  expect(result.targets[0]).toBeNull()
  expect(result.targets[1]?.tag).toBe('p')
})
