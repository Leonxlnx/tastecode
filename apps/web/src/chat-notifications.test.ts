// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHAT_NOTIFICATIONS_KEY,
  chatAttentionReport,
  readChatNotificationMode,
  reportedChatState,
  sameChatAttentionReport,
  subscribeChatNotificationMode,
  writeChatNotificationMode,
} from './chat-notifications.js'
import type { Project, Session } from './ui/Sidebar.js'

function session(id: string, status: Session['status'], title = id): Session {
  return {
    id,
    title,
    provider: 'codex',
    createdAt: 0,
    status,
    lifecycle: { state: 'active', keepActive: false },
    unread: false,
  }
}

function project(path: string, sessions: Session[]): Project {
  return { path, sessions }
}

afterEach(() => {
  writeChatNotificationMode('needs-you')
  localStorage.clear()
})

describe('chat notification setting', () => {
  it('tells the user when a chat needs them unless they chose otherwise', () => {
    expect(readChatNotificationMode()).toBe('needs-you')
  })

  it('persists a choice and tells subscribers', () => {
    const onChange = vi.fn()
    const unsubscribe = subscribeChatNotificationMode(onChange)
    writeChatNotificationMode('needs-you-or-finished')
    expect(localStorage.getItem(CHAT_NOTIFICATIONS_KEY)).toBe('needs-you-or-finished')
    expect(readChatNotificationMode()).toBe('needs-you-or-finished')
    expect(onChange).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it('falls back to the default for a value it does not know', () => {
    localStorage.setItem(CHAT_NOTIFICATIONS_KEY, 'always')
    expect(readChatNotificationMode()).toBe('needs-you')
  })

  it('keeps a choice for the session when site data cannot be written', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    writeChatNotificationMode('off')
    expect(readChatNotificationMode()).toBe('off')
    vi.restoreAllMocks()
  })
})

describe('reportedChatState', () => {
  it('reads the status the sidebar draws', () => {
    expect(reportedChatState(session('a', 'approval'))).toBe('approval')
    expect(reportedChatState(session('a', 'input'))).toBe('input')
    expect(reportedChatState(session('a', 'failed'))).toBe('failed')
  })

  it('counts every running status as working', () => {
    for (const status of ['starting', 'working', 'queued'] as const) {
      expect(reportedChatState(session('a', status))).toBe('working')
    }
  })

  it('leaves idle and finished chats at rest', () => {
    expect(reportedChatState(session('a', 'idle'))).toBeUndefined()
    expect(reportedChatState(session('a', 'ready'))).toBeUndefined()
  })
})

describe('chatAttentionReport', () => {
  it('lists the chats that are not at rest, across projects, with their titles', () => {
    const projects = [
      project('/one', [session('a', 'working', 'Fix login'), session('b', 'idle')]),
      project('/two', [session('c', 'approval', 'Migrate'), session('d', 'ready')]),
    ]
    expect(chatAttentionReport(projects, 'needs-you')).toEqual({
      mode: 'needs-you',
      chats: [
        { id: 'a', title: 'Fix login', state: 'working' },
        { id: 'c', title: 'Migrate', state: 'approval' },
      ],
    })
  })

  it('leaves out a chat that still has only its local id', () => {
    const projects = [project('/one', [session('pending:1', 'starting')])]
    expect(chatAttentionReport(projects, 'needs-you').chats).toEqual([])
  })

  it('reports a chat listed twice once', () => {
    const shared = session('a', 'input')
    const projects = [project('/one', [shared]), project('/two', [shared])]
    expect(chatAttentionReport(projects, 'off').chats).toHaveLength(1)
  })

  it('reuses the list of a project nothing changed in', () => {
    const one = project('/one', [session('a', 'working')])
    const first = chatAttentionReport([one, project('/two', [])], 'needs-you')
    const second = chatAttentionReport([one, project('/two', [session('b', 'input')])], 'needs-you')
    expect(second.chats[0]).toBe(first.chats[0])
  })
})

describe('sameChatAttentionReport', () => {
  const report = chatAttentionReport([project('/one', [session('a', 'working')])], 'needs-you')

  it('matches a report that says the same', () => {
    const again = chatAttentionReport([project('/one', [session('a', 'working')])], 'needs-you')
    expect(sameChatAttentionReport(report, again)).toBe(true)
  })

  it('tells apart a new state, title, chat or mode', () => {
    const variants = [
      chatAttentionReport([project('/one', [session('a', 'approval')])], 'needs-you'),
      chatAttentionReport([project('/one', [session('a', 'working', 'Renamed')])], 'needs-you'),
      chatAttentionReport([project('/one', [session('b', 'working')])], 'needs-you'),
      chatAttentionReport([project('/one', [session('a', 'working')])], 'off'),
      chatAttentionReport([], 'needs-you'),
    ]
    for (const variant of variants) expect(sameChatAttentionReport(report, variant)).toBe(false)
    expect(sameChatAttentionReport(undefined, report)).toBe(false)
  })
})
