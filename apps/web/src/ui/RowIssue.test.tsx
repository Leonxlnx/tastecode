// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RowIssue } from './RowIssue.js'

beforeEach(() => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('row issue tooltip', () => {
  it('does not create hover state from touch or coarse pointers, but keeps focus access', () => {
    render(<RowIssue message="Update failed" />)
    const trigger = screen.getByRole('button')
    fireEvent.pointerEnter(trigger, { pointerType: 'touch' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.pointerLeave(trigger)
    vi.mocked(window.matchMedia).mockReturnValue({ matches: false } as MediaQueryList)
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    act(() => trigger.focus())
    expect(screen.getByRole('tooltip')).toBeTruthy()
  })

  it('escapes clipped cards, fits the viewport, and closes on Escape without losing focus', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.tagName === 'BUTTON' ? new DOMRect(10, 10, 22, 22) : new DOMRect(0, 0, 300, 70)
    })
    render(
      <div style={{ overflow: 'hidden' }}>
        <RowIssue message="Update failed" tip="Try again." />
      </div>,
    )
    const trigger = screen.getByRole('button', { name: 'Problem: Update failed' })
    act(() => trigger.focus())
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.parentElement).toBe(document.body)
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id)
    expect(tooltip.style.left).toBe('8px')
    expect(tooltip.style.top).toBe('40px')
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(trigger.hasAttribute('aria-describedby')).toBe(false)
  })

  it('keeps the tooltip open while the pointer crosses to its text, then removes it', () => {
    vi.useFakeTimers()
    render(<RowIssue message="Details to read" />)
    const trigger = screen.getByRole('button')
    fireEvent.pointerEnter(trigger)
    const tooltip = screen.getByRole('tooltip')
    fireEvent.pointerLeave(trigger)
    fireEvent.pointerEnter(tooltip)
    act(() => vi.advanceTimersByTime(150))
    expect(screen.getByRole('tooltip')).toBe(tooltip)
    fireEvent.pointerLeave(tooltip)
    act(() => vi.advanceTimersByTime(150))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
