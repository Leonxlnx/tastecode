// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DiffDecision, DiffHunk, SessionDiff } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { requiredInstance, requiredValue } from '../test-dom.js'
import { TestTransport } from '../test-transport.js'
import { DiffReview } from './DiffReview.js'
import { propertiesWhen } from '../properties-when.js'

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
    ...propertiesWhen(decision, (decision) => ({ decision })),
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
    const replies = [
      initial,
      { diff: accepted },
      new Error('Refresh the diff and try again.'),
      accepted,
      { diff: mixed },
    ]
    const transport = new TestTransport(async () => {
      const reply = requiredValue(replies.shift(), 'diff response')
      if (reply instanceof Error) throw reply
      return reply
    })

    render(<DiffReview transport={transport} threadId="thread-1" />)

    expect((await screen.findAllByText('3000'))[0]?.tagName).toBe('MARK')
    fireEvent.click(screen.getByRole('button', { name: 'Accept @@ -1 +1 @@ in src/app.ts' }))
    await waitFor(() => expect(transport.requests).toHaveLength(2))

    const reject = screen.getByRole('button', { name: 'Reject @@ -8 +8 @@ in src/app.ts' })
    fireEvent.click(reject)
    expect(
      await screen.findByText('The diff changed and was refreshed. Choose again.'),
    ).toBeTruthy()
    fireEvent.click(reject)

    await waitFor(() => expect(transport.requests).toHaveLength(5))
    expect(
      requiredInstance(
        screen.getByRole('button', {
          name: 'Accept @@ -1 +1 @@ in src/app.ts',
        }),
        HTMLButtonElement,
      ).disabled,
    ).toBe(true)
    expect(
      requiredInstance(
        screen.getByRole('button', {
          name: 'Reject @@ -8 +8 @@ in src/app.ts',
        }),
        HTMLButtonElement,
      ).disabled,
    ).toBe(true)
    expect(transport.requests.at(-1)).toEqual({
      method: 'thread.reviewHunk',
      params: {
        threadId: 'thread-1',
        version: 'v2',
        path: 'src/app.ts',
        hunkId: 'two',
        decision: 'reject',
      },
    })
  })
})
