// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as bridge from '../bridge.js'
import { NoticePresence } from './NoticePresence.js'

const rootCssPath = resolve(process.cwd(), 'apps/web/src/styles/app.css')
const css = readFileSync(
  existsSync(rootCssPath) ? rootCssPath : resolve(process.cwd(), 'src/styles/app.css'),
  'utf8',
)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function dispatchTransitionEnd(element: Element, propertyName: string) {
  const event = new Event('transitionend', { bubbles: true })
  Object.defineProperty(event, 'propertyName', { configurable: true, value: propertyName })
  element.dispatchEvent(event)
}

describe('NoticePresence', () => {
  it('reports startup activity until the exit transition actually completes', () => {
    const milestone = vi.spyOn(bridge, 'reportStartupMilestone')
    const view = render(
      <NoticePresence className="notice" role="status" visible>
        Update
      </NoticePresence>,
    )
    expect(milestone).toHaveBeenCalledExactlyOnceWith('notice-open')
    view.rerender(
      <NoticePresence className="notice" role="status" visible={false}>
        Update
      </NoticePresence>,
    )
    expect(milestone).not.toHaveBeenCalledWith('notice-closed')
    act(() => dispatchTransitionEnd(screen.getByRole('status'), 'opacity'))
    expect(milestone).toHaveBeenLastCalledWith('notice-closed')
    expect(milestone).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(milestone).toHaveBeenCalledTimes(2)
  })

  it.each(['finished', 'cancelled'] as const)(
    'removes an occluded notice when its transition is %s without an end event',
    async (outcome) => {
      let finish!: () => void
      let cancel!: () => void
      const finished = new Promise<void>((resolve, reject) => {
        finish = resolve
        cancel = () => reject(new Error('Transition cancelled'))
      })
      const view = render(
        <NoticePresence className="notice" role="status" visible>
          Update
        </NoticePresence>,
      )
      Object.defineProperty(screen.getByRole('status'), 'getAnimations', {
        value: () => [{ finished }],
      })
      view.rerender(
        <NoticePresence className="notice" role="status" visible={false}>
          Update
        </NoticePresence>,
      )
      expect(screen.getByRole('status').getAttribute('data-state')).toBe('closing')
      await act(async () => {
        if (outcome === 'finished') finish()
        else cancel()
      })
      expect(screen.queryByRole('status')).toBeNull()
    },
  )

  it('finishes an exit when the page becomes hidden', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const notice = (visible: boolean) => (
      <NoticePresence className="notice" role="status" visible={visible}>
        Update
      </NoticePresence>
    )
    const view = render(notice(true))
    view.rerender(notice(false))
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('closing')
    visibility.mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('does not remove a reopened notice when its old transition finishes', async () => {
    let finish!: () => void
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const notice = (visible: boolean) => (
      <NoticePresence className="notice" role="status" visible={visible}>
        Update
      </NoticePresence>
    )
    const view = render(notice(true))
    Object.defineProperty(screen.getByRole('status'), 'getAnimations', {
      value: () => [{ finished }],
    })
    view.rerender(notice(false))
    view.rerender(notice(true))
    await act(async () => finish())
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('open')
  })

  it('uses the latest callback without restarting the timeout on renders', () => {
    vi.useFakeTimers()
    const first = vi.fn()
    const latest = vi.fn()
    const view = render(
      <NoticePresence className="notice" role="status" visible onDismiss={first}>
        Update
      </NoticePresence>,
    )
    act(() => vi.advanceTimersByTime(4_000))
    view.rerender(
      <NoticePresence className="notice" role="status" visible onDismiss={latest}>
        Update
      </NoticePresence>,
    )
    act(() => vi.advanceTimersByTime(1_000))
    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledOnce()
  })

  it('pauses for hover, focus and work, then gives changed content a fresh timeout', () => {
    vi.useFakeTimers()
    const dismiss = vi.fn()
    const renderNotice = (paused = false, key = 'first') => (
      <NoticePresence
        className="notice"
        role="status"
        visible
        onDismiss={dismiss}
        autoDismissPaused={paused}
        dismissKey={key}
      >
        <button>Update</button>
      </NoticePresence>
    )
    const view = render(renderNotice())
    fireEvent.mouseEnter(screen.getByRole('status'))
    act(() => vi.advanceTimersByTime(6_000))
    fireEvent.mouseLeave(screen.getByRole('status'))
    fireEvent.focus(screen.getByRole('button'))
    act(() => vi.advanceTimersByTime(6_000))
    fireEvent.blur(screen.getByRole('button'))
    view.rerender(renderNotice(true))
    act(() => vi.advanceTimersByTime(6_000))
    expect(dismiss).not.toHaveBeenCalled()
    view.rerender(renderNotice())
    act(() => vi.advanceTimersByTime(4_000))
    view.rerender(renderNotice(false, 'second'))
    act(() => vi.advanceTimersByTime(4_999))
    expect(dismiss).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(dismiss).toHaveBeenCalledOnce()
  })

  it('starts hidden when visible is false', () => {
    render(
      <NoticePresence className="notice" role="alert" visible={false}>
        <span>Hidden</span>
      </NoticePresence>,
    )

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders open state when visible is true', () => {
    render(
      <NoticePresence className="notice" role="status" visible>
        <span>Shown</span>
      </NoticePresence>,
    )

    expect(screen.getByRole('status').getAttribute('data-state')).toBe('open')
  })

  it('stays mounted in closing state until the root opacity transition finishes', () => {
    const view = render(
      <NoticePresence className="notice" role="alert" visible>
        <span>Closing</span>
      </NoticePresence>,
    )

    view.rerender(
      <NoticePresence className="notice" role="alert" visible={false}>
        <span>Closing</span>
      </NoticePresence>,
    )

    const notice = screen.getByRole('alert')
    expect(notice.getAttribute('data-state')).toBe('closing')

    act(() => {
      dispatchTransitionEnd(notice, 'transform')
    })
    expect(screen.getByRole('alert')).toBeTruthy()

    act(() => {
      dispatchTransitionEnd(notice, 'opacity')
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores bubbled child transition events while closing', () => {
    const view = render(
      <NoticePresence className="notice" role="alert" visible>
        <span data-testid="child">Child</span>
      </NoticePresence>,
    )

    view.rerender(
      <NoticePresence className="notice" role="alert" visible={false}>
        <span data-testid="child">Child</span>
      </NoticePresence>,
    )

    act(() => {
      dispatchTransitionEnd(screen.getByTestId('child'), 'opacity')
    })
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  it('reopens from a closing phase without unmounting the notice', () => {
    const view = render(
      <NoticePresence className="notice" role="alert" visible>
        <span>First</span>
      </NoticePresence>,
    )

    view.rerender(
      <NoticePresence className="notice" role="alert" visible={false}>
        <span>First</span>
      </NoticePresence>,
    )
    expect(screen.getByRole('alert').getAttribute('data-state')).toBe('closing')

    view.rerender(
      <NoticePresence className="notice notice--success" role="alert" visible>
        <span>Second</span>
      </NoticePresence>,
    )

    const notice = screen.getByRole('alert')
    expect(notice.getAttribute('data-state')).toBe('open')
    expect(notice.classList.contains('notice')).toBe(true)
    expect(notice.classList.contains('notice--success')).toBe(true)
    expect(screen.getByText('Second')).toBeTruthy()

    act(() => {
      dispatchTransitionEnd(notice, 'opacity')
    })
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  it('keeps reduced motion notice handoff to opacity only', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.notice \{[\s\S]*?transform: none !important;[\s\S]*?transition: opacity var\(--dur-fast\) var\(--ease-out\) !important;/s,
    )
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.notice\[data-state='closing'\] \{[\s\S]*?transform: none !important;[\s\S]*?transition-duration: var\(--dur-press\) !important;/s,
    )
  })
})
