// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TestTransport } from '../../test-transport.js'
import { WorkspacePanel } from './WorkspacePanel.js'
import {
  DEFAULT_BOTTOM_PANEL_HEIGHT,
  DEFAULT_WORKSPACE_PANEL_WIDTH,
} from './workspace-panel-width.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const props = () => ({
  open: true,
  expanded: false,
  width: 700,
  transport: new TestTransport(),
  theme: 'dark' as const,
  sideChatParentStatus: 'idle' as const,
  sideChatStartOptions: { approval: 'ask' as const },
  nativeSurfacesVisible: true,
  onOpen: vi.fn(),
  onClose: vi.fn(),
  onWidthChange: vi.fn(),
})

const reduceMotion = (reduce: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))

function renderIn(className: string, panel: Parameters<typeof WorkspacePanel>[0]) {
  const view = render(<WorkspacePanel {...panel} />)
  view.container.className = className
  Object.defineProperty(view.container, 'clientWidth', { configurable: true, value: 1200 })
  return view
}

it.each([
  ['right', 'workspace-layout', '--workspace-panel-w', DEFAULT_WORKSPACE_PANEL_WIDTH],
  ['bottom', 'bottom-terminal', 'height', DEFAULT_BOTTOM_PANEL_HEIGHT],
] as const)(
  'restores the %s panel default size on a double-click of its edge',
  (placement, host, property, size) => {
    reduceMotion(true)
    const base = props()
    const { container } = renderIn(host, { ...base, placement })
    fireEvent.doubleClick(screen.getByRole('separator'))
    expect(base.onWidthChange).toHaveBeenCalledWith(size)
    expect(container.style.getPropertyValue(property)).toBe(`${size}px`)
  },
)

it('eases to the default width over a few frames instead of jumping', async () => {
  reduceMotion(false)
  const base = props()
  const { container } = renderIn('workspace-layout', base)
  // Count the writes themselves: happy-dom holds a MutationObserver's callback
  // only through a WeakRef, so a garbage collection mid-test drops its records.
  const writes = vi.spyOn(container.style, 'setProperty')

  fireEvent.doubleClick(screen.getByRole('separator'))
  expect(base.onWidthChange).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(base.onWidthChange).toHaveBeenCalledWith(520))
  const steps = writes.mock.calls
    .filter(([property]) => property === '--workspace-panel-w')
    .map(([, width]) => Number.parseInt(String(width), 10))
  expect(steps.at(-1)).toBe(520)
  expect(steps.length).toBeGreaterThan(2)
  // Every frame moves toward the target, never past it.
  for (const [index, step] of steps.entries())
    expect(step).toBeLessThanOrEqual(steps[index - 1] ?? 700)
  expect(Math.min(...steps)).toBe(520)
})

it('leaves an expanded panel alone', () => {
  reduceMotion(true)
  const base = props()
  renderIn('workspace-layout', { ...base, expanded: true })
  fireEvent.doubleClick(screen.getByRole('separator', { hidden: true }))
  expect(base.onWidthChange).not.toHaveBeenCalled()
})

it('resizes the right panel from the keyboard within its limits', () => {
  reduceMotion(true)
  const base = props()
  const { container, rerender } = renderIn('workspace-layout', { ...base, width: 500 })
  const edge = screen.getByRole('separator')
  expect(edge.tabIndex).toBe(0)
  act(() => edge.focus())
  expect(edge.getAttribute('aria-valuenow')).toBe('500')
  expect(edge.getAttribute('aria-valuemin')).toBe('300')
  // 1200px of room keeps 360px for the chat.
  expect(edge.getAttribute('aria-valuemax')).toBe('840')
  expect(edge.getAttribute('aria-valuetext')).toBe('500 pixels wide')

  fireEvent.keyDown(edge, { key: 'ArrowLeft' })
  expect(base.onWidthChange).toHaveBeenLastCalledWith(516)
  expect(container.style.getPropertyValue('--workspace-panel-w')).toBe('516px')
  fireEvent.keyDown(edge, { key: 'ArrowRight', shiftKey: true })
  expect(base.onWidthChange).toHaveBeenLastCalledWith(436)
  fireEvent.keyDown(edge, { key: 'End' })
  expect(base.onWidthChange).toHaveBeenLastCalledWith(840)
  fireEvent.keyDown(edge, { key: 'Home' })
  expect(base.onWidthChange).toHaveBeenLastCalledWith(300)

  rerender(<WorkspacePanel {...base} width={300} />)
  fireEvent.keyDown(edge, { key: 'ArrowRight' })
  expect(base.onWidthChange).toHaveBeenLastCalledWith(300)
  fireEvent.keyDown(edge, { key: 'Enter' })
  expect(base.onWidthChange).toHaveBeenLastCalledWith(DEFAULT_WORKSPACE_PANEL_WIDTH)

  const calls = base.onWidthChange.mock.calls.length
  fireEvent.keyDown(edge, { key: 'ArrowLeft', ctrlKey: true })
  fireEvent.keyDown(edge, { key: 'a' })
  expect(base.onWidthChange).toHaveBeenCalledTimes(calls)
})

it('resizes the bottom panel with Up and Down', () => {
  reduceMotion(true)
  const base = props()
  const { container } = renderIn('bottom-terminal', { ...base, placement: 'bottom', width: 260 })
  Object.defineProperty(container.parentElement!, 'clientHeight', {
    configurable: true,
    value: 800,
  })
  const edge = screen.getByRole('separator')
  expect(edge.getAttribute('aria-valuetext')).toBe('260 pixels tall')
  fireEvent.keyDown(edge, { key: 'ArrowUp' })
  expect(base.onWidthChange).toHaveBeenLastCalledWith(276)
  expect(container.style.getPropertyValue('height')).toBe('276px')
  // From the 260px it is drawn at, 64px down stops at the 200px minimum.
  fireEvent.keyDown(edge, { key: 'ArrowDown', shiftKey: true })
  expect(base.onWidthChange).toHaveBeenLastCalledWith(200)
  fireEvent.keyDown(edge, { key: 'End' })
  expect(base.onWidthChange).toHaveBeenLastCalledWith(720)
})

it('saves no size when the edge is pressed and released without moving', () => {
  reduceMotion(true)
  const base = props()
  // 720px of room leaves 360px for the panel: the saved 700 is drawn at 360.
  const { container } = renderIn('workspace-layout', base)
  Object.defineProperty(container, 'clientWidth', { configurable: true, value: 720 })
  const edge = screen.getByRole('separator')
  Object.defineProperty(edge, 'setPointerCapture', { configurable: true, value: vi.fn() })
  fireEvent.pointerDown(edge, { clientX: 500, pointerId: 3 })
  fireEvent.pointerUp(window, { clientX: 500, pointerId: 3 })
  expect(base.onWidthChange).not.toHaveBeenCalled()
})

it('saves no size for a keyboard step that cannot move past a limit', () => {
  reduceMotion(true)
  const base = props()
  const { container, rerender } = renderIn('workspace-layout', base)
  Object.defineProperty(container, 'clientWidth', { configurable: true, value: 720 })
  const edge = screen.getByRole('separator')
  // Drawn at its 360px maximum: widening cannot move it.
  fireEvent.keyDown(edge, { key: 'ArrowLeft' })
  fireEvent.keyDown(edge, { key: 'End' })
  rerender(<WorkspacePanel {...base} width={300} />)
  // At the 300px minimum: narrowing cannot move it.
  fireEvent.keyDown(edge, { key: 'ArrowRight' })
  fireEvent.keyDown(edge, { key: 'Home' })
  expect(base.onWidthChange).not.toHaveBeenCalled()
  fireEvent.keyDown(edge, { key: 'ArrowLeft' })
  expect(base.onWidthChange).toHaveBeenLastCalledWith(316)
})

describe('a bottom panel restored below its 200px minimum', () => {
  // A saved 180px is valid and drawn at 180px: nothing clamps it from below.
  const restored = () => {
    reduceMotion(true)
    const base = { ...props(), placement: 'bottom' as const, width: 180 }
    const { container } = renderIn('bottom-terminal', base)
    Object.defineProperty(container.parentElement!, 'clientHeight', {
      configurable: true,
      value: 800,
    })
    const edge = screen.getByRole('separator')
    Object.defineProperty(edge, 'setPointerCapture', { configurable: true, value: vi.fn() })
    return { base, edge }
  }

  it('moves to the minimum on Home', () => {
    const { base, edge } = restored()
    fireEvent.keyDown(edge, { key: 'Home' })
    expect(base.onWidthChange).toHaveBeenLastCalledWith(200)
  })

  it('keeps a drag that ends exactly at the minimum', () => {
    const { base, edge } = restored()
    fireEvent.pointerDown(edge, { clientY: 500, pointerId: 4 })
    fireEvent.pointerMove(window, { clientY: 450, pointerId: 4 })
    fireEvent.pointerMove(window, { clientY: 500, pointerId: 4 })
    fireEvent.pointerUp(window, { clientY: 500, pointerId: 4 })
    expect(base.onWidthChange).toHaveBeenLastCalledWith(200)
  })

  it('still saves nothing for a press without movement', () => {
    const { base, edge } = restored()
    fireEvent.pointerDown(edge, { clientY: 500, pointerId: 5 })
    fireEvent.pointerUp(window, { clientY: 500, pointerId: 5 })
    expect(base.onWidthChange).not.toHaveBeenCalled()
  })
})

it('keeps the edge of an expanded panel out of the tab order', () => {
  renderIn('workspace-layout', { ...props(), expanded: true })
  expect(screen.getByRole('separator', { hidden: true }).tabIndex).toBe(-1)
})
