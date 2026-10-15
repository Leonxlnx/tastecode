// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceTabs, fitWorkspaceTabs, revealActiveTab } from './WorkspaceTabs.js'

const motions: Array<{ frames: Keyframe[]; finish: () => void; cancel: ReturnType<typeof vi.fn> }> =
  []
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
let reduced = false
beforeEach(() => {
  reduced = false
  motions.length = 0
  vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: reduced }) as MediaQueryList)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const siblings = Array.from(this.parentElement?.children ?? [])
    return {
      left: siblings.indexOf(this) * 100,
      width: 100,
      top: 0,
      height: 28,
      right: 100,
      bottom: 28,
      x: 0,
      y: 0,
      toJSON() {},
    }
  })
  vi.stubGlobal(
    'DOMMatrixReadOnly',
    class {
      m41 = 0
    },
  )
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: (frames: Keyframe[]) => {
      let finish!: () => void
      const finished = new Promise<void>((resolve) => {
        finish = resolve
      })
      const cancel = vi.fn()
      motions.push({ frames: frames as Keyframe[], finish, cancel })
      return { finished, cancel } as unknown as Animation
    },
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate)
  else Reflect.deleteProperty(Element.prototype, 'animate')
})

function Harness() {
  const [tabs, setTabs] = useState(['Terminal 1', 'Browser'])
  return (
    <WorkspaceTabs
      tabs={tabs.map((title) => ({ id: title, title, icon: null }))}
      activeId={tabs[0]}
      onSelect={() => {}}
      onClose={(id) => setTabs((current) => current.filter((tab) => tab !== id))}
      onReorder={(sourceId, targetId) =>
        setTabs((current) => {
          const next = current.filter((tab) => tab !== sourceId)
          next.splice(current.indexOf(targetId), 0, sourceId)
          return next
        })
      }
    >
      <button onClick={() => setTabs((current) => [...current, 'Files'])}>Add</button>
    </WorkspaceTabs>
  )
}

it('retains a closing tab until its fade ends, then slides its neighbours into place', async () => {
  render(<Harness />)
  await act(async () => {
    for (const motion of motions) motion.finish()
  })
  motions.length = 0
  fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 1' }))
  expect(screen.getByRole('tab', { name: 'Terminal 1', hidden: true })).toBeTruthy()
  expect(screen.queryByRole('tab', { name: 'Terminal 1' })).toBeNull()
  const exit = motions[0]!
  expect(exit.frames.at(-1)?.opacity).toBe(0)
  await act(async () => exit.finish())
  expect(screen.queryByRole('tab', { name: 'Terminal 1', hidden: true })).toBeNull()
  expect(motions.some((motion) => motion.frames[0]?.transform === 'translateX(100px)')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  expect(screen.getByRole('tab', { name: 'Files' })).toBeTruthy()
  expect(motions.some((motion) => motion.frames[0]?.opacity === 0)).toBe(true)
})

it('names the whole tab on hover, since a crowded strip cuts labels to an ellipsis', () => {
  render(<Harness />)
  expect(screen.getByRole('tab', { name: 'Terminal 1' }).getAttribute('title')).toBe('Terminal 1')
  expect(screen.getByRole('tab', { name: 'Browser' }).getAttribute('title')).toBe('Browser')
})

it('adds and removes tabs immediately under reduced motion', () => {
  reduced = true
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 1' }))
  expect(screen.queryByRole('tab', { name: 'Terminal 1', hidden: true })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  expect(screen.getByRole('tab', { name: 'Files' })).toBeTruthy()
  expect(motions).toHaveLength(0)
})

it('cancels motion and pending removal when the panel unmounts', () => {
  const view = render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 1' }))
  view.unmount()
  expect(motions.at(-1)?.cancel).toHaveBeenCalled()
})

it('moves a tab with Alt+Arrow and preserves its selected state', () => {
  const reorder = vi.fn()
  render(
    <WorkspaceTabs
      tabs={[
        { id: 'a', title: 'Terminal', icon: null },
        { id: 'b', title: 'Browser', icon: null },
      ]}
      activeId="a"
      onSelect={() => {}}
      onClose={() => {}}
      onReorder={reorder}
    >
      <span />
    </WorkspaceTabs>,
  )
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Terminal' }), {
    key: 'ArrowRight',
    altKey: true,
  })
  expect(reorder).toHaveBeenCalledWith('a', 'b')
  expect(screen.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true')
  reorder.mockClear()
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Terminal' }), {
    key: 'ArrowLeft',
    altKey: true,
  })
  expect(reorder).not.toHaveBeenCalled()
})

function SelectingHarness() {
  const [tabs, setTabs] = useState(['Terminal 1', 'Browser', 'Files'])
  const [activeId, setActiveId] = useState('Terminal 1')
  // The panel's rule: a closed active tab hands over to the last tab.
  const active = tabs.find((tab) => tab === activeId) ?? tabs.at(-1)
  return (
    <WorkspaceTabs
      tabs={tabs.map((title) => ({ id: title, title, icon: null }))}
      activeId={active}
      onSelect={setActiveId}
      onClose={(id) => setTabs((current) => current.filter((tab) => tab !== id))}
    >
      <button>Add</button>
    </WorkspaceTabs>
  )
}

it.each([false, true])(
  'hands focus from a closed tab to the tab selected next (reduced motion: %s)',
  async (reducedMotion) => {
    reduced = reducedMotion
    render(<SelectingHarness />)
    const closeButton = (name: string) => screen.getByRole('button', { name: `Close ${name}` })

    act(() => closeButton('Browser').focus())
    fireEvent.click(closeButton('Browser'))
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Terminal 1' }))

    await act(async () => {
      for (const motion of motions) motion.finish()
    })
    act(() => closeButton('Terminal 1').focus())
    fireEvent.click(closeButton('Terminal 1'))
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Files' }))
    await act(async () => {
      for (const motion of motions) motion.finish()
    })
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Files'])
    expect(screen.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('true')
  },
)

it('leaves focus alone when a tab closes while focus is elsewhere', () => {
  render(<SelectingHarness />)
  const add = screen.getByRole('button', { name: 'Add' })
  act(() => add.focus())
  fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 1' }))
  expect(document.activeElement).toBe(add)
})

it('keeps keyboard focus on a tab moved with Alt+Arrow', () => {
  render(<Harness />)
  const terminal = screen.getByRole('tab', { name: 'Terminal 1' })
  act(() => terminal.focus())
  fireEvent.keyDown(terminal, { key: 'ArrowRight', altKey: true })
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
    'Browser',
    'Terminal 1',
  ])
  expect(document.activeElement).toBe(terminal)
  fireEvent.keyDown(terminal, { key: 'ArrowLeft', altKey: true })
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
    'Terminal 1',
    'Browser',
  ])
  expect(document.activeElement).toBe(terminal)
})

it('previews pointer reordering, commits on release, and cancels with Escape', () => {
  const reorder = vi.fn()
  render(
    <WorkspaceTabs
      tabs={[
        { id: 'a', title: 'Terminal', icon: null },
        { id: 'b', title: 'Browser', icon: null },
      ]}
      onSelect={() => {}}
      onClose={() => {}}
      onReorder={reorder}
    >
      <span />
    </WorkspaceTabs>,
  )
  const source = screen.getByRole('tab', { name: 'Terminal' }).parentElement!
  const target = screen.getByRole('tab', { name: 'Browser' }).parentElement!
  fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 150 })
  fireEvent.pointerMove(source, { pointerId: 1, clientX: 260 })
  expect(source.classList.contains('is-tab-dragging')).toBe(true)
  expect(target.style.transform).toBe('translateX(-100px)')
  expect(source.parentElement!.querySelector<HTMLElement>('.workspace-tabs__landing')!.hidden).toBe(
    false,
  )
  expect(reorder).not.toHaveBeenCalled()
  fireEvent.pointerUp(source, { pointerId: 1 })
  expect(reorder).toHaveBeenCalledExactlyOnceWith('a', 'b')
  reorder.mockClear()
  fireEvent.pointerDown(source, { button: 0, pointerId: 2, clientX: 150 })
  fireEvent.pointerMove(source, { pointerId: 2, clientX: 260 })
  fireEvent.keyDown(window, { key: 'Escape' })
  fireEvent.pointerUp(source, { pointerId: 2 })
  expect(reorder).not.toHaveBeenCalled()
  expect(source.style.transform).toBe('')
})

it('keeps a readable prefix of a long title whole and names the tab in full', () => {
  render(
    <WorkspaceTabs
      tabs={[
        { id: 'a', title: 'Temporary chat', icon: null },
        { id: 'b', title: 'Browser', icon: null },
      ]}
      activeId="a"
      onSelect={() => {}}
      onClose={() => {}}
    >
      <span />
    </WorkspaceTabs>,
  )
  const long = screen.getByRole('tab', { name: 'Temporary chat' })
  expect(long.querySelector('.workspace-tabs__label--split')).toBeTruthy()
  expect(long.querySelector('.workspace-tabs__label-head')!.textContent).toBe('Tempo')
  expect(long.querySelector('.workspace-tabs__label-tail')!.textContent).toBe('rary chat')
  // The split adds nothing to the text: the ellipsis anchor is generated content.
  expect(long.textContent).toBe('Temporary chat')
  const short = screen.getByRole('tab', { name: 'Browser' })
  expect(short.querySelector('.workspace-tabs__label')!.textContent).toBe('Browser')
  expect(short.querySelector('.workspace-tabs__label-head')).toBeNull()
})

function stripWithTabs(widths: { client: number; scroll: number }) {
  const strip = document.createElement('div')
  strip.style.paddingLeft = '8px'
  strip.style.paddingRight = '4px'
  strip.innerHTML =
    '<div class="workspace-tabs__tab"></div><div class="workspace-tabs__tab"></div><div class="workspace-tabs__add"></div>'
  document.body.append(strip)
  Object.defineProperty(strip, 'clientWidth', { get: () => widths.client })
  Object.defineProperty(strip, 'scrollWidth', { get: () => widths.scroll })
  const [first, second, add] = Array.from(strip.children) as HTMLElement[]
  for (const [node, left, width] of [
    [first!, 8, 120],
    [second!, 132, 100],
    [add!, 236, 26],
  ] as const) {
    Object.defineProperty(node, 'offsetLeft', { get: () => left })
    Object.defineProperty(node, 'offsetWidth', { get: () => width })
  }
  return { strip, first: first!, second: second! }
}

it('scrolls an overflowing strip to show the active tab, and the add button after a last tab', () => {
  const { strip, first, second } = stripWithTabs({ client: 150, scroll: 266 })
  second.classList.add('is-active')
  revealActiveTab(strip)
  // The add button's end plus the strip's end padding, less the visible width.
  expect(strip.scrollLeft).toBe(236 + 26 + 4 - 150)
  second.classList.remove('is-active')
  first.classList.add('is-active')
  revealActiveTab(strip)
  expect(strip.scrollLeft).toBe(0)
  strip.remove()
})

it('leaves a strip that fits where it is', () => {
  const { strip, second } = stripWithTabs({ client: 300, scroll: 300 })
  second.classList.add('is-active')
  revealActiveTab(strip)
  expect(strip.scrollLeft).toBe(0)
  strip.remove()
})

function fitStrip(widths: { client: number; labels: number; compact: number }) {
  const strip = document.createElement('div')
  Object.defineProperty(strip, 'clientWidth', { get: () => widths.client })
  Object.defineProperty(strip, 'scrollWidth', {
    get: () => (strip.dataset['fit'] === 'compact' ? widths.compact : widths.labels),
  })
  return strip
}

it('keeps labels while they fit and goes compact once even readable prefixes do not', () => {
  const widths = { client: 400, labels: 380, compact: 200 }
  const strip = fitStrip(widths)
  expect(fitWorkspaceTabs(strip)).toBe('labels')
  expect(strip.dataset['fit']).toBe('labels')
  widths.client = 300
  expect(fitWorkspaceTabs(strip)).toBe('compact')
  expect(strip.dataset['fit']).toBe('compact')
  // A pixel of rounding is not an overflow.
  widths.client = 379
  expect(fitWorkspaceTabs(strip)).toBe('labels')
})

it('decides from the labelled layout in either mode, so it cannot flip at a boundary', () => {
  const widths = { client: 300, labels: 320, compact: 150 }
  const strip = fitStrip(widths)
  // Compact fits easily, but labels still overflow, so it stays compact every time.
  for (let pass = 0; pass < 3; pass += 1) expect(fitWorkspaceTabs(strip)).toBe('compact')
  widths.client = 320
  for (let pass = 0; pass < 3; pass += 1) expect(fitWorkspaceTabs(strip)).toBe('labels')
})

it('writes data-fit only when the mode changes', async () => {
  const widths = { client: 400, labels: 380, compact: 200 }
  const strip = fitStrip(widths)
  fitWorkspaceTabs(strip)
  const changes: Array<string | null> = []
  const observer = new MutationObserver((records) => {
    for (const record of records) changes.push(strip.getAttribute(record.attributeName!))
  })
  observer.observe(strip, { attributes: true, attributeFilter: ['data-fit'] })
  fitWorkspaceTabs(strip)
  fitWorkspaceTabs(strip)
  await new Promise((resolve) => setTimeout(resolve))
  expect(changes).toEqual([])
  widths.client = 300
  fitWorkspaceTabs(strip)
  await new Promise((resolve) => setTimeout(resolve))
  expect(changes).toEqual(['compact'])
  observer.disconnect()
})

it('refits the strip from one observer as it resizes and as its tabs change', () => {
  let resize: ResizeObserverCallback | undefined
  const created = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        created()
        resize = callback
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  let client = 400
  let labels = 380
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('workspace-tabs') ? client : 0
  })
  vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
    if (!(this instanceof HTMLElement) || !this.classList.contains('workspace-tabs')) return 0
    return this.dataset['fit'] === 'compact' ? 200 : labels
  })
  const strip = (titles: string[]) => (
    <WorkspaceTabs
      tabs={titles.map((title) => ({ id: title, title, icon: null }))}
      activeId="Review"
      onSelect={() => {}}
      onClose={() => {}}
    >
      <span />
    </WorkspaceTabs>
  )
  const view = render(strip(['Temporary chat', 'Review']))
  const tablist = screen.getByRole('tablist')
  expect(tablist.dataset['fit']).toBe('labels')
  client = 300
  act(() => resize!([], {} as ResizeObserver))
  expect(tablist.dataset['fit']).toBe('compact')
  client = 400
  labels = 520
  view.rerender(strip(['Temporary chat', 'Review', 'Files']))
  expect(tablist.dataset['fit']).toBe('compact')
  labels = 380
  view.rerender(strip(['Temporary chat', 'Review']))
  expect(tablist.dataset['fit']).toBe('labels')
  // A stable callback: re-rendering never recreates the observer.
  expect(created).toHaveBeenCalledOnce()
})
