import { describe, expect, it, vi } from 'vitest'
import type { DomainEvent, Item } from '@harness/contracts'
import { Store } from '../store'
import { ThreadModel } from '../state/thread-model'
import type { ThreadScreenState } from '../state/thread-session'
import type { ThreadPatch } from '../view/types'

vi.mock('../../modules/tastecode-link', () => ({
  TasteLink: { readPreference: () => null, writePreference: () => undefined },
}))

const model = new ThreadModel()
const screen = new Store<ThreadScreenState>({
  status: 'ready',
  error: undefined,
  view: model.view(),
  approval: 'ask',
  olderCursor: undefined,
  loadingOlder: false,
  queue: [],
  unconfirmed: new Set(),
  canSteer: false,
})
const session = { state: screen }

vi.mock('../state/app', async () => {
  const { Store: AppStore } = await import('../store')
  return {
    sessions: { acquire: () => session, release: vi.fn() },
    projects: {
      state: new AppStore({ status: 'ready', error: undefined, activity: {}, projects: [] }),
    },
    catalog: { state: new AppStore({ status: 'ready', sources: [] }), ensure: vi.fn() },
    connection: {
      request: vi.fn(async (method: string, params: Record<string, unknown>) =>
        link.answer(method, params),
      ),
      on: (channel: string, listener: (data: unknown) => void) => {
        link.listeners.set(channel, listener)
        return () => link.listeners.delete(channel)
      },
      onOpen: () => () => undefined,
    },
  }
})

const link = vi.hoisted(() => ({
  listeners: new Map<string, (data: unknown) => void>(),
  answer: async (method: string, _params: Record<string, unknown>): Promise<unknown> =>
    method === 'thread.settings' ? {} : { threadId: 't', version: '1', files: [] },
}))

const { OpenThread } = await import('./open-thread')
const app = await import('../state/app')

function apply(event: DomainEvent): void {
  model.apply(event)
  screen.set((current) => ({ ...current, view: model.view() }))
}

const item = (patch: Partial<Item> & Pick<Item, 'id'>): Item => ({
  turnId: 't1',
  type: 'message',
  role: 'assistant',
  status: 'started',
  createdAt: 1,
  ...patch,
})

describe('an open chat on the screens', () => {
  it('sends a streaming reply alone, without the rows around it or their order', () => {
    const patches: ThreadPatch[] = []
    const thread = new OpenThread('t', (patch) => patches.push(patch))
    apply({
      type: 'turn.started',
      turn: { id: 't1', threadId: 't', status: 'running', createdAt: 1 },
    })
    apply({
      type: 'item.completed',
      item: item({ id: 'u', role: 'user', status: 'completed', text: 'Hi' }),
    })
    apply({ type: 'item.started', item: item({ id: 'a' }) })
    const before = patches.length
    apply({ type: 'item.delta', turnId: 't1', itemId: 'a', textDelta: 'Hel' })
    apply({ type: 'item.delta', turnId: 't1', itemId: 'a', textDelta: 'lo' })
    const streamed = patches.slice(before)
    expect(streamed).toHaveLength(2)
    for (const patch of streamed) {
      expect(patch.order).toBeNull()
      expect(patch.rows.map((row) => row.key)).toEqual(['a'])
    }
    expect(streamed.at(-1)?.rows[0]).toMatchObject({
      kind: 'assistant',
      text: 'Hello',
      streaming: true,
    })
    expect(patches[0]).toMatchObject({ reset: true, order: [] })
    thread.close()
  })

  it('tells the screens which rows are gone when a read replaces the transcript', () => {
    const patches: ThreadPatch[] = []
    const thread = new OpenThread('t', (patch) => patches.push(patch))
    const fresh = new ThreadModel()
    screen.set((current) => ({ ...current, view: fresh.view() }))
    expect(patches.at(-1)).toMatchObject({ rows: [], order: [] })
    thread.close()
  })

  it('shows the setup the computer keeps and follows a change from another client', async () => {
    const reasoning = (id: string) => ({
      id,
      displayName: id,
      reasoningEfforts: ['low', 'high'],
      serviceTiers: [{ id: 'fast', name: 'Fast', description: '' }],
    })
    app.projects.state.set({
      status: 'ready',
      error: undefined,
      activity: {},
      projects: [
        {
          path: '/p',
          name: 'p',
          pinned: false,
          createdAt: 1,
          sessions: [{ id: 't', title: 'T', provider: 'codex', createdAt: 1, running: false }],
        },
      ],
    })
    app.catalog.state.set({
      status: 'ready',
      sources: [
        {
          provider: 'codex',
          key: 'codex',
          name: 'Codex',
          capabilities: undefined,
          status: 'ready',
          models: [reasoning('a'), reasoning('b')],
        },
      ],
    } as never)
    const written: Array<Record<string, unknown>> = []
    link.answer = async (method, params) => {
      if (method === 'thread.settings') return { model: 'b', effort: 'low', approval: 'auto' }
      if (method === 'thread.setSettings') {
        written.push(params)
        const { threadId: _threadId, ...setup } = params
        return { ...setup, approval: 'auto' }
      }
      return { threadId: 't', version: '1', files: [] }
    }
    const patches: ThreadPatch[] = []
    const thread = new OpenThread('t', (patch) => patches.push(patch))
    await vi.waitFor(() =>
      expect(patches.at(-1)?.meta.setup).toMatchObject({
        model: 'b',
        effort: 'low',
        access: 'auto',
      }),
    )

    // The desktop picks Fast and full access; the phone shows it without asking.
    link.listeners.get('thread.settings')?.({
      threadId: 't',
      settings: { model: 'b', effort: 'low', serviceTier: 'fast', approval: 'full' },
    })
    expect(patches.at(-1)?.meta.setup).toMatchObject({
      tier: 'fast',
      tierName: 'Fast',
      access: 'full',
    })

    // A model the source does not list, as a desktop's own custom model, stays the chat's model.
    link.listeners.get('thread.settings')?.({
      threadId: 't',
      settings: { model: 'my-custom', effort: 'low', approval: 'full' },
    })
    expect(patches.at(-1)?.meta.setup).toMatchObject({
      model: 'my-custom',
      modelName: 'My-Custom',
      effort: 'low',
    })
    link.listeners.get('thread.settings')?.({
      threadId: 't',
      settings: { model: 'b', effort: 'low', serviceTier: 'fast', approval: 'full' },
    })

    // The phone changes the effort; the whole setup goes to the computer.
    await thread.setEffort('high')
    expect(written.at(-1)).toEqual({
      threadId: 't',
      model: 'b',
      effort: 'high',
      serviceTier: 'fast',
    })
    thread.close()
  })
})
