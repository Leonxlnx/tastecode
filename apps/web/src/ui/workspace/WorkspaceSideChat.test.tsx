// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DomainEvent } from '@harness/contracts'
import { useSyncExternalStore } from 'react'
import type { ThreadFrameStore } from '../../thread-frame-store.js'
import type { Transport } from '../../transport.js'

const sideThreadRenders = vi.hoisted(() => vi.fn())

vi.mock('../Thread.js', () => ({
  Thread: (props: {
    frameStore?: ThreadFrameStore | undefined
    items: Array<{ id: string; text?: string | undefined }>
    liveItems?: ReadonlyMap<number, { item: { text?: string | undefined } }> | undefined
  }) => {
    sideThreadRenders()
    const snapshot = useSyncExternalStore(
      props.frameStore?.subscribe ?? (() => () => undefined),
      props.frameStore?.getSnapshot ?? (() => undefined),
      props.frameStore?.getSnapshot ?? (() => undefined),
    )
    const items = snapshot?.items ?? props.items
    const liveItems = snapshot?.liveItems ?? props.liveItems
    return (
      <div data-testid="side-thread">
        {items.map((item, index) => liveItems?.get(index)?.item.text ?? item.text).join('|')}
      </div>
    )
  },
}))

import { WorkspaceSideChat } from './WorkspaceSideChat.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('WorkspaceSideChat', () => {
  it('starts a separate ephemeral session and consumes only its event stream', async () => {
    let sideEvent:
      | ((payload: { threadId: string; event: DomainEvent; seq?: number | undefined }) => void)
      | undefined
    const request = vi.fn(async (method: string) => {
      if (method === 'sideChat.start') return { threadId: 'side-1' }
      if (method === 'thread.history') return { events: [], running: false }
      if (method === 'thread.sendTurn') return { queued: false, turnId: 'turn-1' }
      return {}
    })
    const transport = {
      request,
      on: vi.fn((channel: string, listener: typeof sideEvent) => {
        if (channel === 'sideChat.event') sideEvent = listener
        return () => {}
      }),
      onState: vi.fn(() => () => {}),
      onSequenceGap: vi.fn(() => () => {}),
    } as unknown as Transport

    const view = render(
      <WorkspaceSideChat
        active
        parentThreadId="main-1"
        parentStatus="working"
        projectName="TasteCode"
        transport={transport}
        startOptions={{ model: 'model-1', effort: 'high', approval: 'ask' }}
        promptRequest={{
          parentThreadId: 'main-1',
          text: 'Explain the failure',
          attachments: [],
          request: 1,
        }}
      />,
    )

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('sideChat.start', {
        parentThreadId: 'main-1',
        model: 'model-1',
        effort: 'high',
        approval: 'ask',
      }),
    )
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        'thread.sendTurn',
        expect.objectContaining({ threadId: 'side-1', text: 'Explain the failure' }),
      ),
    )
    expect(screen.queryByText('Main working')).toBeNull()
    expect(screen.queryByText('From main chat')).toBeNull()
    expect(screen.getByLabelText('Message temporary chat')).toBeTruthy()
    expect(screen.getByTestId('side-thread').textContent).toContain('Explain the failure')

    sideEvent?.({
      threadId: 'side-1',
      seq: 2,
      event: {
        type: 'item.completed',
        item: {
          id: 'answer-1',
          turnId: 'turn-1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          text: 'The side answer',
          createdAt: 2,
        },
      },
    })
    await waitFor(() =>
      expect(screen.getByTestId('side-thread').textContent).toContain('The side answer'),
    )

    view.unmount()
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('sideChat.close', { threadId: 'side-1' }),
    )
  })

  it('does not allow a temporary chat before the main conversation exists', () => {
    render(
      <WorkspaceSideChat
        active
        parentStatus="idle"
        transport={
          {
            on: () => () => {},
            onState: () => () => {},
            onSequenceGap: () => () => {},
            request: vi.fn(),
          } as unknown as Transport
        }
        startOptions={{ approval: 'ask' }}
      />,
    )

    expect(screen.getByText('Start a chat first')).toBeTruthy()
  })

  it('renders coalesced live text without rerendering the side-chat shell', async () => {
    let sideEvent:
      | ((payload: { threadId: string; event: DomainEvent; seq?: number | undefined }) => void)
      | undefined
    const request = vi.fn(async (method: string) => {
      if (method === 'sideChat.start') return { threadId: 'side-1' }
      if (method === 'thread.history') return { events: [], running: false }
      return {}
    })
    const transport = {
      request,
      on: vi.fn((channel: string, listener: typeof sideEvent) => {
        if (channel === 'sideChat.event') sideEvent = listener
        return () => {}
      }),
      onState: vi.fn(() => () => {}),
      onSequenceGap: vi.fn(() => () => {}),
    } as unknown as Transport

    render(
      <WorkspaceSideChat
        active
        parentThreadId="main-1"
        parentStatus="idle"
        transport={transport}
        startOptions={{ approval: 'ask' }}
      />,
    )

    await waitFor(() => expect(request).toHaveBeenCalledWith('sideChat.start', expect.anything()))
    await waitFor(() => expect(sideEvent).toBeDefined())
    act(() => {
      sideEvent?.({
        threadId: 'side-1',
        seq: 1,
        event: {
          type: 'turn.started',
          turn: { id: 'turn-1', threadId: 'side-1', status: 'running', createdAt: 1 },
        },
      })
      sideEvent?.({
        threadId: 'side-1',
        seq: 2,
        event: {
          type: 'item.started',
          item: {
            id: 'answer-1',
            turnId: 'turn-1',
            type: 'message',
            role: 'assistant',
            status: 'started',
            text: '',
            createdAt: 2,
          },
        },
      })
    })
    await screen.findByTestId('side-thread')

    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    sideThreadRenders.mockClear()
    act(() => {
      sideEvent?.({
        threadId: 'side-1',
        seq: 3,
        event: { type: 'item.delta', turnId: 'turn-1', itemId: 'answer-1', textDelta: 'Hel' },
      })
      sideEvent?.({
        threadId: 'side-1',
        seq: 4,
        event: { type: 'item.delta', turnId: 'turn-1', itemId: 'answer-1', textDelta: 'lo' },
      })
    })

    expect(frames).toHaveLength(1)
    expect(screen.getByTestId('side-thread').textContent).not.toContain('Hello')
    act(() => frames[0]?.(16))
    expect(screen.getByTestId('side-thread').textContent).toContain('Hello')
    expect(sideThreadRenders).toHaveBeenCalledTimes(1)
  })

  it('defers hidden live text until the temporary chat is visible again', async () => {
    let sideEvent:
      | ((payload: { threadId: string; event: DomainEvent; seq?: number | undefined }) => void)
      | undefined
    const request = vi.fn(async (method: string) => {
      if (method === 'sideChat.start') return { threadId: 'side-1' }
      if (method === 'thread.history') return { events: [], running: false }
      return {}
    })
    const transport = {
      request,
      on: vi.fn((channel: string, listener: typeof sideEvent) => {
        if (channel === 'sideChat.event') sideEvent = listener
        return () => {}
      }),
      onState: vi.fn(() => () => {}),
      onSequenceGap: vi.fn(() => () => {}),
    } as unknown as Transport
    const renderSideChat = (active: boolean) => (
      <WorkspaceSideChat
        active={active}
        parentThreadId="main-1"
        parentStatus="idle"
        transport={transport}
        startOptions={{ approval: 'ask' }}
      />
    )
    const view = render(renderSideChat(true))

    await waitFor(() => expect(request).toHaveBeenCalledWith('sideChat.start', expect.anything()))
    await waitFor(() => expect(sideEvent).toBeDefined())
    act(() => {
      sideEvent?.({
        threadId: 'side-1',
        seq: 1,
        event: {
          type: 'turn.started',
          turn: { id: 'turn-1', threadId: 'side-1', status: 'running', createdAt: 1 },
        },
      })
      sideEvent?.({
        threadId: 'side-1',
        seq: 2,
        event: {
          type: 'item.started',
          item: {
            id: 'answer-1',
            turnId: 'turn-1',
            type: 'message',
            role: 'assistant',
            status: 'started',
            text: '',
            createdAt: 2,
          },
        },
      })
    })
    await screen.findByTestId('side-thread')
    view.rerender(renderSideChat(false))

    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    act(() => {
      sideEvent?.({
        threadId: 'side-1',
        seq: 3,
        event: { type: 'item.delta', turnId: 'turn-1', itemId: 'answer-1', textDelta: 'Hel' },
      })
      sideEvent?.({
        threadId: 'side-1',
        seq: 4,
        event: { type: 'item.delta', turnId: 'turn-1', itemId: 'answer-1', textDelta: 'lo' },
      })
    })

    expect(requestFrame).not.toHaveBeenCalled()
    act(() => view.rerender(renderSideChat(true)))
    await waitFor(() => expect(screen.getByTestId('side-thread').textContent).toContain('Hello'))
  })

  it('keeps the normal composer visible while the temporary chat starts', async () => {
    render(
      <WorkspaceSideChat
        active
        parentThreadId="main-1"
        parentStatus="idle"
        transport={
          {
            on: () => () => {},
            onState: () => () => {},
            onSequenceGap: () => () => {},
            request: vi.fn(() => new Promise(() => {})),
          } as unknown as Transport
        }
        startOptions={{ approval: 'ask' }}
      />,
    )

    await waitFor(() =>
      expect(screen.getByLabelText('Message temporary chat').getAttribute('placeholder')).toBe(
        'Starting temporary chat…',
      ),
    )
    expect(document.querySelector('.workspace-side-chat__starting')).toBeNull()
  })
})
