// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceTabs } from './WorkspaceTabs.js'

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
