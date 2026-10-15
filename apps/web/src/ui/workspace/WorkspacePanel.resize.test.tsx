// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
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
  const widths: string[] = []
  const observer = new MutationObserver(() =>
    widths.push(container.style.getPropertyValue('--workspace-panel-w')),
  )
  observer.observe(container, { attributes: true, attributeFilter: ['style'] })

  fireEvent.doubleClick(screen.getByRole('separator'))
  expect(base.onWidthChange).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(base.onWidthChange).toHaveBeenCalledWith(520))
  observer.disconnect()
  const steps = widths.map((width) => Number.parseInt(width, 10))
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

it('keeps the edge of an expanded panel out of the tab order', () => {
  renderIn('workspace-layout', { ...props(), expanded: true })
  expect(screen.getByRole('separator', { hidden: true }).tabIndex).toBe(-1)
})
