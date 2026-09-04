// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import type { Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread, reduceDeltas } from '../thread-store.js'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 72,
        end: (index + 1) * 72,
        size: 72,
      })),
    getTotalSize: () => count * 72,
    measurementsCache: [],
    measureElement: () => undefined,
    getOffsetForIndex: () => [0],
    scrollToIndex: () => undefined,
  }),
}))

import { Thread } from './Thread.js'
import { ThreadSearch } from './ThreadSearch.js'

afterEach(cleanup)

describe('Thread live frame isolation', () => {
  it('finds text that arrives after thread search opens', () => {
    const item: Item = {
      id: 'answer-1',
      turnId: 'turn-1',
      type: 'message',
      role: 'assistant',
      status: 'started',
      text: '',
      createdAt: 1,
    }
    const initial = {
      ...emptyThread,
      items: [item],
      running: true,
      activeTurn: { id: 'turn-1', startedAt: 1 },
    }
    const store = new ThreadFrameStore(initial)
    const view = render(
      <ThreadSearch
        frameStore={store}
        items={initial.items}
        liveItems={initial.liveItems}
        onJump={() => undefined}
        onClose={() => undefined}
      />,
    )

    fireEvent.change(view.getByRole('textbox', { name: 'Find in thread' }), {
      target: { value: 'needle' },
    })
    expect(view.getByText('None')).toBeTruthy()

    act(() => {
      store.publish(
        reduceDeltas(initial, [
          {
            type: 'item.delta',
            turnId: 'turn-1',
            itemId: 'answer-1',
            textDelta: 'needle',
          },
        ]),
      )
    })

    expect(view.getByText('1/1')).toBeTruthy()
  })

  it('updates the streamed row without rerendering the thread owner', () => {
    const item: Item = {
      id: 'answer-1',
      turnId: 'turn-1',
      type: 'message',
      role: 'assistant',
      status: 'started',
      text: '',
      createdAt: 1,
    }
    const initial = {
      ...emptyThread,
      items: [item],
      running: true,
      activeTurn: { id: 'turn-1', startedAt: 1 },
    }
    const store = new ThreadFrameStore(initial)
    let ownerRenders = 0

    function Owner() {
      ownerRenders += 1
      const thread = useSyncExternalStore(
        store.subscribeStructure,
        store.getStructureSnapshot,
        store.getStructureSnapshot,
      )
      return (
        <Thread
          frameStore={store}
          items={thread.items}
          liveItems={thread.liveItems}
          itemVersion={thread.itemVersion}
          liveStart={thread.liveStart}
          running={thread.running}
          activeTurn={thread.activeTurn}
          turnTiming={thread.turnTiming}
          plan={thread.plan}
          diff={thread.diff}
          approvals={thread.approvals}
          userInputs={thread.userInputs}
          reviews={[]}
          onDecide={() => undefined}
          onAnswerUserInput={() => undefined}
        />
      )
    }

    const view = render(<Owner />)
    const live = reduceDeltas(initial, [
      {
        type: 'item.delta',
        turnId: 'turn-1',
        itemId: 'answer-1',
        textDelta: 'Hello',
      },
    ])
    act(() => store.publish(live))

    expect(view.container.querySelector('[data-streaming-markdown]')?.textContent).toBe('Hello')
    expect(ownerRenders).toBe(1)
  })

  it('keeps follow-end scrolling on the live frame subscriber', () => {
    const item: Item = {
      id: 'answer-1',
      turnId: 'turn-1',
      type: 'message',
      role: 'assistant',
      status: 'started',
      text: '',
      createdAt: 1,
    }
    const initial = {
      ...emptyThread,
      items: [item],
      running: true,
      activeTurn: { id: 'turn-1', startedAt: 1 },
    }
    const store = new ThreadFrameStore(initial)
    const view = render(
      <Thread
        frameStore={store}
        items={initial.items}
        liveItems={initial.liveItems}
        itemVersion={0}
        liveStart={0}
        running
        activeTurn={initial.activeTurn}
        plan={[]}
        diff={undefined}
        approvals={[]}
        userInputs={[]}
        reviews={[]}
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )
    const scroller = view.container.querySelector<HTMLElement>('.thread')!
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
    })

    const live = reduceDeltas(initial, [
      {
        type: 'item.delta',
        turnId: 'turn-1',
        itemId: 'answer-1',
        textDelta: 'Hello',
      },
    ])
    act(() => store.publish(live))

    expect(scroller.scrollTop).toBe(800)
  })

  it('uses one frame version for a range without reacting to outside rows', () => {
    const items: Item[] = Array.from({ length: 4 }, (_, index) => ({
      id: `item-${index}`,
      turnId: 'turn-1',
      type: 'tool_call',
      status: 'started',
      text: '',
      createdAt: index,
    }))
    const initial = { ...emptyThread, items, running: true }
    const store = new ThreadFrameStore(initial)
    let renders = 0

    function RangeVersion() {
      renders += 1
      const version = useSyncExternalStore(
        (listener) => store.subscribeItemRange(0, 2, listener),
        () => store.getSnapshot().itemVersion,
        () => store.getSnapshot().itemVersion,
      )
      return <span>{version}</span>
    }

    const view = render(<RangeVersion />)
    act(() => {
      store.publish({
        ...initial,
        liveItems: new Map([
          [
            3,
            {
              item: { ...items[3]!, text: 'outside' },
              version: 1,
              textUpdate: { kind: 'append', text: 'outside' },
            },
          ],
        ]),
        itemVersion: 1,
      })
    })
    expect(renders).toBe(1)

    act(() => {
      store.publish({
        ...initial,
        liveItems: new Map([
          [
            1,
            {
              item: { ...items[1]!, text: 'inside' },
              version: 2,
              textUpdate: { kind: 'append', text: 'inside' },
            },
          ],
        ]),
        itemVersion: 2,
      })
    })
    expect(renders).toBe(2)
    expect(view.getByText('2')).toBeTruthy()
  })

  it('resolves live activity rows when the collapsed disclosure opens', () => {
    const items: Item[] = [
      {
        id: 'command-1',
        turnId: 'turn-1',
        type: 'command',
        status: 'started',
        command: 'echo one',
        text: 'first',
        createdAt: 1,
      },
      {
        id: 'command-2',
        turnId: 'turn-1',
        type: 'command',
        status: 'started',
        command: 'echo two',
        text: 'second',
        createdAt: 2,
      },
    ]
    const initial = {
      ...emptyThread,
      items,
      running: true,
      activeTurn: { id: 'turn-1', startedAt: 1 },
    }
    const store = new ThreadFrameStore(initial)
    const view = render(
      <Thread
        frameStore={store}
        items={items}
        liveItems={initial.liveItems}
        itemVersion={0}
        liveStart={0}
        running
        activeTurn={initial.activeTurn}
        plan={[]}
        diff={undefined}
        approvals={[]}
        userInputs={[]}
        reviews={[]}
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )

    fireEvent.click(view.getByRole('button', { name: /running echo two/i }))
    const live = reduceDeltas(initial, [
      {
        type: 'item.delta',
        turnId: 'turn-1',
        itemId: 'command-1',
        textDelta: ' output',
      },
    ])
    act(() => store.publish(live))

    expect(view.container.querySelector('.activity__detail')?.textContent).toBe('first output')
  })
})
