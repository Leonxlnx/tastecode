// @vitest-environment happy-dom
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterAll, bench, describe, vi } from 'vitest'
import type { Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import {
  emptyThread,
  reduceDeltas,
  type LiveItemUpdate,
  type ThreadState,
} from '../thread-store.js'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () => (count === 0 ? [] : [{ index: 0, key: 0, start: 0, end: 72, size: 72 }]),
    getTotalSize: () => count * 72,
    measurementsCache: [],
    measureElement: () => undefined,
    getOffsetForIndex: () => [0],
    scrollToIndex: () => undefined,
  }),
}))

import { Thread } from './Thread.js'

const noop = () => undefined
const ITEM_COUNT = 10_000
const items = Array.from({ length: ITEM_COUNT }, (_, index): Item => ({
  id: `activity-${index}`,
  turnId: 'active-turn',
  type: 'tool_call',
  status: 'started',
  text: `tool-${index}`,
  createdAt: index,
}))
const liveItems = new Map<number, LiveItemUpdate>(
  items.map((item, index) => [
    index,
    {
      item: { ...item, text: `live-tool-${index}` },
      version: 1,
      textUpdate: { kind: 'append', text: 'live-' },
    },
  ]),
)
let current: ThreadState = {
  ...emptyThread,
  items,
  liveItems,
  itemVersion: 1,
  running: true,
  activeTurn: { id: 'active-turn', startedAt: 0 },
}
const store = new ThreadFrameStore(current)
const container = document.createElement('div')
document.body.append(container)
const root = createRoot(container)
flushSync(() => {
  root.render(
    <Thread
      frameStore={store}
      threadId="activity-thread"
      items={items}
      liveItems={liveItems}
      itemVersion={1}
      liveStart={0}
      running
      activeTurn={current.activeTurn}
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

function publishActivityFrame(): void {
  current = reduceDeltas(current, [
    {
      type: 'item.delta',
      turnId: 'active-turn',
      itemId: `activity-${ITEM_COUNT - 1}`,
      textDelta: 'x',
    },
  ])
  flushSync(() => store.publish(current))
  if (!container.querySelector('.activity__label')?.textContent) {
    throw new Error('activity summary did not render')
  }
}

publishActivityFrame()

afterAll(() => {
  flushSync(() => root.unmount())
  container.remove()
})

describe('large collapsed activity React frame', () => {
  bench('renders one changed row in a 10,000-item activity group', publishActivityFrame, {
    time: 1_200,
    warmupTime: 300,
  })
})
