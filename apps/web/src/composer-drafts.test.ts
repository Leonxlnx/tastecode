import { describe, expect, it } from 'vitest'
import {
  composerDraftKey,
  emptyComposerDraft,
  isEmptyComposerDraft,
  joinComposerDraft,
  moveComposerDraft,
  NEW_CHAT_DRAFT_KEY,
  parkedNewChatDraftKey,
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

  it('joins a draft behind the one already there, keeping both', () => {
    const drafts = new Map<string, ComposerDraft>()
    upsertComposerDraft(drafts, NEW_CHAT_DRAFT_KEY, {
      text: 'Live words',
      attachments: ['/work/a.png'],
      resources: [skill],
    })
    upsertComposerDraft(drafts, 'waiting', {
      text: 'Waiting words',
      attachments: ['/work/a.png', '/work/b.png'],
      resources: [skill],
    })

    joinComposerDraft(drafts, 'waiting', NEW_CHAT_DRAFT_KEY)
    expect(drafts.has('waiting')).toBe(false)
    expect(readComposerDraft(drafts, NEW_CHAT_DRAFT_KEY)).toEqual(
      draft({
        text: 'Live words\n\nWaiting words',
        attachments: ['/work/a.png', '/work/b.png'],
        resources: [skill],
      }),
    )
  })

  it('joins onto an empty key as a plain move, and ignores a missing or same key', () => {
    const drafts = new Map<string, ComposerDraft>()
    upsertComposerDraft(drafts, 'from', { text: 'Only words' })
    joinComposerDraft(drafts, 'from', 'to')
    expect(drafts.has('from')).toBe(false)
    expect(readComposerDraft(drafts, 'to')).toEqual(draft({ text: 'Only words' }))

    joinComposerDraft(drafts, 'missing', 'to')
    joinComposerDraft(drafts, 'to', 'to')
    expect(readComposerDraft(drafts, 'to')).toEqual(draft({ text: 'Only words' }))
  })

  it("keeps a project's waiting New chat draft apart from the live one and from chats", () => {
    expect(parkedNewChatDraftKey('/work/project')).not.toBe(NEW_CHAT_DRAFT_KEY)
    expect(parkedNewChatDraftKey('/work/project')).not.toBe(parkedNewChatDraftKey('/work/other'))
    expect(parkedNewChatDraftKey('/work/project').startsWith('pending:')).toBe(false)
  })
})
