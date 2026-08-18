// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DiffDecision, DiffHunk, SessionDiff } from '@harness/contracts'
import { describe, expect, it, vi } from 'vitest'
import type { Transport } from '../transport.js'
import { DiffReview } from './DiffReview.js'

function hunk(id: string, header: string, decision?: DiffDecision): DiffHunk {
  return {
    id,
    header,
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines: [
      { kind: 'deletion', oldLine: 1, text: 'start(3000)' },
      { kind: 'addition', newLine: 1, text: 'start(4311)' },
    ],
    ...(decision ? { decision } : {}),
  }
}

function snapshot(version: string, first?: DiffDecision, second?: DiffDecision): SessionDiff {
  return {
    threadId: 'thread-1',
    version,
    files: [
      {
        path: 'src/app.ts',
        status: 'modified',
        binary: false,
        hunks: [hunk('one', '@@ -1 +1 @@', first), hunk('two', '@@ -8 +8 @@', second)],
      },
    ],
  }
}

describe('inline diff review', () => {
  it('recovers a stale snapshot and keeps mixed hunk decisions clear', async () => {
    const initial = snapshot('v1')
    const accepted = snapshot('v2', 'accept')
    const mixed = snapshot('v3', 'accept', 'reject')
    const request = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({ diff: accepted })
      .mockRejectedValueOnce(new Error('Refresh the diff and try again.'))
      .mockResolvedValueOnce(accepted)
      .mockResolvedValueOnce({ diff: mixed })

    render(<DiffReview transport={{ request } as unknown as Transport} threadId="thread-1" />)

    expect((await screen.findAllByText('3000'))[0]?.tagName).toBe('MARK')
    fireEvent.click(screen.getByRole('button', { name: 'Accept @@ -1 +1 @@ in src/app.ts' }))
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2))

    const reject = screen.getByRole('button', { name: 'Reject @@ -8 +8 @@ in src/app.ts' })
    fireEvent.click(reject)
    expect(
      await screen.findByText('The diff changed and was refreshed. Choose again.'),
    ).toBeTruthy()
    fireEvent.click(reject)

    await waitFor(() => expect(request).toHaveBeenCalledTimes(5))
    expect(
      (
        screen.getByRole('button', {
          name: 'Accept @@ -1 +1 @@ in src/app.ts',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    expect(
      (
        screen.getByRole('button', {
          name: 'Reject @@ -8 +8 @@ in src/app.ts',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    expect(request).toHaveBeenLastCalledWith('thread.reviewHunk', {
      threadId: 'thread-1',
      version: 'v2',
      path: 'src/app.ts',
      hunkId: 'two',
      decision: 'reject',
    })
  })
})
