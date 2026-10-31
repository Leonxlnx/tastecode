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

  it('leaves a focused pane alone', () => {
    const onFocusPane = vi.fn()
    render(pane({ split: true, focused: true, onFocusPane }))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Approve' }), { button: 0 })
    expect(onFocusPane).not.toHaveBeenCalled()
    expect(screen.getByRole('region', { name: 'Right chat' }).className).toContain('is-focused')
  })
})
