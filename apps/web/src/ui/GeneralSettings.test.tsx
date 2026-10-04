// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SidebarSettings } from '@harness/contracts'
import { MODEL_PICKER_LAYOUT_KEY, writeModelPickerLayout } from '../model-picker-layout.js'
import { TERMINAL_PLACEMENT_KEY, writeTerminalPlacement } from '../terminal-placement.js'
import { GeneralSettings } from './GeneralSettings.js'

function renderGeneral(settings: SidebarSettings = { mode: 'inbox', autoSettleDays: 3 }) {
  const change = vi.fn()
  const view = render(
    <GeneralSettings sidebarSettings={settings} onSidebarSettingsChange={change} />,
  )
  return {
    change,
    rerender: (next: SidebarSettings) =>
      view.rerender(<GeneralSettings sidebarSettings={next} onSidebarSettingsChange={change} />),
  }
}

function plan() {
  return screen.getByRole('img', { name: /^Window plan/ })
}

afterEach(() => {
  cleanup()
  act(() => {
    writeTerminalPlacement('workspace')
    writeModelPickerLayout('list')
  })
})

describe('general settings', () => {
  it('chooses the sidebar with its two words and with arrow keys', () => {
    const { change } = renderGeneral()
    const classic = screen.getByRole('radio', { name: 'Classic' })
    const inbox = screen.getByRole('radio', { name: 'Inbox' })
    expect(inbox.getAttribute('aria-checked')).toBe('true')
    expect(inbox.tabIndex).toBe(0)
    expect(classic.tabIndex).toBe(-1)

    fireEvent.click(inbox)
    expect(change).not.toHaveBeenCalled()

    fireEvent.keyDown(inbox, { key: 'ArrowLeft' })
    expect(change).toHaveBeenLastCalledWith({ mode: 'classic' })
    expect(document.activeElement).toBe(classic)
  })

  it('folds the settle scale away under the Classic sidebar', () => {
    const { rerender } = renderGeneral({ mode: 'classic', autoSettleDays: 3 })
    expect(screen.queryByRole('slider', { name: 'Settle idle chats' })).toBeNull()
    expect(plan().getAttribute('aria-label')).toContain('Classic sidebar')

    rerender({ mode: 'inbox', autoSettleDays: 3 })
    const scale = screen.getByRole('slider', { name: 'Settle idle chats' })
    expect(scale.getAttribute('aria-valuetext')).toBe('3 days')
    expect(plan().getAttribute('aria-label')).toContain('chats settle after 3 days')
  })

  it('steps the settle scale by day, by labelled stop and out to never', () => {
    const { change, rerender } = renderGeneral()
    const scale = screen.getByRole('slider', { name: 'Settle idle chats' })

    fireEvent.keyDown(scale, { key: 'ArrowRight' })
    expect(change).toHaveBeenLastCalledWith({ autoSettleDays: 4 })
    fireEvent.keyDown(scale, { key: 'PageUp' })
    expect(change).toHaveBeenLastCalledWith({ autoSettleDays: 7 })
    fireEvent.keyDown(scale, { key: 'PageDown' })
    expect(change).toHaveBeenLastCalledWith({ autoSettleDays: 1 })
    fireEvent.keyDown(scale, { key: 'End' })
    expect(change).toHaveBeenLastCalledWith({ autoSettleDays: null })

    rerender({ mode: 'inbox', autoSettleDays: null })
    expect(scale.getAttribute('aria-valuetext')).toBe('Never')
    fireEvent.keyDown(scale, { key: 'ArrowLeft' })
    expect(change).toHaveBeenLastCalledWith({ autoSettleDays: 90 })
    change.mockClear()
    fireEvent.keyDown(scale, { key: 'ArrowRight' })
    expect(change).not.toHaveBeenCalled()
  })

  it('saves a drag only where the pointer lets go', () => {
    const { change } = renderGeneral()
    const scale = screen.getByRole('slider', { name: 'Settle idle chats' })
    Object.defineProperty(scale, 'setPointerCapture', { value: vi.fn() })
    // 200px of logarithmic run, then the 64px tail out to "never".
    vi.spyOn(scale, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 264, 34))

    fireEvent.pointerDown(scale, { button: 0, pointerId: 1, clientX: 0 })
    expect(scale.getAttribute('aria-valuetext')).toBe('1 day')
    fireEvent.pointerMove(scale, { pointerId: 1, clientX: 100 })
    expect(scale.getAttribute('aria-valuetext')).toBe('9 days')
    expect(plan().getAttribute('aria-label')).toContain('chats settle after 9 days')
    fireEvent.pointerMove(scale, { pointerId: 1, clientX: 250 })
    expect(scale.getAttribute('aria-valuetext')).toBe('Never')
    expect(change).not.toHaveBeenCalled()

    fireEvent.pointerUp(scale, { pointerId: 1, clientX: 250 })
    expect(change).toHaveBeenCalledTimes(1)
    expect(change).toHaveBeenCalledWith({ autoSettleDays: null })
  })

  it('drops a cancelled drag', () => {
    const { change } = renderGeneral()
    const scale = screen.getByRole('slider', { name: 'Settle idle chats' })
    Object.defineProperty(scale, 'setPointerCapture', { value: vi.fn() })
    vi.spyOn(scale, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 264, 34))

    fireEvent.pointerDown(scale, { button: 0, pointerId: 1, clientX: 0 })
    fireEvent.pointerCancel(scale, { pointerId: 1 })

    expect(scale.getAttribute('aria-valuetext')).toBe('3 days')
    expect(change).not.toHaveBeenCalled()
  })

  it('moves the terminal and the model picker in the plan', () => {
    renderGeneral()

    expect(plan().getAttribute('aria-label')).toContain('terminal on the right')
    fireEvent.click(screen.getByRole('radio', { name: 'Bottom' }))
    expect(localStorage.getItem(TERMINAL_PLACEMENT_KEY)).toBe('bottom')
    expect(plan().getAttribute('aria-label')).toContain('terminal at the bottom')

    fireEvent.click(screen.getByRole('radio', { name: 'Rail' }))
    expect(localStorage.getItem(MODEL_PICKER_LAYOUT_KEY)).toBe('rail')
    expect(plan().getAttribute('aria-label')).toContain('model picker as a rail')

    act(() => writeTerminalPlacement('workspace'))
    expect(screen.getByRole('radio', { name: 'Right' }).getAttribute('aria-checked')).toBe('true')
  })

  it('lights and captions the part of the window a line decides', () => {
    renderGeneral()
    expect(plan().getAttribute('data-lit')).toBeNull()

    act(() => screen.getByRole('radio', { name: 'Bottom' }).focus())
    expect(plan().getAttribute('data-lit')).toBe('terminal')
    expect(screen.getByText('Where the Toggle terminal shortcut opens a terminal.')).toBeTruthy()

    act(() => screen.getByRole('slider', { name: 'Settle idle chats' }).focus())
    expect(plan().getAttribute('data-lit')).toBe('settle')
    expect(
      screen.getByText(
        'Chats untouched for 3 days fold into Settled. New activity brings them back.',
      ),
    ).toBeTruthy()
  })
})
