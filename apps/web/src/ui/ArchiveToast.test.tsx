// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ArchiveToast } from './ArchiveToast.js'

afterEach(cleanup)

it.each([
  [1, 'Chat deleted'],
  [3, '3 chats deleted'],
] as const)('describes %s pending deletions honestly and offers only Undo', (count, label) => {
  const onUndo = vi.fn()
  const onDismiss = vi.fn()
  render(<ArchiveToast count={count} visible onUndo={onUndo} onDismiss={onDismiss} />)
  expect(screen.getByRole('status').textContent).toContain(label)
  expect(screen.queryByRole('button', { name: 'View' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(onUndo).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss deletion notification' }))
  expect(onDismiss).toHaveBeenCalledOnce()
})
