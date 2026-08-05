// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { DomainEvent, Item } from '@harness/contracts'
import { Thread, workLabel } from './Thread.js'
import { makeFixtureThread } from './fixture.js'
import { emptyThread, reduce } from '../thread-store.js'

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
})
