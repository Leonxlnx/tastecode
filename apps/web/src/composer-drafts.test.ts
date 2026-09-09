import { describe, expect, it } from 'vitest'
import {
  composerDraftKey,
  emptyComposerDraft,
  isEmptyComposerDraft,
  moveComposerDraft,
  NEW_CHAT_DRAFT_KEY,
  readComposerDraft,
  upsertComposerDraft,
  type ComposerDraft,
} from './composer-drafts.js'
import type { ComposerResource } from './ui/ComposerResourcePicker.js'

const skill: ComposerResource = {
  key: 'skill:docs',
  kind: 'skill',
  id: '/skills/docs/SKILL.md',
  name: 'Docs',
  description: 'Project docs',
  scope: 'Project',
  token: '$docs',
  available: true,
}

function draft(overrides: Partial<ComposerDraft> = {}): ComposerDraft {
  return { ...emptyComposerDraft(), ...overrides }
}

describe('composer drafts', () => {
  it('keeps new chat distinct from every session id', () => {
    expect(composerDraftKey(undefined)).toBe(NEW_CHAT_DRAFT_KEY)
    expect(composerDraftKey('thread-1')).toBe('thread-1')
  })

  it('creates, patches, and drops empty drafts', () => {
    const drafts = new Map<string, ComposerDraft>()
    expect(readComposerDraft(drafts, 'thread-1')).toEqual(emptyComposerDraft())

    upsertComposerDraft(drafts, 'thread-1', { text: 'Fix the parser' })
    expect(readComposerDraft(drafts, 'thread-1')).toEqual(draft({ text: 'Fix the parser' }))

    upsertComposerDraft(drafts, 'thread-1', { attachments: ['/work/notes.md'], resources: [skill] })
    expect(readComposerDraft(drafts, 'thread-1')).toEqual(
      draft({
        text: 'Fix the parser',
        attachments: ['/work/notes.md'],
        resources: [skill],
      }),
    )

    upsertComposerDraft(drafts, 'thread-1', { text: '', attachments: [], resources: [] })
    expect(drafts.has('thread-1')).toBe(false)
    expect(isEmptyComposerDraft(readComposerDraft(drafts, 'thread-1'))).toBe(true)
  })

  it('moves a provisional draft onto the real session once', () => {
    const drafts = new Map<string, ComposerDraft>()
    upsertComposerDraft(drafts, 'pending:1', { text: 'Keep this' })
    upsertComposerDraft(drafts, 'thread-1', { text: 'Already here' })

    moveComposerDraft(drafts, 'pending:1', 'thread-1')
    expect(drafts.has('pending:1')).toBe(false)
    expect(readComposerDraft(drafts, 'thread-1')).toEqual(draft({ text: 'Already here' }))

    upsertComposerDraft(drafts, 'pending:2', { text: 'New words' })
    moveComposerDraft(drafts, 'pending:2', 'thread-2')
    expect(readComposerDraft(drafts, 'thread-2')).toEqual(draft({ text: 'New words' }))
  })
})
