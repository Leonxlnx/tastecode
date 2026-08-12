// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { Item } from '@harness/contracts'

const markdownRender = vi.hoisted(() => vi.fn())
const orbRender = vi.hoisted(() => vi.fn())
const virtualizerOptions = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; getItemKey: (index: number) => string | number }) => {
    virtualizerOptions(options)
    const { count } = options
    const rows = Array.from({ length: count }, (_, index) => ({
      index,
      key: index,
      start: index * 72,
      end: (index + 1) * 72,
      size: 72,
      lane: 0,
    }))
    return {
      getVirtualItems: () => rows,
      getTotalSize: () => count * 72,
      getOffsetForIndex: (index: number) => [index * 72],
      getScrollElement: () => null,
      scrollToIndex: () => undefined,
      measureElement: () => undefined,
      measurementsCache: rows,
    }
  },
}))

vi.mock('./Markdown.js', () => ({
  Markdown: ({
    text,
    streaming = false,
    liveUpdate,
    updateVersion,
  }: {
    text: string
    streaming?: boolean
    liveUpdate?: { kind: 'append'; text: string }
    updateVersion?: number
  }) => {
    markdownRender({
      text,
      streaming,
      ...(liveUpdate ? { liveUpdate } : {}),
      ...(updateVersion === undefined ? {} : { updateVersion }),
    })
    return <span>{text}</span>
  },
}))

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: (props: { state: string; size: number }) => {
    orbRender(props)
    return <canvas aria-label={props.state} />
  },
}))

import { Thread } from './Thread.js'

const onDecide = () => undefined
const onAnswerUserInput = () => undefined
const onEditMessage = () => undefined
const onRevertCheckpoint = () => undefined

function message(overrides: Partial<Item>): Item {
  return {
    id: 'item',
    turnId: 'turn',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    text: '',
    createdAt: 0,
    ...overrides,
  }
}

function view(
  items: Item[],
  running = true,
  identity: {
    threadId?: string
    revealRequest?: number
    liveItems?: ReadonlyMap<
      number,
      { item: Item; version: number; textUpdate: { kind: 'append'; text: string } }
    >
    itemVersion?: number
  } = {},
) {
  return (
    <Thread
      items={items}
      liveItems={identity.liveItems}
      itemVersion={identity.itemVersion}
      running={running}
      activeTurn={running ? { id: 'turn-2', startedAt: 0 } : undefined}
      threadId={identity.threadId}
      revealRequest={identity.revealRequest}
      plan={[]}
      diff={undefined}
      approvals={[]}
      userInputs={[]}
      reviews={[]}
      checkpoints={[]}
      onDecide={onDecide}
      onAnswerUserInput={onAnswerUserInput}
      onEditMessage={onEditMessage}
      onRevertCheckpoint={onRevertCheckpoint}
    />
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  markdownRender.mockReset()
  orbRender.mockReset()
  virtualizerOptions.mockReset()
})

describe('streamed thread renders', () => {
  it('preserves key identity for deltas and invalidates at history boundaries', () => {
    const first = [
      message({ id: 'user-a', role: 'user', text: 'Question' }),
      message({ id: 'answer-a', status: 'started', text: 'Hel' }),
    ]
    const rendered = render(view(first, true, { threadId: 'thread-a', revealRequest: 1 }))
    const initialGetter = virtualizerOptions.mock.lastCall?.[0].getItemKey

    rendered.rerender(
      view([...first.slice(0, -1), { ...first.at(-1)!, text: 'Hello' }], true, {
        threadId: 'thread-a',
        revealRequest: 1,
      }),
    )
    const streamedGetter = virtualizerOptions.mock.lastCall?.[0].getItemKey
    expect(streamedGetter).toBe(initialGetter)

    const appended = [
      ...first.slice(0, -1),
      { ...first.at(-1)!, text: 'Hello' },
      message({ id: 'user-next', role: 'user', text: 'Next question' }),
    ]
    rendered.rerender(view(appended, true, { threadId: 'thread-a', revealRequest: 2 }))
    const appendedGetter = virtualizerOptions.mock.lastCall?.[0].getItemKey
    expect(appendedGetter).toBe(streamedGetter)
    expect(appendedGetter?.(2)).toBe('user-next')

    const second = [
      message({ id: 'user-b', role: 'user', text: 'Another question' }),
      message({ id: 'answer-b', status: 'started', text: 'Another answer' }),
      message({ id: 'tool-b', type: 'tool_call', text: 'Run command' }),
    ]
    rendered.rerender(view(second, true, { threadId: 'thread-b', revealRequest: 1 }))
    const switchedGetter = virtualizerOptions.mock.lastCall?.[0].getItemKey
    expect(switchedGetter).not.toBe(streamedGetter)
    expect(switchedGetter?.(0)).toBe('user-b')

    const reloaded = [
      message({ id: 'history-user', role: 'user', text: 'Reloaded question' }),
      message({ id: 'history-answer', text: 'Reloaded answer' }),
      message({ id: 'history-tool', type: 'tool_call', text: 'Reloaded command' }),
    ]
    rendered.rerender(view(reloaded, false, { threadId: 'thread-b', revealRequest: 1 }))
    const reloadedGetter = virtualizerOptions.mock.lastCall?.[0].getItemKey
    expect(reloadedGetter).not.toBe(switchedGetter)
    expect(reloadedGetter?.(0)).toBe('history-user')
  })

  it('rerenders only the live Markdown row when the answer text grows', () => {
    const items: Item[] = [
      message({ id: 'user-1', turnId: 'turn-1', role: 'user', text: 'Question' }),
      message({ id: 'answer-1', turnId: 'turn-1', text: 'Done' }),
      message({ id: 'user-2', turnId: 'turn-2', role: 'user', text: 'Next question' }),
      message({ id: 'answer-2', turnId: 'turn-2', status: 'started', text: 'Hel' }),
    ]
    const rendered = render(view(items))
    const initialRenders = markdownRender.mock.calls.length

    rendered.rerender(view([...items.slice(0, -1), { ...items.at(-1)!, text: 'Hello' }]))

    expect(initialRenders).toBe(2)
    expect(markdownRender).toHaveBeenCalledTimes(initialRenders + 1)
    expect(markdownRender).toHaveBeenLastCalledWith({ text: 'Hello', streaming: true })
  })

  it('passes the exact frame delta and stable version to live Markdown', () => {
    const items: Item[] = [
      message({ id: 'user-2', turnId: 'turn-2', role: 'user', text: 'Question' }),
      message({ id: 'answer-2', turnId: 'turn-2', status: 'started', text: '' }),
    ]
    const liveItem = { ...items[1]!, text: 'Hello' }
    render(
      view(items, true, {
        liveItems: new Map([
          [
            1,
            { item: liveItem, version: 7, textUpdate: { kind: 'append' as const, text: 'Hello' } },
          ],
        ]),
        itemVersion: 7,
      }),
    )

    expect(markdownRender).toHaveBeenLastCalledWith({
      text: 'Hello',
      streaming: true,
      liveUpdate: { kind: 'append', text: 'Hello' },
      updateVersion: 7,
    })
  })

  it('does not reconcile the working animation for streamed text updates', () => {
    const items: Item[] = [
      message({ id: 'user-1', turnId: 'turn-2', role: 'user', text: 'Question' }),
      message({ id: 'answer-1', turnId: 'turn-2', status: 'started', text: 'Hel' }),
    ]
    const rendered = render(view(items))
    const initialRenders = orbRender.mock.calls.length

    rendered.rerender(view([...items.slice(0, -1), { ...items.at(-1)!, text: 'Hello' }]))

    expect(initialRenders).toBe(1)
    expect(orbRender).toHaveBeenCalledTimes(initialRenders)
  })

  it('uses the stable rail as the only live status and clears completed activity', () => {
    const user = message({
      id: 'user-1',
      turnId: 'turn-2',
      role: 'user',
      text: 'Run the checks',
    })
    const opening = message({
      id: 'opening-1',
      turnId: 'turn-2',
      status: 'started',
      text: 'I will run the checks.',
    })
    const command = message({
      id: 'command-1',
      turnId: 'turn-2',
      type: 'command',
      role: undefined,
      status: 'started',
      command: 'pnpm test',
    })
    const rendered = render(view([user, opening]))
    const rail = rendered.container.querySelector('.activity--working')

    expect(rendered.container.querySelector('.activity__working-label')?.textContent).toBe(
      'Working',
    )
    rendered.rerender(view([user, opening, command]))

    expect(rendered.container.querySelector('.activity--working')).toBe(rail)
    expect(rendered.container.querySelector('.activity__working-label')?.textContent).toBe(
      'Running a command',
    )
    expect(rendered.container.querySelectorAll('.aux--live')).toHaveLength(0)
    expect(rendered.container.querySelector('[data-index="2"]')?.className).toContain(
      'is-suppressed',
    )
    expect(rendered.container.querySelector('[data-index="2"]')?.className).not.toContain(
      'is-live-activity',
    )

    rendered.rerender(view([user, opening, { ...command, text: 'Tests passed.' }]))
    expect(rendered.container.querySelector('.activity--working')).toBe(rail)
    expect(rendered.container.querySelectorAll('.aux--live')).toHaveLength(0)

    const narration = message({
      id: 'answer-1',
      turnId: 'turn-2',
      status: 'started',
      text: 'The checks passed.',
    })
    rendered.rerender(
      view([user, opening, { ...command, status: 'completed', text: 'Tests passed.' }, narration]),
    )

    expect(rendered.container.querySelector('.activity--working')).toBe(rail)
    expect(rendered.container.querySelector('.activity__working-label')?.textContent).toBe(
      'Working',
    )
    expect(rendered.container.querySelectorAll('.aux--live')).toHaveLength(0)
    expect(rendered.container.querySelector('[data-index="2"]')?.className).toContain(
      'is-suppressed',
    )
    expect(rendered.queryByRole('button', { name: 'Ran a command' })).toBeNull()
    expect(rendered.queryByRole('button', { name: 'pnpm test' })).toBeNull()
    expect(markdownRender).toHaveBeenLastCalledWith({ text: narration.text, streaming: true })
  })

  it('does not restart the entry animation timer for streamed text updates', () => {
    vi.useFakeTimers()
    const existing: Item[] = [
      message({ id: 'user-1', turnId: 'turn-1', role: 'user', text: 'Question' }),
      message({ id: 'answer-1', turnId: 'turn-1', text: 'Done' }),
    ]
    const rendered = render(view(existing, false))
    const live = message({
      id: 'answer-2',
      turnId: 'turn-2',
      status: 'started',
      text: 'Hel',
    })

    rendered.rerender(view([...existing, live]))
    expect(rendered.container.querySelector('[data-index="2"]')?.className).toContain('is-entering')

    act(() => vi.advanceTimersByTime(200))
    rendered.rerender(view([...existing, { ...live, text: 'Hello' }]))
    act(() => vi.advanceTimersByTime(161))

    expect(rendered.container.querySelector('[data-index="2"]')?.className).not.toContain(
      'is-entering',
    )
  })
})
