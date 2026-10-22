import { describe, expect, it } from 'vitest'
import type { Session } from '../state/projects'
import { chatsView } from './chats'

const session = (id: string, patch: Partial<Session> = {}): Session => ({
  id,
  title: id,
  provider: 'codex',
  createdAt: 1_000,
  running: false,
  ...patch,
})

describe('chat list', () => {
  it('puts chats waiting for you first, then the most recent', () => {
    const view = chatsView({
      status: 'ready',
      error: undefined,
      activity: { recent: 9_000 },
      projects: [
        {
          path: '/p',
          name: 'p',
          pinned: false,
          createdAt: 1,
          sessions: [
            session('old'),
            session('recent'),
            session('asks', { status: 'approval' }),
            session('snoozed', { lifecycle: { state: 'snoozed', snoozedAt: 1, wakeAt: 99 } }),
            session('done', {
              createdAt: 5_000,
              lifecycle: { state: 'settled', settledAt: 6_000, reason: 'manual' },
            }),
          ],
        },
      ],
    })
    expect(view.chats.map((chat) => [chat.id, chat.state, chat.archived])).toEqual([
      ['asks', 'approval', false],
      ['recent', 'idle', false],
      ['done', 'idle', true],
      ['old', 'idle', false],
    ])
    expect(view.projects).toEqual([{ path: '/p', name: 'p', pinned: false, chats: 4 }])
  })

  it('reads a running chat without an inbox status as working', () => {
    const view = chatsView({
      status: 'ready',
      error: undefined,
      activity: {},
      projects: [
        {
          path: '/p',
          name: 'p',
          pinned: false,
          createdAt: 1,
          sessions: [session('x', { running: true, title: ' ' })],
        },
      ],
    })
    expect(view.chats[0]).toMatchObject({ state: 'working', title: 'New chat' })
  })
})
