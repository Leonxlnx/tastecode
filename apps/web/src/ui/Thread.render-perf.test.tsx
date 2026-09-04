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
    searching?: boolean
  } = {},
) {
  return (
    <Thread
      items={items}
      liveItems={identity.liveItems}
      itemVersion={identity.itemVersion}
      {...(identity.searching === undefined ? {} : { searching: identity.searching })}
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

  it('does not add a duplicate working animation beside a streamed answer', () => {
    const items: Item[] = [
      message({ id: 'user-1', turnId: 'turn-2', role: 'user', text: 'Question' }),
      message({ id: 'answer-1', turnId: 'turn-2', status: 'started', text: 'Hel' }),
    ]
    const rendered = render(view(items))
    const initialRenders = orbRender.mock.calls.length

    rendered.rerender(view([...items.slice(0, -1), { ...items.at(-1)!, text: 'Hello' }]))

    expect(initialRenders).toBe(0)
    expect(orbRender).toHaveBeenCalledTimes(initialRenders)
  })

  it('keeps one live activity stack while commands change, then settles it at a boundary', () => {
    const user = message({
      id: 'user-1',
      turnId: 'turn-2',
      role: 'user',
      text: 'Run the checks',
    })
    const firstCommand = message({
      id: 'command-1',
      turnId: 'turn-2',
      type: 'command',
      role: undefined,
      status: 'started',
      command: 'pnpm test',
    })
    const rendered = render(view([user, firstCommand]))
    const stack = rendered.container.querySelector('.activity')

    expect(rendered.getByRole('button', { name: 'Running pnpm test' })).toBeTruthy()
    expect(rendered.container.querySelector('[data-index="1"]')?.className).not.toContain(
      'is-suppressed',
    )

    const blankReasoning = message({
      id: 'reasoning-empty',
      turnId: 'turn-2',
      type: 'reasoning',
      role: undefined,
      status: 'completed',
      text: '',
    })
    rendered.rerender(view([user, { ...firstCommand, status: 'completed' }, blankReasoning]))

    expect(rendered.container.querySelector('.activity')).toBe(stack)
    expect(rendered.getByRole('button', { name: 'Ran pnpm test' })).toBeTruthy()
    expect(rendered.queryByText('Thinking')).toBeNull()

    const secondCommand = message({
      id: 'command-2',
      turnId: 'turn-2',
      type: 'command',
      role: undefined,
      status: 'started',
      command: 'git status --short',
    })
    rendered.rerender(
      view([user, { ...firstCommand, status: 'completed' }, blankReasoning, secondCommand]),
    )

    expect(rendered.container.querySelector('.activity')).toBe(stack)
    expect(rendered.getByRole('button', { name: 'Running git status --short' })).toBeTruthy()
    expect(rendered.container.querySelectorAll('.activity')).toHaveLength(1)
    expect(rendered.container.querySelector('[data-index="3"]')?.className).toContain(
      'is-suppressed',
    )

    const reasoning = message({
      id: 'reasoning-1',
      turnId: 'turn-2',
      type: 'reasoning',
      role: undefined,
      status: 'started',
      text: 'Reviewing command results',
    })
    rendered.rerender(
      view([
        user,
        { ...firstCommand, status: 'completed' },
        blankReasoning,
        { ...secondCommand, status: 'completed' },
        reasoning,
      ]),
    )

    expect(rendered.container.querySelector('.activity')).toBe(stack)
    expect(rendered.getByRole('button', { name: 'Ran commands' })).toBeTruthy()
    const thinking = rendered.getByRole('button', { name: 'Thinking' })
    expect(thinking.parentElement?.querySelector('.aux__reveal')?.getAttribute('aria-hidden')).toBe(
      'true',
    )
    expect(rendered.container.querySelector('.activity--working')).toBeNull()
  })

  it('does not wake a hidden document to update a live reasoning label', () => {
    vi.useFakeTimers({ now: 1_500 })
    let documentVisible = false
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => (documentVisible ? 'visible' : 'hidden'))
    try {
      const reasoning = message({
        id: 'reasoning-live',
        turnId: 'turn-2',
        type: 'reasoning',
        role: undefined,
        status: 'started',
        text: 'Reviewing the result',
        createdAt: 1_000,
      })
      const rendered = render(view([reasoning]))

      expect(rendered.getByRole('button', { name: 'Thinking' })).toBeTruthy()
      expect(vi.getTimerCount()).toBe(0)
      act(() => vi.advanceTimersByTime(4_500))
      expect(rendered.getByRole('button', { name: 'Thinking' })).toBeTruthy()

      documentVisible = true
      act(() => document.dispatchEvent(new Event('visibilitychange')))
      expect(rendered.getByRole('button', { name: 'Thought for 5s' })).toBeTruthy()
      expect(vi.getTimerCount()).toBe(1)
      act(() => vi.advanceTimersByTime(1_000))
      expect(rendered.getByRole('button', { name: 'Thought for 6s' })).toBeTruthy()

      documentVisible = false
      act(() => document.dispatchEvent(new Event('visibilitychange')))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      visibility.mockRestore()
    }
  })

  it('updates hour-long reasoning labels only when the shown minute changes', () => {
    vi.useFakeTimers({ now: 3_601_000 })
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    try {
      const reasoning = message({
        id: 'reasoning-long',
        turnId: 'turn-2',
        type: 'reasoning',
        role: undefined,
        status: 'started',
        text: 'Still working',
        createdAt: 1_000,
      })
      const rendered = render(view([reasoning]))

      expect(rendered.getByRole('button', { name: 'Thought for 1h' })).toBeTruthy()
      expect(vi.getTimerCount()).toBe(1)
      act(() => vi.advanceTimersByTime(59_999))
      expect(rendered.getByRole('button', { name: 'Thought for 1h' })).toBeTruthy()
      act(() => vi.advanceTimersByTime(1))
      expect(rendered.getByRole('button', { name: 'Thought for 1h 1m' })).toBeTruthy()
    } finally {
      visibility.mockRestore()
    }
  })

  it('keeps live narration close to the activity row that follows it', () => {
    const user = message({
      id: 'user-1',
      turnId: 'turn-2',
      role: 'user',
      text: 'Run the checks',
    })
    const narration = message({
      id: 'commentary-1',
      turnId: 'turn-2',
      role: 'assistant',
      phase: 'commentary',
      text: 'I found the cause.',
    })
    const command = message({
      id: 'command-1',
      turnId: 'turn-2',
      type: 'command',
      role: undefined,
      status: 'started',
      command: 'pnpm test',
    })

    const rendered = render(view([user, narration, command]))

    expect(rendered.container.querySelector('[data-index="1"]')?.className).toContain(
      'is-compact-to-next',
    )
    expect(rendered.container.querySelector('[data-index="0"]')?.className).not.toContain(
      'is-compact-to-next',
    )
  })

  it('crossfades working labels without remounting the rail', () => {
    vi.useFakeTimers()
    const user = message({
      id: 'user-1',
      turnId: 'turn-2',
      role: 'user',
      text: 'Run the checks',
    })
    const rendered = render(view([user]))
    const rail = rendered.container.querySelector('.activity--working')

    rendered.rerender(view([user], true, { searching: true }))

    expect(rendered.container.querySelector('.activity--working')).toBe(rail)
    expect(rendered.container.querySelector('.activity__working-label')?.textContent).toBe(
      'Searching',
    )
    expect(rendered.container.querySelector('.activity__working-label-previous')?.textContent).toBe(
      'Working',
    )
    const previousTime = rendered.container.querySelector(
      '.activity__working-status-previous .activity__working-time',
    )?.textContent
    const currentTime = rendered.container.querySelector(
      '.activity__working-status .activity__working-time',
    )?.textContent
    expect(previousTime).toBeTruthy()
    expect(currentTime).toBe(previousTime)

    act(() => vi.advanceTimersByTime(480))

    expect(rendered.container.querySelector('.activity__working-label-previous')).toBeNull()
    vi.useRealTimers()
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
