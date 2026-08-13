// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RollbackDialog } from './RollbackDialog.js'

describe('RollbackDialog', () => {
  it('owns focus, traps app shortcuts, closes with Escape, and restores focus', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const onClose = vi.fn()
    const shortcut = vi.fn()
    window.addEventListener('keydown', shortcut)

    const view = render(
      <RollbackDialog
        checkpoints={[{ id: 1, seq: 1, label: 'Before edit', createdAt: 1 }]}
        inspection={undefined}
        loadingId={undefined}
        restoring={false}
        onInspect={vi.fn()}
        onRestore={vi.fn()}
        onClose={onClose}
      />,
    )
    const panel = view.container.querySelector<HTMLElement>('.rollback')
    if (!panel) throw new Error('missing rollback panel')
    await waitFor(() => expect(document.activeElement).toBe(panel))

    fireEvent.keyDown(panel, { key: 'n', metaKey: true })
    expect(shortcut).not.toHaveBeenCalled()

    fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Before edit/ }))

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()

    view.unmount()
    expect(document.activeElement).toBe(opener)
    window.removeEventListener('keydown', shortcut)
    opener.remove()
  })
})
