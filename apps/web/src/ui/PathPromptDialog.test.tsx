// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PathPromptDialog } from './PathPromptDialog.js'

afterEach(cleanup)

describe('PathPromptDialog', () => {
  it('submits the trimmed path and disables submit while empty', () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    render(
      <PathPromptDialog
        title="Add project folder"
        label="Folder path"
        placeholder="/path/to/project"
        action="Add folder"
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    )

    const submit = screen.getByRole('button', { name: 'Add folder' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    const input = screen.getByLabelText('Folder path')
    fireEvent.change(input, { target: { value: '  /Users/me/project  ' } })
    expect(submit.disabled).toBe(false)

    fireEvent.submit(input.closest('form')!)
    expect(onSubmit).toHaveBeenCalledWith('/Users/me/project')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('cancels on Escape and Cancel button', () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    render(
      <PathPromptDialog
        title="Add project folder"
        label="Folder path"
        placeholder="/path/to/project"
        action="Add folder"
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    )

    fireEvent.keyDown(screen.getByLabelText('Folder path'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)

    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(2)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
