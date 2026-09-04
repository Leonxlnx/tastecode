// @vitest-environment happy-dom
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterAll, bench, describe, vi } from 'vitest'
import type { Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread, type LiveItemUpdate, type ThreadState } from '../thread-store.js'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      count === 0
        ? []
        : [
            {
              index: count - 1,
              key: count - 1,
              start: (count - 1) * 72,
              end: count * 72,
              size: 72,
            },
          ],
    getTotalSize: () => count * 72,
    measurementsCache: [],
    measureElement: () => undefined,
    getOffsetForIndex: () => [0],
    scrollToIndex: () => undefined,
  }),
}))

import { Thread } from './Thread.js'
import { makeFixtureThread } from './fixture.js'

const OPTIONS = { time: 0, iterations: 1_000, warmupTime: 0, warmupIterations: 100 }
const noop = () => undefined

function createLiveThreadHarness(historyCount: number) {
  const history = makeFixtureThread(historyCount)
  const live: Item = {
    id: `live-${historyCount}`,
    turnId: `active-${historyCount}`,
    type: 'message',
    role: 'assistant',
    status: 'started',
    text: '',
    createdAt: historyCount,
  }
  const items = [...history, live]
  const base: ThreadState = {
    ...emptyThread,
    items,
    running: true,
    activeTurn: { id: live.turnId, startedAt: historyCount },
    liveStart: history.length,
  }
  const store = new ThreadFrameStore(base)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(
      <Thread
        frameStore={store}
        threadId={`thread-${historyCount}`}
        items={items}
        liveItems={base.liveItems}
        itemVersion={0}
        liveStart={history.length}
        running
        activeTurn={base.activeTurn}
        plan={[]}
        diff={undefined}
        approvals={[]}
        userInputs={[]}
        reviews={[]}
        onDecide={noop}
        onAnswerUserInput={noop}
      />,
    )
  })

  let version = 0
  const publish = () => {
    version += 1
    const text = 'x'.repeat(version)
    const update: LiveItemUpdate = {
      item: { ...live, text },
      version,
      textUpdate: { kind: 'append', text: 'x' },
    }
    const frame: ThreadState = {
      ...base,
      liveItems: new Map([[history.length, update]]),
      itemVersion: version,
    }
    flushSync(() => store.publish(frame))
  }
  publish()
  if (container.querySelector('[data-streaming-markdown]')?.textContent !== 'x') {
    throw new Error('live row did not render')
  }

  return {
    publish,
    dispose: () => {
      flushSync(() => root.unmount())
      container.remove()
    },
  }
}

function createLegacyLiveThreadHarness(historyCount: number) {
  const history = makeFixtureThread(historyCount)
  const live: Item = {
    id: `legacy-live-${historyCount}`,
    turnId: `legacy-active-${historyCount}`,
    type: 'message',
    role: 'assistant',
    status: 'started',
    text: '',
    createdAt: historyCount,
  }
  const items = [...history, live]
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let version = 0

  const publish = () => {
    version += 1
    const update: LiveItemUpdate = {
      item: { ...live, text: 'x'.repeat(version) },
      version,
      textUpdate: { kind: 'append', text: 'x' },
    }
    flushSync(() => {
      root.render(
        <Thread
          threadId={`legacy-thread-${historyCount}`}
          items={items}
          liveItems={new Map([[history.length, update]])}
          itemVersion={version}
          liveStart={history.length}
          running
          activeTurn={{ id: live.turnId, startedAt: historyCount }}
          plan={[]}
          diff={undefined}
          approvals={[]}
          userInputs={[]}
          reviews={[]}
          onDecide={noop}
          onAnswerUserInput={noop}
        />,
      )
    })
  }
  publish()
  if (container.querySelector('[data-streaming-markdown]')?.textContent !== 'x') {
    throw new Error('legacy live row did not render')
  }

  return {
    publish,
    dispose: () => {
      flushSync(() => root.unmount())
      container.remove()
    },
  }
}

const shortHarness = createLiveThreadHarness(0)
const longHarness = createLiveThreadHarness(10_000)
const legacyShortHarness = createLegacyLiveThreadHarness(0)
const legacyLongHarness = createLegacyLiveThreadHarness(10_000)

afterAll(() => {
  shortHarness.dispose()
  longHarness.dispose()
  legacyShortHarness.dispose()
  legacyLongHarness.dispose()
})

describe('active transcript React frame', () => {
  bench('rerenders the transcript owner in a one-item thread', legacyShortHarness.publish, OPTIONS)
  bench(
    'rerenders the transcript owner in a 10,001-item thread',
    legacyLongHarness.publish,
    OPTIONS,
  )
  bench('renders one live row in a one-item thread', shortHarness.publish, OPTIONS)
  bench('renders one live row in a 10,001-item thread', longHarness.publish, OPTIONS)
})
