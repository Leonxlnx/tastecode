import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { PreviewDomAuditSchema } from '@harness/contracts'
import { PREVIEW_DOM_AUDIT_SCRIPT } from './preview-dom-audit.js'

type Rect = { left: number; top: number; width: number; height: number }
type Style = Partial<
  Record<
    'display' | 'visibility' | 'pointerEvents' | 'overflowX' | 'overflowY' | 'position',
    string
  >
>

type NodeFixture = {
  tag?: string
  id?: string
  label?: string
  labelledBy?: string
  interactive?: boolean
  disabled?: boolean
  hidden?: boolean
  inert?: boolean
  defined?: boolean
  rect?: Partial<Rect>
  /** Scroll metrics; the box defaults to its rect with no overflow. */
  contentHeight?: number
  style?: Style
  children?: NodeFixture[]
  shadow?: NodeFixture[]
  /** Ids of label elements anywhere in the same root. */
  labelIds?: string[]
}

class FakeShadowRoot {
  children: FakeElement[] = []
  constructor(readonly host: FakeElement) {}
  getElementById(id: string) {
    return findById(this.children, id)
  }
  querySelectorAll(selector: string) {
    return selectorMatches(this.children, selector)
  }
}

type FakeElement = {
  localName: string
  id: string
  inert: boolean
  children: FakeElement[]
  parentElement: FakeElement | null
  shadowRoot: FakeShadowRoot | null
  labels: FakeElement[]
  textContent: string
  root: FakeDocument | FakeShadowRoot
  fixture: NodeFixture
  getRootNode(): FakeDocument | FakeShadowRoot
  hasAttribute(name: string): boolean
  getAttribute(name: string): string | null
  matches(selector: string): boolean
  getBoundingClientRect(): Rect & { right: number; bottom: number }
  checkVisibility(): boolean
  clientWidth: number
  clientHeight: number
  offsetHeight: number
  scrollHeight: number
}

type FakeDocument = {
  documentElement: FakeElement
  body: FakeElement
  getElementById(id: string): FakeElement | null
  querySelectorAll(selector: string): FakeElement[]
}

function descendants(roots: FakeElement[]): FakeElement[] {
  return roots.flatMap((element) => [element, ...descendants(element.children)])
}

function findById(roots: FakeElement[], id: string) {
  return descendants(roots).find((element) => element.id === id) ?? null
}

// Enough selector support to make the uniqueness check meaningful: a bare tag
// matches every element with that tag, a chained path matches one element.
function selectorMatches(roots: FakeElement[], selector: string) {
  if (selector.includes('>')) return [roots[0]]
  return descendants(roots).filter((element) => element.localName === selector)
}

function build(
  fixture: NodeFixture,
  parent: FakeElement | null,
  root: FakeDocument | FakeShadowRoot,
): FakeElement {
  const left = fixture.rect?.left ?? 0
  const top = fixture.rect?.top ?? 0
  const width = fixture.rect?.width ?? 100
  const height = fixture.rect?.height ?? 100
  const element: FakeElement = {
    localName: fixture.tag ?? (fixture.interactive ? 'button' : 'div'),
    id: fixture.id ?? '',
    inert: Boolean(fixture.inert),
    children: [],
    parentElement: parent,
    shadowRoot: null,
    labels: [],
    textContent: fixture.label ?? '',
    root,
    fixture,
    getRootNode: () => root,
    hasAttribute: (name) => name === 'inert' && Boolean(fixture.inert),
    getAttribute(name) {
      if (name === 'aria-label') return fixture.label ?? null
      if (name === 'aria-labelledby') return fixture.labelledBy ?? null
      return null
    },
    matches(selector) {
      if (selector === ':defined') return fixture.defined ?? true
      if (selector.includes(':disabled')) return Boolean(fixture.disabled)
      return Boolean(fixture.interactive)
    },
    getBoundingClientRect: () => ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    }),
    checkVisibility: () => !fixture.hidden,
    clientWidth: width,
    clientHeight: height,
    offsetHeight: height,
    scrollHeight: fixture.contentHeight ?? height,
  }
  element.children = (fixture.children ?? []).map((child) => build(child, element, root))
  if (fixture.shadow) {
    const shadowRoot = new FakeShadowRoot(element)
    shadowRoot.children = fixture.shadow.map((child) => build(child, null, shadowRoot))
    element.shadowRoot = shadowRoot
  }
  return element
}

function runAudit(body: NodeFixture[], options: { scrollY?: number } = {}) {
  const document = {} as FakeDocument
  const html = build({ tag: 'html', children: [{ tag: 'body', children: body }] }, null, document)
  document.documentElement = html
  document.body = html.children[0]!
  document.getElementById = (id) => findById([html], id)
  document.querySelectorAll = (selector) => selectorMatches([html], selector)
  const all = descendants([html])
  for (const element of all) {
    for (const id of element.fixture.labelIds ?? []) {
      const label = element.root.getElementById(id)
      if (label) element.labels.push(label)
    }
  }
  for (const root of all.flatMap((element) => (element.shadowRoot ? [element.shadowRoot] : []))) {
    for (const element of descendants(root.children)) {
      for (const id of element.fixture.labelIds ?? []) {
        const label = root.getElementById(id)
        if (label) element.labels.push(label)
      }
    }
  }
  const scrollTo = vi.fn()
  const result = vm.runInNewContext(PREVIEW_DOM_AUDIT_SCRIPT, {
    CSS: { escape: (value: string) => value },
    ShadowRoot: FakeShadowRoot,
    innerWidth: 390,
    innerHeight: 844,
    scrollX: 0,
    scrollY: options.scrollY ?? 0,
    scrollTo,
    document,
    getComputedStyle: (element: FakeElement) => ({
      display: 'block',
      visibility: 'visible',
      pointerEvents: 'auto',
      overflowX: 'visible',
      overflowY: 'visible',
      position: 'static',
      ...element.fixture.style,
    }),
  })
  return { audit: PreviewDomAuditSchema.parse(result), scrollTo }
}

const small = (id: string, extra: Partial<NodeFixture> = {}): NodeFixture => ({
  id,
  interactive: true,
  rect: { width: 20, height: 20 },
  ...extra,
})

describe('preview DOM audit', () => {
  it('reports visible undersized targets across the whole document', () => {
    const { audit } = runAudit([
      { tag: 'h1' },
      small('small', { label: 'Open menu', rect: { width: 32, height: 40 } }),
      small('large', { rect: { width: 44, height: 44 } }),
      small('disabled', { disabled: true }),
      small('hidden', { hidden: true }),
      small('below-fold', { rect: { width: 20, height: 20, top: 900 } }),
      small('left-of-screen', { rect: { width: 20, height: 20, left: -20 } }),
    ])
    expect(audit).toEqual({
      h1Count: 1,
      coverage: 'complete',
      interactiveTargetViolations: [
        { selector: '#small', label: 'Open menu', width: 32, height: 40 },
        { selector: '#below-fold', label: '', width: 20, height: 20 },
      ],
    })
  })

  it('measures from the document origin and restores the entry scroll', () => {
    const { scrollTo } = runAudit([small('header')], { scrollY: 3000 })
    expect(scrollTo.mock.calls).toEqual([
      [{ left: 0, top: 0, behavior: 'instant' }],
      [{ left: 0, top: 3000, behavior: 'instant' }],
    ])
  })

  it('finds headings and controls inside open shadow roots', () => {
    const { audit } = runAudit([
      {
        tag: 'app-shell',
        id: 'shell',
        shadow: [
          { tag: 'h1' },
          small('inner', { labelledBy: 'inner-label' }),
          { id: 'inner-label', label: 'Close' },
        ],
      },
    ])
    expect(audit.h1Count).toBe(1)
    expect(audit.coverage).toBe('complete')
    expect(audit.interactiveTargetViolations).toEqual([
      { selector: '#shell >>> #inner', label: 'Close', width: 20, height: 20 },
    ])
  })

  it('reports partial coverage when a defined custom element may hide a closed root', () => {
    const { audit } = runAudit([{ tag: 'closed-widget' }])
    expect(audit).toMatchObject({ h1Count: 0, coverage: 'partial' })
  })

  it('reports partial coverage when the element bound stops the walk', () => {
    const { audit } = runAudit(Array.from({ length: 20_000 }, () => ({ tag: 'p' })))
    expect(audit.coverage).toBe('partial')
  })

  it('skips inert subtrees', () => {
    const { audit } = runAudit([{ inert: true, children: [small('behind-dialog')] }])
    expect(audit.interactiveTargetViolations).toEqual([])
  })

  it('skips targets an ancestor clips away and flags partly clipped ones', () => {
    const { audit } = runAudit([
      {
        style: { overflowX: 'hidden', overflowY: 'hidden' },
        rect: { width: 300, height: 0, top: 100 },
        children: [small('collapsed', { rect: { width: 20, height: 20, top: 100 } })],
      },
      {
        style: { overflowX: 'visible', overflowY: 'hidden' },
        rect: { width: 300, height: 10, top: 200 },
        children: [small('cut', { rect: { width: 20, height: 20, top: 200 } })],
      },
    ])
    expect(audit.interactiveTargetViolations).toEqual([
      { selector: '#cut', label: '', width: 20, height: 20, partiallyClipped: true },
    ])
  })

  it('audits controls below the first screen of a full-screen scroll container', () => {
    // html, body { height: 100% } main { height: 100%; overflow-y: auto } with three sections.
    const { audit } = runAudit([
      {
        tag: 'main',
        style: { overflowX: 'hidden', overflowY: 'auto' },
        rect: { width: 390, height: 844 },
        contentHeight: 3 * 844,
        children: [
          small('second-section', { rect: { width: 10, height: 10, top: 900 } }),
          // The scroller still clips sideways.
          small('past-edge', { rect: { width: 20, height: 20, top: 1800, left: 380 } }),
        ],
      },
    ])
    expect(audit.interactiveTargetViolations).toEqual([
      { selector: '#second-section', label: '', width: 10, height: 10 },
      { selector: '#past-edge', label: '', width: 20, height: 20, partiallyClipped: true },
    ])
  })

  it('still clips controls that a smaller scroll box hides', () => {
    const { audit } = runAudit([
      {
        style: { overflowY: 'auto' },
        rect: { width: 390, height: 200, top: 100 },
        contentHeight: 900,
        children: [small('in-code-block', { rect: { width: 20, height: 20, top: 500 } })],
      },
    ])
    expect(audit.interactiveTargetViolations).toEqual([])
  })

  it('accepts a native control whose associated label is a large target', () => {
    const { audit } = runAudit([
      { id: 'big-label', label: 'Subscribe', rect: { width: 200, height: 48 } },
      small('checkbox', { tag: 'input', labelIds: ['big-label'] }),
      { id: 'tiny-label', label: 'Agree', rect: { width: 30, height: 16 } },
      small('radio', { tag: 'input', labelIds: ['tiny-label'] }),
    ])
    expect(audit.interactiveTargetViolations).toEqual([
      { selector: '#radio', label: 'Agree', width: 20, height: 20 },
    ])
  })

  it('climbs to a unique selector for repeated anonymous controls', () => {
    const { audit } = runAudit([
      { id: 'card-a', children: [small('', { label: 'More' })] },
      { id: 'card-b', children: [small('', { label: 'More' })] },
    ])
    expect(audit.interactiveTargetViolations.map(({ selector }) => selector)).toEqual([
      '#card-a > button',
      '#card-b > button',
    ])
  })

  it('bounds evidence to the shared contract limits', () => {
    const { audit } = runAudit([
      ...Array.from({ length: 10_001 }, () => ({ tag: 'h1' })),
      ...Array.from({ length: 201 }, (_, index) =>
        small(`target-${index}`, { label: 'x'.repeat(201) }),
      ),
    ])
    expect(audit.h1Count).toBe(10_000)
    expect(audit.interactiveTargetViolations).toHaveLength(200)
    expect(audit.interactiveTargetViolations[0]?.label).toHaveLength(200)
  })
})
