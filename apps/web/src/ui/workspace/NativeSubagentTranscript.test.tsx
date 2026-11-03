// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Item, Subagent } from '@harness/contracts'
import { TestTransport, type TestRequestResolver } from '../../test-transport.js'
import { ThreadFrameStore } from '../../thread-frame-store.js'
import { emptyThread } from '../../thread-state.js'
import { WorkspaceAgents } from './WorkspaceAgents.js'

// Keep the real Thread renderer; happy-dom does not measure scroll viewports.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 72 })),
    getTotalSize: () => count * 72,
    measureElement: () => undefined,
    indexFromElement: (node: Element) => Number(node.getAttribute('data-index')),
    resizeItem: () => undefined,
    measurementsCache: [],
    getOffsetForIndex: () => [0],
    scrollToIndex: () => undefined,
  }),
}))

afterEach(cleanup)

const snapshot: Subagent = {
  id: 'toolu-read',
  transcriptId: 'worker',
  name: 'Explore',
  description: 'Read the notes',
  state: 'completed',
  summary: 'Snapshot report',
}
const launcher = (subagent = snapshot): Item => ({
  id: 'toolu-read-call',
  type: 'tool_call',
  status: 'completed',
  turnId: 'parent-turn',
  createdAt: 1,
  subagent,
})
const items: Item[] = [
  {
    id: 'prompt',
    turnId: 'child-turn',
    type: 'message',
    role: 'user',
    status: 'completed',
    createdAt: 1_000,
    text: 'Read notes.txt and quote the first line.',
  },
  {
    id: 'read',
    turnId: 'child-turn',
    type: 'tool_call',
    status: 'completed',
    createdAt: 2_000,
    text: 'Read\n{"file_path":"notes.txt"}\nTiny scratch project.',
  },
  {
    id: 'answer',
    turnId: 'child-turn',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    createdAt: 3_000,
    text: 'The first line is Tiny scratch project.',
  },
]

function setup(resolve: TestRequestResolver, supported = true, subagent = snapshot) {
  const frameStore = new ThreadFrameStore({ ...emptyThread, items: [launcher(subagent)] })
  const transport = new TestTransport((method, params) =>
    method === 'thread.subagents' ? { subagents: [] } : resolve(method, params),
  )
  const view = render(
    <WorkspaceAgents
      active
      transport={transport}
      threadId="parent"
      frameStore={frameStore}
      subagentTranscript={supported}
    />,
  )
  return { frameStore, transport, ...view }
}

async function open() {
  fireEvent.click(await screen.findByRole('button', { name: /Explore/ }))
}

describe('native subagent transcript', () => {
  it('renders the prompt, tool call and answer through Thread without chat controls', async () => {
    const { transport, container } = setup(() => ({ items }))
    await open()
    expect(await screen.findByText('Read notes.txt and quote the first line.')).toBeTruthy()
    expect(await screen.findByText('The first line is Tiny scratch project.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Worked for/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Used Read · notes.txt' }))
    expect(await screen.findByText('notes.txt')).toBeTruthy()
    expect(screen.getByText('Tiny scratch project.')).toBeTruthy()
    expect(container.querySelector('textarea, [contenteditable="true"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(screen.queryByText('Snapshot report')).toBeNull()
    expect(transport.requests).toContainEqual({
      method: 'thread.subagentTranscript',
      params: { threadId: 'parent', itemId: 'toolu-read-call' },
    })
    expect(
      transport.requests.every(
        ({ method }) => method === 'thread.subagents' || method === 'thread.subagentTranscript',
      ),
    ).toBe(true)
  })

  it('keeps the snapshot without requesting history when the capability is absent', async () => {
    const { transport } = setup(() => {
      throw new Error('Must not request')
    }, false)
    await open()
    expect(await screen.findByText('Snapshot report')).toBeTruthy()
    expect(screen.getByText('Transcript not available for this engine yet')).toBeTruthy()
    expect(transport.requests).toHaveLength(1)
  })

  it('keeps the snapshot when the saved transcript is unavailable', async () => {
    setup(() => ({ items: [] }))
    await open()
    expect(await screen.findByText('Snapshot report')).toBeTruthy()
    expect(
      screen.queryByText('Tell the agent what you want to build, then send it below.'),
    ).toBeNull()
  })

  it('says how many earlier steps a long transcript left out', async () => {
    setup(() => ({ items, omitted: 600 }))
    await open()
    expect(await screen.findByText('600 earlier steps are not shown.')).toBeTruthy()
    expect(await screen.findByText('The first line is Tiny scratch project.')).toBeTruthy()
  })

  it('asks again every five seconds only while running and visible, then once when done', async () => {
    // Opened in a hidden window, so the first read schedules nothing before the clock is faked;
    // Testing Library's async helpers wait on setTimeout and are not used after that.
    let hidden = true
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => (hidden ? 'hidden' : 'visible'))
    const { frameStore, transport } = setup(() => ({ items }), true, {
      ...snapshot,
      state: 'running',
    })
    const reads = () =>
      transport.requests.filter(({ method }) => method === 'thread.subagentTranscript').length
    const visibilityChange = (value: boolean) =>
      act(async () => {
        hidden = !value
        document.dispatchEvent(new Event('visibilitychange'))
      })
    const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
    try {
      await open()
      await screen.findByText('The first line is Tiny scratch project.')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await advance(30_000)
      expect(reads()).toBe(1)
      await visibilityChange(true)
      expect(reads()).toBe(2)
      await advance(4_999)
      expect(reads()).toBe(2)
      await advance(1)
      expect(reads()).toBe(3)
      await visibilityChange(false)
      await advance(30_000)
      expect(reads()).toBe(3)
      await visibilityChange(true)
      expect(reads()).toBe(4)
      await act(async () => frameStore.publish({ ...emptyThread, items: [launcher()] }))
      expect(reads()).toBe(5)
      await advance(30_000)
      expect(reads()).toBe(5)
    } finally {
      vi.useRealTimers()
      visibility.mockRestore()
    }
  })

  it('retries a failed read and reads again when reopened', async () => {
    let calls = 0
    setup(() => {
      if (++calls === 1) throw new Error('Could not read the saved conversation')
      return { items }
    })
    await open()
    expect(await screen.findByText('Could not read the saved conversation')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('The first line is Tiny scratch project.')
    fireEvent.click(screen.getByRole('button', { name: 'All subagents' }))
    await open()
    await waitFor(() => expect(calls).toBe(3))
  })

  it('refreshes on completion and discards an older running read that finishes later', async () => {
    let finish!: (result: { items: Item[] }) => void
    let calls = 0
    const { frameStore } = setup(
      () => {
        if (++calls === 1)
          return new Promise<{ items: Item[] }>((resolve) => {
            finish = resolve
          })
        return { items }
      },
      true,
      { ...snapshot, state: 'running' },
    )
    await open()
    await waitFor(() => expect(calls).toBe(1))
    act(() => frameStore.publish({ ...emptyThread, items: [launcher()] }))
    await screen.findByText('The first line is Tiny scratch project.')
    await act(async () => finish({ items: [] }))
    expect(screen.queryByText('Snapshot report')).toBeNull()
    expect(screen.getByText('The first line is Tiny scratch project.')).toBeTruthy()
  })
})
