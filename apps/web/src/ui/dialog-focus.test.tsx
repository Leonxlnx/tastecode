// @vitest-environment happy-dom
import { useLayoutEffect, useRef, useState } from 'react'
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

// Like Menu: choosing an item closes the menu, which returns focus to its
// trigger in a layout effect after the dialog it opened has rendered.
function MenuOpener() {
  const trigger = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  useLayoutEffect(() => {
    if (!menuOpen) trigger.current?.focus()
  }, [menuOpen])
  return (
    <>
      <button ref={trigger}>Chat actions</button>
      {menuOpen ? (
        <button
          onClick={() => {
            setMenuOpen(false)
            setDialogOpen(true)
          }}
        >
          Rename
        </button>
      ) : null}
      {dialogOpen ? <Dialog onClose={() => setDialogOpen(false)} /> : null}
    </>
  )
}

describe('useDialogFocus', () => {
  it('returns focus to the menu trigger that the opener handed it to', () => {
    render(<MenuOpener />)
    const item = screen.getByRole('button', { name: 'Rename' })
    item.focus()
    fireEvent.click(item)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Chat actions' }))
  })

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
