// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    act(() => screen.getByRole('button').focus())
    act(() => vi.advanceTimersByTime(6_000))
    act(() => screen.getByRole('button').blur())
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

  it('resumes once the focused control removes itself', () => {
    vi.useFakeTimers()
    const dismiss = vi.fn()
    const renderNotice = (phase: 'idle' | 'running') => (
      <NoticePresence
        className="notice"
        role="status"
        visible
        onDismiss={dismiss}
        dismissKey={phase}
      >
        {phase === 'idle' ? <button>Update</button> : <span>Updating</span>}
      </NoticePresence>
    )
    const view = render(renderNotice('idle'))
    act(() => screen.getByRole('button').focus())
    act(() => vi.advanceTimersByTime(6_000))
    expect(dismiss).not.toHaveBeenCalled()
    // Browsers fire no blur for a focused element that leaves the document.
    view.rerender(renderNotice('running'))
    act(() => vi.advanceTimersByTime(5_000))
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

  describe('over a docked composer', () => {
    const windowSize = { width: window.innerWidth, height: window.innerHeight }
    const setWindow = (width: number, height: number) => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
    }
    const dockComposer = (
      options: {
        newSession?: boolean
        dormant?: boolean
        into?: Element
        left?: number
        width?: number
      } = {},
    ) => {
      const conversation = document.createElement('div')
      conversation.className = `stage__conversation${options.newSession ? ' is-new-session' : ''}`
      const composer = document.createElement('div')
      composer.className = `composer${options.dormant ? ' is-dormant' : ''}`
      const box = document.createElement('div')
      box.className = 'composer__box'
      composer.append(box)
      conversation.append(composer)
      ;(options.into ?? document.body).append(conversation)
      let measured = 0
      const place = (rect: { top: number; left: number; width: number; height: number }) => {
        composer.getBoundingClientRect = () => {
          measured += 1
          return {
            ...rect,
            x: rect.left,
            y: rect.top,
            right: rect.left + rect.width,
            bottom: rect.top + rect.height,
            toJSON: () => rect,
          } as DOMRect
        }
      }
      // By default an 800px column, 24px of composer padding, a 720px box.
      const width = options.width ?? 800
      place({ top: 700, left: options.left ?? 300, width, height: 160 })
      Object.defineProperty(box, 'offsetLeft', { configurable: true, value: 24 })
      Object.defineProperty(box, 'offsetWidth', { configurable: true, value: width - 80 })
      return { conversation, composer, place, measured: () => measured }
    }
    // Two panes as split view lays them out: the start pane on the left.
    const splitStage = () => {
      const split = document.createElement('div')
      split.className = 'split'
      const start = document.createElement('section')
      start.className = 'split__pane is-focused is-start'
      const end = document.createElement('section')
      end.className = 'split__pane is-dormant is-end'
      split.append(start, end)
      document.body.append(split)
      return { start, end }
    }

    afterEach(() => {
      document.querySelectorAll('.split, .stage__conversation').forEach((node) => node.remove())
      setWindow(windowSize.width, windowSize.height)
    })

    it('lifts an open toast above the composer and right-aligns it with the box', () => {
      setWindow(1280, 860)
      dockComposer()
      render(
        <NoticePresence className="notice" role="alert" visible>
          Your draft was replaced.
        </NoticePresence>,
      )

      const notice = screen.getByRole('alert')
      // 160px of composer, then the Jump to latest lane.
      expect(notice.style.getPropertyValue('--notice-bottom')).toBe('216px')
      // 1280 - (300 + 24 + 720): the toast ends where the box ends, not over Send.
      expect(notice.style.getPropertyValue('--notice-right')).toBe('236px')
    })

    it('follows the composer when the window resizes', () => {
      setWindow(1280, 860)
      const { place } = dockComposer()
      render(
        <NoticePresence className="notice" role="alert" visible>
          Your draft was replaced.
        </NoticePresence>,
      )

      // A narrow window: the box fills the column and the composer grows.
      setWindow(727, 640)
      place({ top: 420, left: 0, width: 727, height: 220 })
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })

      const notice = screen.getByRole('alert')
      expect(notice.style.getPropertyValue('--notice-bottom')).toBe('276px')
      // Never closer than 12px to the window edge.
      expect(notice.style.getPropertyValue('--notice-right')).toBe('12px')
    })

    it('measures nothing for a notice pinned away from the corner', () => {
      setWindow(1280, 860)
      dockComposer()
      render(
        <NoticePresence className="notice" role="status" visible followComposer={false}>
          TasteCode 0.5.0 is ready
        </NoticePresence>,
      )

      const notice = screen.getByRole('status')
      expect(notice.style.getPropertyValue('--notice-bottom')).toBe('')
      expect(notice.style.getPropertyValue('--notice-right')).toBe('')
    })

    it('keeps the window corner when no composer is docked', () => {
      setWindow(1280, 860)
      dockComposer({ newSession: true })
      render(
        <NoticePresence className="notice" role="alert" visible>
          Changes undone.
        </NoticePresence>,
      )

      const notice = screen.getByRole('alert')
      expect(notice.style.getPropertyValue('--notice-bottom')).toBe('')
      expect(notice.style.getPropertyValue('--notice-right')).toBe('')
    })

    it('moves above a composer that docks while it is open', async () => {
      setWindow(1280, 860)
      const { conversation } = dockComposer({ newSession: true })
      render(
        <NoticePresence className="notice" role="status" visible>
          1 update
        </NoticePresence>,
      )
      const notice = screen.getByRole('status')
      expect(notice.style.getPropertyValue('--notice-bottom')).toBe('')

      // A chat opens, and its composer docks in the corner the notice holds.
      conversation.classList.remove('is-new-session')

      await waitFor(() => expect(notice.style.getPropertyValue('--notice-bottom')).toBe('216px'))
      expect(notice.style.getPropertyValue('--notice-right')).toBe('236px')
    })

    it('follows a composer that mounts while it is open, and the corner once it leaves', async () => {
      setWindow(1280, 860)
      render(
        <NoticePresence className="notice" role="status" visible>
          1 update
        </NoticePresence>,
      )
      const notice = screen.getByRole('status')

      // Back from another view: the chat stage mounts again.
      const { conversation } = dockComposer()
      await waitFor(() => expect(notice.style.getPropertyValue('--notice-bottom')).toBe('216px'))

      conversation.remove()
      await waitFor(() => expect(notice.style.getPropertyValue('--notice-bottom')).toBe(''))
      expect(notice.style.getPropertyValue('--notice-right')).toBe('')
    })

    it('moves to the other pane when focus moves in a split', async () => {
      setWindow(1280, 860)
      const { start, end } = splitStage()
      const left = dockComposer({ into: start, left: 300, width: 490 })
      const right = dockComposer({ into: end, dormant: true, left: 790, width: 490 })
      render(
        <NoticePresence className="notice" role="status" visible>
          1 update
        </NoticePresence>,
      )
      const notice = screen.getByRole('status')
      // 1280 - (300 + 24 + 410): above the focused left composer.
      expect(notice.style.getPropertyValue('--notice-right')).toBe('546px')

      start.className = 'split__pane is-dormant is-start'
      left.composer.classList.add('is-dormant')
      end.className = 'split__pane is-focused is-end'
      right.composer.classList.remove('is-dormant')

      // 1280 - (790 + 24 + 410)
      await waitFor(() => expect(notice.style.getPropertyValue('--notice-right')).toBe('56px'))
      expect(notice.style.getPropertyValue('--notice-bottom')).toBe('216px')
    })

    it('measures nothing again while the transcript streams', async () => {
      setWindow(1280, 860)
      const { conversation, measured } = dockComposer()
      const transcript = document.createElement('div')
      transcript.className = 'thread'
      conversation.prepend(transcript)
      render(
        <NoticePresence className="notice" role="status" visible>
          1 update
        </NoticePresence>,
      )
      const before = measured()

      for (let delta = 0; delta < 50; delta += 1) {
        const line = document.createElement('p')
        line.textContent = `delta ${delta}`
        transcript.append(line)
        line.classList.toggle('is-streaming')
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      expect(measured()).toBe(before)
    })
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
