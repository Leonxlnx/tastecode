// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TestTransport } from '../../test-transport.js'
import { WorkspacePanel } from './WorkspacePanel.js'

const originalRect = Element.prototype.getBoundingClientRect
let reduceMotion = false

beforeEach(() => {
  vi.useFakeTimers()
  reduceMotion = false
  // Report every observed element at once, the way the browser does after its
  // first layout; the open panel is 520px wide.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback([], this as unknown as ResizeObserver)
      }
      unobserve() {}
      disconnect() {}
    },
  )
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const width = this.classList.contains('workspace-panel') ? 520 : 0
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, width, height: 0 } as DOMRect
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('reduce') && reduceMotion,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
})

afterEach(() => {
  cleanup()
  Element.prototype.getBoundingClientRect = originalRect
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const props = {
  open: true,
  expanded: false,
  width: 520,
  transport: new TestTransport(),
  theme: 'dark' as const,
  sideChatParentStatus: 'idle' as const,
  sideChatStartOptions: { approval: 'ask' as const },
  nativeSurfacesVisible: true,
  onOpen: vi.fn(),
  onClose: vi.fn(),
  onWidthChange: vi.fn(),
}

describe('WorkspacePanel leaving', () => {
  it('leaves over the chat at its last open width for the length of its fade', () => {
    const { container, rerender } = render(<WorkspacePanel {...props} />)
    const panel = container.querySelector<HTMLElement>('.workspace-panel')!
    expect(panel.hasAttribute('data-leaving')).toBe(false)

    rerender(<WorkspacePanel {...props} open={false} />)
    expect(panel.hasAttribute('data-leaving')).toBe(true)
    expect(panel.style.getPropertyValue('--workspace-panel-leave-w')).toBe('520px')

    act(() => vi.advanceTimersByTime(260))
    expect(panel.hasAttribute('data-leaving')).toBe(false)
    expect(panel.style.getPropertyValue('--workspace-panel-leave-w')).toBe('')
  })

  it('knows its width when hidden before the browser rendered a frame of it open', () => {
    // An observer that has not reported yet, as in the frame the panel opened.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    const { container, rerender } = render(<WorkspacePanel {...props} open={false} />)
    const panel = container.querySelector<HTMLElement>('.workspace-panel')!

    rerender(<WorkspacePanel {...props} />)
    rerender(<WorkspacePanel {...props} open={false} />)

    expect(panel.hasAttribute('data-leaving')).toBe(true)
    expect(panel.style.getPropertyValue('--workspace-panel-leave-w')).toBe('520px')
  })

  it('drops the leaving frame at once when the panel opens again mid-fade', () => {
    const { container, rerender } = render(<WorkspacePanel {...props} />)
    const panel = container.querySelector<HTMLElement>('.workspace-panel')!

    rerender(<WorkspacePanel {...props} open={false} />)
    act(() => vi.advanceTimersByTime(100))
    rerender(<WorkspacePanel {...props} />)

    expect(panel.hasAttribute('data-leaving')).toBe(false)
    expect(panel.classList.contains('is-open')).toBe(true)
  })

  it('simply hides under reduced motion', () => {
    reduceMotion = true
    const { container, rerender } = render(<WorkspacePanel {...props} />)
    const panel = container.querySelector<HTMLElement>('.workspace-panel')!

    rerender(<WorkspacePanel {...props} open={false} />)
    expect(panel.hasAttribute('data-leaving')).toBe(false)
  })

  it('leaves the bottom panel to its own terminal motion', () => {
    const { container, rerender } = render(<WorkspacePanel {...props} placement="bottom" />)
    const panel = container.querySelector<HTMLElement>('.workspace-panel')!

    rerender(<WorkspacePanel {...props} placement="bottom" open={false} />)
    expect(panel.hasAttribute('data-leaving')).toBe(false)
  })
})
