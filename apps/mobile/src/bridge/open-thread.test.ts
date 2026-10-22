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
    connection: { request: vi.fn(async () => ({ threadId: 't', version: '1', files: [] })) },
  }
})

const { OpenThread } = await import('./open-thread')

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
})
