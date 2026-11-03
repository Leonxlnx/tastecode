// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SplitPane } from './SplitPane.js'

afterEach(cleanup)

function pane(props: { split: boolean; focused: boolean; onFocusPane?: () => void }) {
  return (
    <SplitPane
      slot={1}
      split={props.split}
      focused={props.focused}
      start={false}
      label="Right chat"
      onFocusPane={props.onFocusPane ?? vi.fn()}
    >
      <button type="button">Approve</button>
    </SplitPane>
  )
}

describe('SplitPane', () => {
  it('takes no box of its own without a split', () => {
    render(pane({ split: false, focused: true }))
    const wrapper = screen.getByRole('button', { name: 'Approve' }).parentElement!
    expect(wrapper.style.display).toBe('contents')
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('claims focus on a press or keyboard focus before its content acts', () => {
    const onFocusPane = vi.fn()
    render(pane({ split: true, focused: false, onFocusPane }))
    const button = screen.getByRole('button', { name: 'Approve' })
    expect(screen.getByRole('region', { name: 'Right chat' }).className).toContain('is-dormant')

    fireEvent.pointerDown(button, { button: 0 })
    expect(onFocusPane).toHaveBeenLastCalledWith(1, false)
    fireEvent.focus(button)
    expect(onFocusPane).toHaveBeenCalledTimes(2)
    // A right-button press opens a context menu; it does not move focus.
    fireEvent.pointerDown(button, { button: 2 })
    expect(onFocusPane).toHaveBeenCalledTimes(2)
  })

  it('keeps the caret in the composer a press focused the pane through', () => {
    const onFocusPane = vi.fn()
    render(
      <SplitPane
        slot={1}
        split
        focused={false}
        start={false}
        label="Right chat"
        onFocusPane={onFocusPane}
      >
        <div className="composer__box" data-testid="composer-box" />
      </SplitPane>,
    )
    const box = screen.getByTestId('composer-box')
    box.getBoundingClientRect = () => ({ left: 10, right: 110, top: 10, bottom: 60 }) as DOMRect

    // A press beside the composer focuses the pane and lets focus move as usual.
    fireEvent.pointerDown(box, { button: 0, clientX: 500, clientY: 30 })
    expect(onFocusPane).toHaveBeenLastCalledWith(1, false)
    expect(fireEvent.mouseDown(box)).toBe(true)

    // A press on it focuses the composer; the mousedown after it must not take
    // focus away again, and only that one mousedown is held back.
    fireEvent.pointerDown(box, { button: 0, clientX: 50, clientY: 30 })
    expect(onFocusPane).toHaveBeenLastCalledWith(1, true)
    expect(fireEvent.mouseDown(box)).toBe(false)
    expect(fireEvent.mouseDown(box)).toBe(true)
  })

  it('leaves a focused pane alone', () => {
    const onFocusPane = vi.fn()
    render(pane({ split: true, focused: true, onFocusPane }))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Approve' }), { button: 0 })
    expect(onFocusPane).not.toHaveBeenCalled()
    expect(screen.getByRole('region', { name: 'Right chat' }).className).toContain('is-focused')
  })
})
