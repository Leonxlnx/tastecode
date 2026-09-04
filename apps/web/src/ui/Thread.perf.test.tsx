// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { DomainEvent, Item } from '@harness/contracts'
import { Thread, workLabel } from './Thread.js'
import { makeFixtureThread } from './fixture.js'
import {
  activeTurnActivityIndices,
  activeTurnIsSearching,
  emptyThread,
  reduce,
} from '../thread-store.js'

/**
 * Performance budgets, enforced rather than aspired to.
 *
 * These catch the one regression that matters and is invisible in review:
 * rendering the whole thread instead of the visible slice. That mistake looks
 * fine at twenty messages and dies at five hundred — exactly the point where
 * nobody is testing.
 *
 * Deliberately not asserting on rendered row counts. happy-dom gives every
 * element zero size and has no ResizeObserver, so the virtualiser measures
 * nothing and renders nothing; propping that up takes enough mocks that the
 * test would be measuring the mocks. Cost is the honest signal instead.
 *
 * The fixture is generated locally — no provider, no network, no tokens.
 */

const view = (items: ReturnType<typeof makeFixtureThread>) => (
  <Thread
    items={items}
    running={false}
    activeTurn={undefined}
    plan={[]}
    diff={undefined}
    approvals={[]}
    userInputs={[]}
    reviews={[]}
    onDecide={() => {}}
    onAnswerUserInput={() => {}}
  />
)

function timeMount(count: number): number {
  const items = makeFixtureThread(count)
  const started = performance.now()
  render(view(items))
  const elapsed = performance.now() - started
  cleanup()
  return elapsed
}

describe('thread at scale', () => {
  it('shows working and searching states in the activity rail', () => {
    const props = {
      items: [],
      running: true,
      activeTurn: { id: 'turn-1', startedAt: 0 },
      plan: [],
      diff: undefined,
      approvals: [],
      userInputs: [],
      reviews: [],
      onDecide: () => {},
      onAnswerUserInput: () => {},
    }
    const rendered = render(<Thread {...props} searching={false} />)
    expect(
      document.querySelector('.activity__working-orb canvas')?.getAttribute('aria-label'),
    ).toBe('Working…')

    rendered.rerender(<Thread {...props} searching />)
    expect(
      document.querySelector('.activity__working-orb canvas')?.getAttribute('aria-label'),
    ).toBe('Searching…')
  })

  it('hands the placeholder rail to the first visible response without duplication', () => {
    cleanup() // earlier renders would satisfy the queries below with stale DOM
    const props = {
      running: true,
      activeTurn: { id: 'turn-1', startedAt: 0 },
      plan: [],
      diff: undefined,
      approvals: [],
      userInputs: [],
      reviews: [],
      onDecide: () => {},
      onAnswerUserInput: () => {},
    }
    const asked: Item = {
      id: 'u1',
      turnId: 'turn-1',
      type: 'message',
      role: 'user',
      status: 'completed',
      text: 'hi',
      createdAt: 1,
    }
    const rendered = render(<Thread {...props} items={[asked]} />)
    const orb = rendered.container.querySelector('.activity__working-orb canvas')
    expect(orb).not.toBeNull()

    const reply: Item = {
      id: 'a1',
      turnId: 'turn-1',
      type: 'message',
      role: 'assistant',
      status: 'started',
      text: 'Hello',
      createdAt: 2,
    }
    rendered.rerender(<Thread {...props} items={[asked, reply]} />)
    expect(rendered.container.querySelectorAll('.activity--working')).toHaveLength(0)
    expect(rendered.container.querySelector('.activity__working-orb canvas')).toBeNull()
    cleanup()
  })

  it('names the latest active work without depending on a provider', () => {
    const items: Item[] = [
      {
        id: 'plan-1',
        turnId: 'turn-1',
        type: 'plan',
        status: 'started',
        createdAt: 1,
      },
    ]
    expect(workLabel(items, 'turn-1', false)).toBe('Updating the plan')
    expect(
      workLabel(
        [
          {
            id: 'reasoning-empty',
            turnId: 'turn-1',
            type: 'reasoning',
            text: '',
            status: 'started',
            createdAt: 2,
          },
        ],
        'turn-1',
        false,
      ),
    ).toBe('Working')
    expect(
      workLabel(
        [
          {
            id: 'reasoning-live',
            turnId: 'turn-1',
            type: 'reasoning',
            text: 'A long chain of thought that must not become the status line',
            status: 'started',
            createdAt: 2,
          },
        ],
        'turn-1',
        false,
      ),
    ).toBe('Thinking')
    expect(
      workLabel(
        [
          ...items,
          {
            id: 'search-1',
            turnId: 'turn-1',
            type: 'tool_call',
            text: 'search components',
            status: 'started',
            createdAt: 2,
          },
        ],
        'turn-1',
        false,
      ),
    ).toBe('Searching')
    expect(
      workLabel(
        [
          {
            id: 'design-brand',
            turnId: 'turn-1',
            type: 'tool_call',
            text: 'design:brand',
            status: 'started',
            createdAt: 3,
          },
        ],
        'turn-1',
        false,
      ),
    ).toBe('Creating brand direction')
  })

  it('names current and saved Codex activities instead of showing unknown', () => {
    const item = (type: Item['type'], text: string): Item => ({
      id: `${type}-${text}`,
      turnId: 'turn-1',
      type,
      text,
      status: 'started',
      createdAt: 1,
    })

    expect(workLabel([item('tool_call', 'context compaction')], 'turn-1', false)).toBe(
      'Compacting context window…',
    )
    expect(workLabel([item('unknown', '[contextCompaction]')], 'turn-1', false)).toBe(
      'Compacting context window…',
    )
    expect(workLabel([item('unknown', '[futureCapability]')], 'turn-1', false)).toBe(
      'Future capability',
    )
    expect(workLabel([item('unknown', '[unknown]')], 'turn-1', false)).toBe('Agent activity')
  })

  it('uses the active activity index for a long completed tool tail', () => {
    const items: Item[] = [
      ...Array.from({ length: 10_000 }, (_, index) => ({
        id: `tool-${index}`,
        turnId: 'turn-1',
        type: 'tool_call' as const,
        status: 'completed' as const,
        text: 'read file',
        createdAt: index,
      })),
      {
        id: 'answer',
        turnId: 'turn-1',
        type: 'message',
        role: 'assistant',
        status: 'started',
        text: 'Answering',
        createdAt: 10_000,
      },
    ]
    const indices = activeTurnActivityIndices(items, 'turn-1')

    expect(indices).toEqual([])
    expect(workLabel(items, 'turn-1', false, undefined, 0, indices)).toBe('Working')
    expect(activeTurnIsSearching(items, 'turn-1', undefined, 0, indices)).toBe(false)
  })

  it('costs about the same at a thousand items as at a hundred', () => {
    // The property virtualisation buys us. Rendering every row makes this ratio
    // track the item count instead — a tenfold difference, not a small one.
    timeMount(100) // warm up: first mount pays for module init and JIT
    const small = timeMount(100)
    const large = timeMount(1000)

    // Generous on purpose. CI machines vary, and a flaky budget gets deleted
    // rather than fixed. The failure being guarded is an order of magnitude.
    expect(large).toBeLessThan(Math.max(small * 4, 400))
  })

  it('mounts a thousand-item thread well inside the budget', () => {
    expect(timeMount(1000)).toBeLessThan(1500)
  })

  it('folds a thousand streaming events without quadratic cost', () => {
    // The reducer runs on every delta of every turn, so it is the hottest path
    // in the app and the easiest place to accidentally copy the whole list.
    const events: DomainEvent[] = []
    for (let i = 0; i < 1000; i++) {
      events.push({
        type: 'item.started',
        item: {
          id: `i${i}`,
          turnId: `t${Math.floor(i / 5)}`,
          type: 'message',
          role: 'assistant',
          status: 'started',
          text: '',
          createdAt: 0,
        },
      })
      events.push({ type: 'item.delta', turnId: `t${i}`, itemId: `i${i}`, textDelta: 'chunk ' })
    }

    const started = performance.now()
    const state = events.reduce(reduce, emptyThread)
    const elapsed = performance.now() - started

    expect(state.items).toHaveLength(1000)
    expect(elapsed).toBeLessThan(1000)
  })

  it('finds active search work without walking old transcript items', () => {
    const history = makeFixtureThread(1_000)
    const activeSearch: Item = {
      id: 'active-search',
      turnId: 'active-turn',
      type: 'tool_call',
      status: 'started',
      text: 'search files',
      createdAt: Date.now(),
    }
    const turnlessSteer: Item = {
      id: 'local:steer',
      turnId: '',
      type: 'message',
      role: 'user',
      status: 'completed',
      text: 'Keep going',
      createdAt: Date.now(),
    }
    const activeTail: Item = {
      id: 'active-tail',
      turnId: activeSearch.turnId,
      type: 'reasoning',
      status: 'started',
      text: 'Inspecting results',
      createdAt: Date.now(),
    }
    let itemReads = 0
    const items = new Proxy([...history, activeSearch, turnlessSteer, activeTail], {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) itemReads += 1
        return Reflect.get(target, property, receiver)
      },
    })

    expect(activeTurnIsSearching(items, activeSearch.turnId)).toBe(true)
    // Complexity budget: even a turnless steer between active items must not
    // put the old history on the per-frame path. A forward scan reads 1,003.
    expect(itemReads).toBeLessThan(10)
  })

  it('stops before history while the active turn has no canonical items', () => {
    const history = makeFixtureThread(1_000)
    const turnlessSteer: Item = {
      id: 'local:steer',
      turnId: '',
      type: 'message',
      role: 'user',
      status: 'completed',
      text: 'Keep going',
      createdAt: Date.now(),
    }
    let itemReads = 0
    const items = new Proxy([...history, turnlessSteer], {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) itemReads += 1
        return Reflect.get(target, property, receiver)
      },
    })

    expect(activeTurnIsSearching(items, 'active-turn')).toBe(false)
    // During the optimistic/canonical startup gap there is no active item to
    // find. The previous turn must still bound this per-render lookup.
    expect(itemReads).toBeLessThan(10)
  })
})
