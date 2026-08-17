// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Diff } from './Diff.js'

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

    expect(screen.getByRole('button', { name: 'Undoing…' }).hasAttribute('disabled')).toBe(true)
    await waitFor(() => expect(onUndo).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.queryByLabelText('Edited files')).toBeNull())
  })

  it('keeps the block visible and explains a failed undo', async () => {
    const onUndo = vi.fn().mockRejectedValue(new Error('The files changed after this edit.'))
    render(<Diff diff={DIFF} onUndo={onUndo} />)

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'The files changed after this edit.',
    )
    expect(screen.getByLabelText('Edited files')).toBeTruthy()
  })
})
