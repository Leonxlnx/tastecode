// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TurnRail, type TurnRailProps } from './TurnRail.js'

const entries = [
  { turnId: 't1', index: 0, prompt: 'Fix the login bug', at: 1 },
  { turnId: 't2', index: 4, prompt: 'Now the tests', at: 2 },
  { turnId: 't3', index: 9, prompt: 'Ship it', at: 3 },
]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function renderRail(overrides: Partial<TurnRailProps> = {}) {
  const scroller = document.createElement('div')
  document.body.append(scroller)
  const props: TurnRailProps = {
    entries,
    scroller: { current: scroller },
    visibleRows: () => ({ first: 5, last: 10 }),
    replyOf: (turnId) => (turnId === 't2' ? 'All 42 pass.' : ''),
    onJump: vi.fn(),
    onWheel: vi.fn(),
    ...overrides,
  }
  render(<TurnRail {...props} />)
  return props
}

const tick = (name: string) => screen.getByRole('button', { name })
/** The card's prompt and answer, without its time. */
const card = () => {
  const preview = document.querySelector('.turn-rail__preview')
  if (!preview) return undefined
  return [
    preview.querySelector('.turn-rail__prompt')?.textContent,
    preview.querySelector('.turn-rail__reply')?.textContent,
  ]
    .filter(Boolean)
    .join(' / ')
}

describe('TurnRail', () => {
  it('leaves the pill out before anything is on screen', () => {
    renderRail({ visibleRows: () => undefined })

    expect((document.querySelector('.turn-rail__pill') as HTMLElement).hidden).toBe(true)
  })

  it('shows nothing for a chat with one turn', () => {
    renderRail({ entries: entries.slice(0, 1) })

    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('marks each prompt and the exchanges on screen', () => {
    renderRail()

    expect(
      screen.getAllByRole('button').map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Fix the login bug', 'Now the tests', 'Ship it'])
    expect(tick('Fix the login bug').hasAttribute('data-in-view')).toBe(false)
    expect(tick('Now the tests').hasAttribute('data-in-view')).toBe(true)
    expect(tick('Now the tests').getAttribute('aria-current')).toBe('location')
    expect(tick('Ship it').hasAttribute('data-in-view')).toBe(true)
    // The pill marks them, as the sidebar marks the open chat.
    expect((document.querySelector('.turn-rail__pill') as HTMLElement).hidden).toBe(false)
    // One stop in the tab order: the exchange being read.
    expect(tick('Now the tests').tabIndex).toBe(0)
    expect(tick('Ship it').tabIndex).toBe(-1)
  })

  it('previews an exchange after the pointer rests on its tick', () => {
    renderRail()

    fireEvent.pointerMove(tick('Now the tests'), { pointerType: 'mouse' })
    expect(document.querySelector('.turn-rail__preview')).toBeNull()
    act(() => vi.advanceTimersByTime(90))

    expect(card()).toBe('Now the tests / All 42 pass.')
    expect(document.querySelector('.turn-rail__time')?.getAttribute('dateTime')).toBe(
      new Date(2).toISOString(),
    )
    expect(tick('Now the tests').hasAttribute('data-previewed')).toBe(true)

    // Moving along the rail swaps the card at once.
    fireEvent.pointerMove(tick('Ship it'), { pointerType: 'mouse' })
    expect(card()).toBe('Ship it')

    fireEvent.pointerLeave(document.querySelector('.turn-rail__ticks')!)
    expect(document.querySelector('.turn-rail__preview')).toBeNull()
  })

  it('opens nothing for a pointer that only crosses the rail', () => {
    renderRail()

    fireEvent.pointerMove(tick('Now the tests'), { pointerType: 'mouse' })
    fireEvent.pointerLeave(document.querySelector('.turn-rail__ticks')!)
    act(() => vi.advanceTimersByTime(200))

    expect(document.querySelector('.turn-rail__preview')).toBeNull()
  })

  it('goes to the turn and closes the card on click', () => {
    const props = renderRail()

    fireEvent.pointerMove(tick('Ship it'), { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(90))
    fireEvent.click(tick('Ship it'))

    expect(props.onJump).toHaveBeenCalledWith(9)
    expect(document.querySelector('.turn-rail__preview')).toBeNull()
    // The pointer still resting there does not bring it straight back.
    fireEvent.pointerMove(tick('Ship it'), { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(200))
    expect(document.querySelector('.turn-rail__preview')).toBeNull()
  })

  it('walks the turns from the keyboard', () => {
    renderRail()

    tick('Now the tests').focus()
    fireEvent.keyDown(tick('Now the tests'), { key: 'ArrowUp' })

    expect(document.activeElement).toBe(tick('Fix the login bug'))
    expect(card()).toBe('Fix the login bug')
    fireEvent.keyDown(tick('Fix the login bug'), { key: 'End' })
    expect(document.activeElement).toBe(tick('Ship it'))
    fireEvent.keyDown(tick('Ship it'), { key: 'Escape' })
    expect(document.querySelector('.turn-rail__preview')).toBeNull()
  })

  it('hands a wheel over the rail to the chat', () => {
    const props = renderRail()

    fireEvent.wheel(tick('Now the tests'), { deltaY: 120 })

    expect(props.onWheel).toHaveBeenCalledOnce()
  })
})
