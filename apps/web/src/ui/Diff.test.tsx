// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Diff } from './Diff.js'

const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-start(3000)
+start(4311)`

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
})
