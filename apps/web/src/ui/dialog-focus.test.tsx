// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useDialogFocus } from './dialog-focus.js'

afterEach(cleanup)

function Dialog(props: { onClose: () => void }) {
  const dialog = useDialogFocus<HTMLDivElement>(props.onClose)
  return (
    <div ref={dialog.panel} role="dialog" tabIndex={-1} onKeyDown={dialog.onKeyDown}>
      <input aria-label="Name" />
    </div>
  )
}

describe('useDialogFocus', () => {
  it('leaves Escape to an open IME composition instead of closing', () => {
    const onClose = vi.fn()
    render(<Dialog onClose={onClose} />)
    const field = screen.getByLabelText('Name')

    fireEvent.keyDown(field, { key: 'Escape', isComposing: true })
    fireEvent.keyDown(field, { key: 'Escape', keyCode: 229 })
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(field, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
