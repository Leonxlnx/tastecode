// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '../transport.js'
import { Diff, parseDiff, undoQuestion } from './Diff.js'

const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-start(3000)
+start(4311)`

afterEach(cleanup)

describe('change summary', () => {
  it('shows per-file stats and opens the patch from Review', () => {
    render(<Diff diff={DIFF} />)

    expect(screen.getByText('Edited 1 file')).toBeTruthy()
    expect(screen.getByText('src/')).toBeTruthy()
    expect(screen.getByText('app.ts')).toBeTruthy()
    expect(screen.queryByText('@@ -1 +1 @@')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))

    expect(screen.getByText('@@ -1 +1 @@')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })

  it('keeps large change sets to three rows until expanded', () => {
    const manyFiles = Array.from(
      { length: 5 },
      (_, index) => `diff --git a/src/file-${index}.ts b/src/file-${index}.ts\n+line`,
    ).join('\n')

    render(<Diff diff={manyFiles} />)

    expect(screen.getByText('file-2.ts')).toBeTruthy()
    expect(screen.queryByText('file-3.ts')).toBeNull()
    expect(screen.queryByText('−0')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Show 2 more files/ }))

    expect(screen.getByText('file-3.ts')).toBeTruthy()
    expect(screen.getByText('file-4.ts')).toBeTruthy()
  })

  it('undoes the displayed change block and removes it after success', async () => {
    const onUndo = vi.fn().mockResolvedValue(undefined)
    render(<Diff diff={DIFF} onUndo={onUndo} />)

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(onUndo).not.toHaveBeenCalled()
    expect(screen.getByRole('group', { name: 'Confirm undo' }).textContent).toContain(
      'Undo these changes? 1 file is restored.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Undo changes' }))

    expect(screen.getByRole('button', { name: 'Undoing…' }).hasAttribute('disabled')).toBe(true)
    await waitFor(() => expect(onUndo).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.queryByLabelText('Edited files')).toBeNull())
  })

  it('keeps the changes when the confirmation is answered with Keep', () => {
    const onUndo = vi.fn().mockResolvedValue(undefined)
    render(<Diff diff={DIFF} onUndo={onUndo} />)

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))

    expect(onUndo).not.toHaveBeenCalled()
    expect(screen.queryByRole('group', { name: 'Confirm undo' })).toBeNull()
    expect(screen.getByLabelText('Edited files')).toBeTruthy()
  })

  it('keeps the changes and returns to Undo when the question is answered with Escape', () => {
    const onUndo = vi.fn().mockResolvedValue(undefined)
    const outside = vi.fn()
    render(
      <div onKeyDown={outside}>
        <Diff diff={DIFF} onUndo={onUndo} />
      </div>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Keep' }), { key: 'Escape' })

    expect(onUndo).not.toHaveBeenCalled()
    expect(screen.queryByRole('group', { name: 'Confirm undo' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo' }))
    // The question took the Escape; a chat-wide Escape handler does not see it.
    expect(outside).not.toHaveBeenCalled()

    // From Undo itself, too, and an Escape with nothing open still goes on.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Undo' }), { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'Confirm undo' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Undo' }), { key: 'Escape' })
    expect(outside).toHaveBeenCalledOnce()
  })

  it('counts the files Undo deletes apart from the ones it restores', () => {
    const created = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1a2b3c4
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1 @@
+export const created = true
diff --git a/src/other.ts b/src/other.ts
--- /dev/null
+++ b/src/other.ts
@@ -0,0 +1 @@
+export const other = true`
    expect(undoQuestion(parseDiff(created).fileEntries)).toBe(
      'Undo these changes? 2 new files are deleted.',
    )
    expect(
      undoQuestion(
        parseDiff(`${created}
${DIFF}`).fileEntries,
      ),
    ).toBe('Undo these changes? 2 new files are deleted and 1 file restored.')
    expect(undoQuestion(parseDiff(DIFF).fileEntries)).toBe(
      'Undo these changes? 1 file is restored.',
    )
  })

  it('keeps the block visible and explains a failed undo', async () => {
    const onUndo = vi.fn().mockRejectedValue(new Error('The files changed after this edit.'))
    render(<Diff diff={DIFF} onUndo={onUndo} />)

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Undo changes' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'The files changed after this edit.',
    )
    expect(screen.getByLabelText('Edited files')).toBeTruthy()
  })

  it('shows the turn patch from Review in a chat that works in the project checkout', async () => {
    const request = vi.fn().mockRejectedValue(new Error('diff review requires an isolated session'))
    const { container } = render(
      <Diff diff={DIFF} threadId="thread-1" transport={{ request } as unknown as Transport} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))

    expect(await screen.findByText('@@ -1 +1 @@')).toBeTruthy()
    expect(container.querySelector('.diff__body')).not.toBeNull()
    expect(screen.queryByText('Review unavailable')).toBeNull()
    expect(screen.queryByText(/isolated session/)).toBeNull()
    expect(request).toHaveBeenCalledWith('thread.diff', { threadId: 'thread-1' })
  })

  it('still explains other review failures', async () => {
    const request = vi.fn().mockRejectedValue(new Error('git is not installed'))
    const { container } = render(
      <Diff diff={DIFF} threadId="thread-1" transport={{ request } as unknown as Transport} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))

    expect(await screen.findByText('git is not installed')).toBeTruthy()
    expect(screen.getByText('Review unavailable')).toBeTruthy()
    expect(container.querySelector('.diff__body')).toBeNull()
  })
})
