import { describe, expect, it } from 'vitest'
import {
  ChatAttention,
  MAX_REPORTED_CHATS,
  NOTICE_TEXT,
  parseChatAttentionReport,
  type ChatState,
  type NotificationMode,
} from './chat-attention.js'

function report(
  chats: Record<string, ChatState>,
  mode: NotificationMode = 'needs-you',
  titles: Record<string, string> = {},
) {
  return {
    mode,
    chats: Object.entries(chats).map(([id, state]) => ({
      id,
      title: titles[id] ?? `Chat ${id}`,
      state,
    })),
  }
}

/** A tracker that has seen its baseline report. */
function tracker(chats: Record<string, ChatState> = {}, mode?: NotificationMode) {
  const attention = new ChatAttention()
  attention.report(report(chats, mode), true)
  return attention
}

describe('ChatAttention', () => {
  it('announces nothing for the first report, whatever it holds', () => {
    const attention = new ChatAttention()
    const change = attention.report(report({ a: 'approval', b: 'input', c: 'failed' }), true)
    expect(change.notify).toEqual([])
    expect(change.badge).toBe(0)
  })

  it('notifies when a chat starts waiting on an approval, a question or after a failure', () => {
    const attention = tracker({ a: 'working', b: 'working', c: 'working' })
    const change = attention.report(report({ a: 'approval', b: 'input', c: 'failed' }), true)
    expect(change.notify).toEqual([
      { chatId: 'a', title: 'Chat a', notice: 'approval' },
      { chatId: 'b', title: 'Chat b', notice: 'input' },
      { chatId: 'c', title: 'Chat c', notice: 'failed' },
    ])
    expect(change.badge).toBe(3)
  })

  it('says what happened in a few words', () => {
    expect(NOTICE_TEXT).toEqual({
      approval: 'Needs your approval',
      input: 'Has a question',
      failed: 'Failed',
      finished: 'Finished',
    })
  })

  it('never notifies while the window is in front', () => {
    const attention = tracker({ a: 'working' }, 'needs-you-or-finished')
    expect(attention.report(report({ a: 'approval' }, 'needs-you-or-finished'), false)).toEqual({
      notify: [],
      stale: ['a'],
      badge: 0,
    })
    expect(attention.report(report({}, 'needs-you-or-finished'), false).notify).toEqual([])
  })

  it('does not count a chat the user already saw waiting once the window leaves', () => {
    const attention = tracker({ a: 'working' })
    attention.report(report({ a: 'approval' }), false)
    expect(attention.report(report({ a: 'approval' }), true)).toEqual({
      notify: [],
      stale: [],
      badge: 0,
    })
  })

  it('notifies once per state change, however often the same state is reported', () => {
    const attention = tracker({ a: 'working' })
    expect(attention.report(report({ a: 'approval' }), true).notify).toHaveLength(1)
    expect(attention.report(report({ a: 'approval' }), true).notify).toEqual([])
    expect(attention.report(report({ a: 'approval', b: 'working' }), true).notify).toEqual([])
    expect(attention.badge).toBe(1)
  })

  it('announces finished turns only when the user asked for them', () => {
    const quiet = tracker({ a: 'working' })
    expect(quiet.report(report({}), true)).toEqual({ notify: [], stale: ['a'], badge: 0 })

    const chatty = tracker({ a: 'working' }, 'needs-you-or-finished')
    const change = chatty.report(report({}, 'needs-you-or-finished'), true)
    expect(change.notify).toEqual([{ chatId: 'a', title: 'Chat a', notice: 'finished' }])
    // A finished chat does not wait on the user, so it is not counted.
    expect(change.badge).toBe(0)
  })

  it('names a finished chat by the title it had while it ran', () => {
    const attention = new ChatAttention()
    attention.report(report({ a: 'working' }, 'needs-you-or-finished', { a: 'Fix login' }), true)
    expect(attention.report(report({}, 'needs-you-or-finished'), true).notify).toEqual([
      { chatId: 'a', title: 'Fix login', notice: 'finished' },
    ])
  })

  it('does not call a failed chat that was read or removed finished', () => {
    const attention = tracker({ a: 'working' }, 'needs-you-or-finished')
    attention.report(report({ a: 'failed' }, 'needs-you-or-finished'), true)
    const change = attention.report(report({}, 'needs-you-or-finished'), true)
    expect(change.notify).toEqual([])
    expect(change.stale).toEqual(['a'])
    expect(change.badge).toBe(0)
  })

  it('stays silent when notifications are off, and keeps its place for later', () => {
    const attention = tracker({ a: 'working' }, 'off')
    expect(attention.report(report({ a: 'approval' }, 'off'), true)).toEqual({
      notify: [],
      stale: ['a'],
      badge: 0,
    })
    // Turning them back on does not announce what changed while they were off.
    expect(attention.report(report({ a: 'approval' }), true).notify).toEqual([])
  })

  it('clears the badge when notifications are turned off', () => {
    const attention = tracker({ a: 'working' })
    attention.report(report({ a: 'approval' }), true)
    expect(attention.report(report({ a: 'approval' }, 'off'), true).badge).toBe(0)
  })

  it('clears the badge when the window comes to the front', () => {
    const attention = tracker({ a: 'working', b: 'working' })
    attention.report(report({ a: 'approval', b: 'input' }), true)
    expect(attention.badge).toBe(2)
    attention.seen()
    expect(attention.badge).toBe(0)
    // The two are still waiting but have been seen; a third one counts alone.
    expect(attention.report(report({ a: 'approval', b: 'input', c: 'failed' }), true).badge).toBe(1)
  })

  it('drops a chat from the badge once it stops waiting', () => {
    const attention = tracker({ a: 'working', b: 'working' })
    attention.report(report({ a: 'approval', b: 'approval' }), true)
    expect(attention.report(report({ a: 'working', b: 'approval' }), true).badge).toBe(1)
    expect(attention.report(report({ b: 'approval' }), true).badge).toBe(1)
    expect(attention.report(report({}), true).badge).toBe(0)
  })

  it('notifies again when a chat that was answered waits once more', () => {
    const attention = tracker({ a: 'working' })
    attention.report(report({ a: 'approval' }), true)
    attention.report(report({ a: 'working' }), true)
    expect(attention.report(report({ a: 'approval' }), true).notify).toHaveLength(1)
  })

  it('notifies a new chat that arrives already waiting', () => {
    const attention = tracker({})
    expect(attention.report(report({ a: 'input' }), true).notify).toEqual([
      { chatId: 'a', title: 'Chat a', notice: 'input' },
    ])
  })

  it('treats the first report of a reloaded page as a baseline', () => {
    const attention = tracker({ a: 'working', b: 'working' }, 'needs-you-or-finished')
    attention.report(report({ a: 'approval', b: 'working' }, 'needs-you-or-finished'), true)
    attention.reset()
    const change = attention.report(
      report({ a: 'approval', c: 'input' }, 'needs-you-or-finished'),
      true,
    )
    expect(change.notify).toEqual([])
    expect(change.stale).toEqual(['c', 'b'])
    // What was counted before the reload stays counted while it still waits.
    expect(change.badge).toBe(1)
    expect(attention.report(report({ c: 'input' }, 'needs-you-or-finished'), true).notify).toEqual([
      { chatId: 'a', title: 'Chat a', notice: 'finished' },
    ])
  })

  it('reports which chats changed so their notifications can be replaced', () => {
    const attention = tracker({ a: 'working', b: 'approval' })
    expect(attention.report(report({ a: 'approval', b: 'approval' }), true).stale).toEqual(['a'])
    expect(attention.report(report({ a: 'approval' }), true).stale).toEqual(['b'])
  })

  it('keeps notification titles to one short line', () => {
    const attention = tracker({ a: 'working', b: 'working' })
    const change = attention.report(
      report({ a: 'approval', b: 'input' }, 'needs-you', {
        a: `  Fix\nthe   login ${'x'.repeat(200)}`,
        b: '   ',
      }),
      true,
    )
    const [first, second] = change.notify
    expect(first!.title.startsWith('Fix the login x')).toBe(true)
    expect(first!.title.length).toBe(120)
    expect(first!.title.endsWith('…')).toBe(true)
    expect(second!.title).toBe('New chat')
  })
})

describe('parseChatAttentionReport', () => {
  it('accepts a well-formed report', () => {
    const value = report({ a: 'working', b: 'approval' }, 'needs-you-or-finished')
    expect(parseChatAttentionReport(value)).toEqual(value)
  })

  it.each([
    ['not an object', 'needs-you'],
    ['an unknown mode', { mode: 'always', chats: [] }],
    ['chats that are not a list', { mode: 'off', chats: {} }],
    ['an unknown state', { mode: 'off', chats: [{ id: 'a', title: '', state: 'ready' }] }],
    ['an empty id', { mode: 'off', chats: [{ id: '', title: '', state: 'working' }] }],
    ['a NUL in an id', { mode: 'off', chats: [{ id: 'a\0', title: '', state: 'working' }] }],
    ['a long id', { mode: 'off', chats: [{ id: 'a'.repeat(257), title: '', state: 'working' }] }],
    ['a title that is not text', { mode: 'off', chats: [{ id: 'a', title: 1, state: 'working' }] }],
    [
      'a long title',
      { mode: 'off', chats: [{ id: 'a', title: 'x'.repeat(1_001), state: 'working' }] },
    ],
    [
      'a chat twice',
      {
        mode: 'off',
        chats: [
          { id: 'a', title: '', state: 'working' },
          { id: 'a', title: '', state: 'input' },
        ],
      },
    ],
    [
      'too many chats',
      {
        mode: 'off',
        chats: Array.from({ length: MAX_REPORTED_CHATS + 1 }, (_, index) => ({
          id: `c${index}`,
          title: '',
          state: 'working',
        })),
      },
    ],
  ])('ignores %s', (_name, value) => {
    expect(parseChatAttentionReport(value)).toBeUndefined()
  })

  it('keeps only the fields it knows', () => {
    expect(
      parseChatAttentionReport({
        mode: 'off',
        extra: true,
        chats: [{ id: 'a', title: 't', state: 'input', provider: 'codex' }],
      }),
    ).toEqual({ mode: 'off', chats: [{ id: 'a', title: 't', state: 'input' }] })
  })
})
