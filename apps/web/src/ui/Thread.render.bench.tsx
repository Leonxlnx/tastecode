// @vitest-environment happy-dom
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterAll, bench, describe } from 'vitest'
import type { Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread } from '../thread-store.js'
import { Thread } from './Thread.js'
import { makeFixtureThread } from './fixture.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const noop = () => undefined

function identify(items: Item[], prefix: string): Item[] {
  return items.map((item) => ({
    ...item,
    id: `${prefix}:${item.id}`,
    turnId: `${prefix}:${item.turnId}`,
  }))
}

function createThreadHarness(initialThreadId: string, initialItems: Item[]) {
  const store = new ThreadFrameStore({ ...emptyThread, items: initialItems })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = (threadId: string, items: Item[]) => {
    flushSync(() => {
      store.publish({ ...emptyThread, items })
      root.render(
        <Thread threadId={threadId} frameStore={store} onDecide={noop} onAnswerUserInput={noop} />,
      )
    })
  }
  render(initialThreadId, initialItems)
  return {
    render,
    dispose: () => {
      flushSync(() => root.unmount())
      container.remove()
    },
  }
}

const shortA = identify(makeFixtureThread(20, 1), 'short-a')
const shortB = identify(makeFixtureThread(20, 2), 'short-b')
const longA = identify(makeFixtureThread(10_000, 3), 'long-a')
const longB = identify(makeFixtureThread(10_000, 4), 'long-b')
const shortHarness = createThreadHarness('short-a', shortA)
const longHarness = createThreadHarness('long-a', longA)
let shortFrame = false
let longFrame = false

afterAll(() => {
  shortHarness.dispose()
  longHarness.dispose()
})

describe('session switch rendering', () => {
  bench(
    'switches between short threads',
    () => {
      shortFrame = !shortFrame
      shortHarness.render(shortFrame ? 'short-a' : 'short-b', shortFrame ? shortA : shortB)
    },
    OPTIONS,
  )

  bench(
    'switches between 10,000-item threads',
    () => {
      longFrame = !longFrame
      longHarness.render(longFrame ? 'long-a' : 'long-b', longFrame ? longA : longB)
    },
    OPTIONS,
  )
})
