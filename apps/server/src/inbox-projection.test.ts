import { describe, expect, it } from 'vitest'
import {
  applyInboxProjectionEvent,
  emptyInboxProjection,
  isEmptyInboxProjection,
} from './inbox-projection.js'

describe('Inbox projection allocation', () => {
  it('does not allocate tracking sets for an idle thread', () => {
    const projection = emptyInboxProjection()
    expect(projection).toEqual({ last: 'idle' })
    expect(isEmptyInboxProjection(projection)).toBe(true)
  })

  it('keeps tracking sets only while requests are pending', () => {
    const projection = emptyInboxProjection()

    applyInboxProjectionEvent(projection, {
      type: 'approval.requested',
      request: { id: 'approval-1', kind: 'command', createdAt: 1 },
    })
    applyInboxProjectionEvent(projection, {
      type: 'user_input.requested',
      request: {
        id: 'input-1',
        turnId: 'turn-1',
        questions: [
          {
            id: 'question-1',
            header: 'Continue',
            question: 'Continue?',
            allowOther: false,
            secret: false,
            options: [{ label: 'Yes', description: 'Continue the work.' }],
          },
        ],
        autoResolutionMs: null,
        createdAt: 1,
      },
    })

    expect(projection.approvals).toEqual(new Set(['approval-1']))
    expect(projection.inputs).toEqual(new Set(['input-1']))
    expect(isEmptyInboxProjection(projection)).toBe(false)

    applyInboxProjectionEvent(projection, { type: 'approval.resolved', id: 'approval-1' })
    applyInboxProjectionEvent(projection, { type: 'user_input.resolved', id: 'input-1' })

    expect(projection).toEqual({ last: 'idle' })
    expect(isEmptyInboxProjection(projection)).toBe(true)
  })
})
