import { describe, expect, it, vi } from 'vitest'
import type { Source } from '../state/catalog'
import type { Session } from '../state/projects'

vi.mock('../../modules/tastecode-link', () => ({ TasteLink: {} }))

const { chatsView } = await import('./chats')

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

  it('puts pinned chats first, then waiting, working and the most recent within each', () => {
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
          sessions: [
            session('quiet'),
            session('desktop', { lastActiveAt: 8_000 }),
            session('works', { running: true }),
            session('asks', { status: 'input' }),
            session('pinned-old', { pinned: true }),
            session('pinned-works', { pinned: true, status: 'working' }),
          ],
        },
      ],
    })
    expect(view.chats.map((chat) => chat.id)).toEqual([
      'pinned-works',
      'pinned-old',
      'asks',
      'works',
      'desktop',
      'quiet',
    ])
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

describe('what a chat runs on', () => {
  it('names the agent and the model, as the picker does', () => {
    const sources = [
      {
        provider: 'claude-code',
        key: 'claude-code',
        name: 'Claude Code',
        capabilities: undefined,
        status: 'ready',
        models: [{ id: 'claude-opus-5-5', displayName: 'Opus 5.5', isDefault: true }],
      },
    ] as unknown as Source[]
    const view = chatsView(
      {
        status: 'ready',
        error: undefined,
        activity: {},
        projects: [
          {
            path: '/p',
            name: 'p',
            pinned: false,
            createdAt: 1,
            sessions: [
              session('listed', { provider: 'claude-code', model: 'claude-opus-5-5' }),
              session('own', { provider: 'claude-code', model: 'my-model', accountId: 'work' }),
              session('default', { provider: 'claude-code' }),
              session('unknown', { provider: 'codex' }),
            ],
          },
        ],
      },
      sources,
    )
    const named = Object.fromEntries(
      view.chats.map((chat) => [chat.id, [chat.sourceName, chat.modelName, chat.mark]]),
    )
    expect(named).toEqual({
      listed: ['Claude Code', 'Opus 5.5', 'anthropic'],
      own: ['Claude Code', 'My-Model', 'anthropic'],
      default: ['Claude Code', 'Opus 5.5', 'anthropic'],
      unknown: ['Codex', null, 'openai'],
    })
  })
})
