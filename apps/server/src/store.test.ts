import { beforeEach, describe, expect, it } from 'vitest'
import type { DomainEvent } from '@harness/contracts'
import { Store } from './store.js'

let store: Store

beforeEach(() => {
  store = new Store(':memory:')
})

const message = (text: string): DomainEvent => ({
  type: 'item.completed',
  item: {
    id: `i-${text}`,
    turnId: 't1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    text,
    createdAt: 0,
  },
})

describe('projects', () => {
  it('names a project after its folder when no name is given', () => {
    const project = store.addProject('/home/me/work/harness')
    expect(project.name).toBe('harness')
  })

  it('does not overwrite a name when the same project is added again', () => {
    store.addProject('/repo')
    store.renameProject('/repo', 'My thing')
    store.addProject('/repo')

    // Adding a folder twice is a normal thing to do, and it must not silently
    // undo the name the user chose.
    expect(store.project('/repo')?.name).toBe('My thing')
  })

  it('removes a project together with its threads and their events', () => {
    store.addProject('/repo')
    store.addThread({ id: 't1', projectPath: '/repo', provider: 'codex', title: 'One' })
    store.append('t1', message('hello'))

    store.removeProject('/repo')

    expect(store.project('/repo')).toBeUndefined()
    expect(store.thread('t1')).toBeUndefined()
    expect(store.history('t1')).toEqual([])
  })
})

describe('threads', () => {
  beforeEach(() => {
    store.addProject('/repo')
  })

  it('keeps the ACP agent, because the provider alone cannot start the session', () => {
    store.addThread({
      id: 't1',
      projectPath: '/repo',
      provider: 'acp',
      agent: 'gemini',
      title: 'One',
    })
    expect(store.thread('t1')?.agent).toBe('gemini')
  })

  it('leaves the agent unset for providers that are a single engine', () => {
    store.addThread({ id: 't1', projectPath: '/repo', provider: 'codex', title: 'One' })
    expect(store.thread('t1')?.agent).toBeUndefined()
  })

  it('lists newest first', () => {
    store.addThread({
      id: 'old',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Old',
      createdAt: 1000,
    })
    store.addThread({
      id: 'new',
      projectPath: '/repo',
      provider: 'codex',
      title: 'New',
      createdAt: 2000,
    })

    expect(store.threads('/repo').map((t) => t.id)).toEqual(['new', 'old'])
  })

  it('keeps a closed session rather than discarding it', () => {
    store.addThread({ id: 't1', projectPath: '/repo', provider: 'codex', title: 'One' })
    store.append('t1', message('hello'))

    store.closeThread('t1')

    // Ending the process is not the same as wanting the transcript gone.
    expect(store.thread('t1')?.closedAt).toBeGreaterThan(0)
    expect(store.history('t1')).toHaveLength(1)
  })

  it('separates threads by project', () => {
    store.addProject('/other')
    store.addThread({ id: 'a', projectPath: '/repo', provider: 'codex', title: 'A' })
    store.addThread({ id: 'b', projectPath: '/other', provider: 'codex', title: 'B' })

    expect(store.threads('/repo').map((t) => t.id)).toEqual(['a'])
    expect(
      store
        .threads()
        .map((t) => t.id)
        .sort(),
    ).toEqual(['a', 'b'])
  })
})

describe('events', () => {
  beforeEach(() => {
    store.addProject('/repo')
    store.addThread({ id: 't1', projectPath: '/repo', provider: 'codex', title: 'One' })
  })

  it('replays a thread in the order it happened', () => {
    store.append('t1', message('one'))
    store.append('t1', message('two'))
    store.append('t1', message('three'))

    const texts = store.history('t1').map((entry) => {
      const event = entry.event
      return event.type === 'item.completed' ? event.item.text : undefined
    })
    expect(texts).toEqual(['one', 'two', 'three'])
  })

  it('returns only what happened after a sequence number', () => {
    store.append('t1', message('one'))
    const seq = store.append('t1', message('two'))
    store.append('t1', message('three'))

    // A client that fell behind asks for the tail; the same call serves both.
    const tail = store.history('t1', seq)
    expect(tail).toHaveLength(1)
    const event = tail[0]?.event
    expect(event?.type === 'item.completed' ? event.item.text : undefined).toBe('three')
  })

  it('never hands one thread another thread events', () => {
    store.addThread({ id: 't2', projectPath: '/repo', provider: 'codex', title: 'Two' })
    store.append('t1', message('mine'))
    store.append('t2', message('theirs'))

    expect(store.history('t1')).toHaveLength(1)
    expect(store.history('t2')).toHaveLength(1)
  })

  it('reports zero for a thread that has produced nothing', () => {
    expect(store.lastSeq('t1')).toBe(0)
  })

  it('survives an event carrying text that would break naive escaping', () => {
    const nasty = 'quote " backslash \\ newline \n null-ish \\u0000 emoji 🙂'
    store.append('t1', message(nasty))

    const event = store.history('t1')[0]?.event
    expect(event?.type === 'item.completed' ? event.item.text : undefined).toBe(nasty)
  })
})
