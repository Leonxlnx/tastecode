// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DomainEvent } from '@harness/contracts'
import { useSyncExternalStore, type ComponentProps } from 'react'
import type { ThreadFrameStore } from '../../thread-frame-store.js'
import { IndeterminateRequestError, type Transport } from '../../transport.js'
import { UserInput } from '../../design-agent/UserInput.js'
import { WorkspaceSideChat } from './WorkspaceSideChat.js'

vi.mock('../Thread.js', () => ({
  Thread: (props: {
    frameStore: ThreadFrameStore
    onAnswerUserInput: (id: string, answers: Record<string, string[]>) => Promise<void>
  }) => {
    const snapshot = useSyncExternalStore(props.frameStore.subscribe, props.frameStore.getSnapshot)
    return (
      <div>
        <div data-testid="transcript">
          {snapshot.items
            .map((item, index) => snapshot.liveItems?.get(index)?.item.text ?? item.text)
            .join('|')}
        </div>
        <UserInput
          request={{
            id: 'question',
            turnId: 'turn',
            autoResolutionMs: null,
            createdAt: 1,
            questions: [
              {
                id: 'choice',
                header: 'Choice',
                question: 'Which option?',
                allowOther: false,
                secret: false,
                options: [{ label: 'Yes', description: '' }],
              },
            ],
          }}
          onSubmit={(answers) => props.onAnswerUserInput('question', answers)}
        />
      </div>
    )
  },
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

type EventPayload = { threadId: string; event: DomainEvent; seq?: number | undefined }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function harness(
  handle?: (method: string, params: Record<string, unknown>) => Promise<unknown> | undefined,
) {
  let event!: (payload: EventPayload) => void
  let reconnect!: (state: string) => void
  const request = vi.fn((method: string, params: Record<string, unknown>) => {
    const custom = handle?.(method, params)
    if (custom) return custom
    if (method === 'sideChat.start')
      return Promise.resolve({ threadId: `side-${String(params['parentThreadId'])}` })
    if (method === 'thread.history') return Promise.resolve({ events: [], running: false })
    if (method === 'thread.sendTurn') return Promise.resolve({ queued: false, turnId: 'turn' })
    return Promise.resolve({})
  })
  const transport = {
    request,
    on: (_channel: string, callback: typeof event) => {
      event = callback
      return () => {}
    },
    onState: (callback: typeof reconnect) => {
      reconnect = callback
      return () => {}
    },
    onSequenceGap: () => () => {},
  } as unknown as Transport
  let props: ComponentProps<typeof WorkspaceSideChat> = {
    active: true,
    parentThreadId: 'a',
    parentStatus: 'idle',
    transport,
    startOptions: { model: 'model-a' },
  }
  const view = render(<WorkspaceSideChat {...props} />)
  return {
    request,
    emit: (payload: EventPayload) => act(() => event(payload)),
    reconnect: () => act(() => reconnect('open')),
    rerender: (next: Partial<typeof props>) => {
      props = { ...props, ...next }
      view.rerender(<WorkspaceSideChat {...props} />)
    },
    ready: () =>
      waitFor(() => expect(request).toHaveBeenCalledWith('thread.history', { threadId: 'side-a' })),
  }
}

function message(text: string): DomainEvent {
  return {
    type: 'item.completed',
    item: {
      id: text,
      turnId: 'turn',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      text,
      createdAt: 1,
    },
  }
}
function started(): DomainEvent {
  return {
    type: 'turn.started',
    turn: { id: 'turn', threadId: 'side-a', status: 'running', createdAt: 1 },
  }
}

describe('Side chat recovery', () => {
  it('returns answer failures to the question form so it can retry', async () => {
    const app = harness((method) =>
      method === 'thread.respondToUserInput'
        ? Promise.reject(new Error('Answer failed'))
        : undefined,
    )
    await app.ready()
    app.emit({ threadId: 'side-a', event: message('Question incoming'), seq: 1 })
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await waitFor(() => expect(screen.queryByText('Submitting answers…')).toBeNull())
    expect(screen.getByRole('button', { name: 'Submit' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByText('Answer failed')).toBeTruthy()
  })

  it.each(['/side', '/btw'])('preserves the exact draft when rejecting %s', async (command) => {
    const app = harness()
    await app.ready()
    const text = `  ${command} Explain this\nwith more detail  `
    const area = screen.getByLabelText('Message temporary chat') as HTMLTextAreaElement
    fireEvent.change(area, { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(screen.getByRole('alert').textContent).toContain('Nested temporary chats')
    expect(area.value).toBe(text)
    expect(app.request.mock.calls.filter(([method]) => method === 'thread.sendTurn')).toHaveLength(
      0,
    )
  })

  it('does not restore a late send failure into the newly selected chat', async () => {
    const send = deferred<never>()
    const app = harness((method) => (method === 'thread.sendTurn' ? send.promise : undefined))
    await app.ready()
    app.rerender({
      promptRequest: { parentThreadId: 'a', text: 'Old message', attachments: [], request: 1 },
    })
    await waitFor(() =>
      expect(app.request).toHaveBeenCalledWith('thread.sendTurn', expect.anything()),
    )
    app.rerender({ parentThreadId: 'b' })
    await waitFor(() =>
      expect(app.request).toHaveBeenCalledWith('thread.history', { threadId: 'side-b' }),
    )
    const area = screen.getByLabelText('Message temporary chat') as HTMLTextAreaElement
    fireEvent.change(area, { target: { value: 'New draft' } })
    app.emit({
      threadId: 'side-b',
      event: {
        type: 'turn.started',
        turn: { id: 'new-turn', threadId: 'side-b', status: 'running', createdAt: 2 },
      },
      seq: 1,
    })
    await act(async () => send.reject(new Error('Old send failed')))
    expect(area.value).toBe('New draft')
    expect(screen.queryByText('Old send failed')).toBeNull()
    expect(screen.getByRole('button', { name: 'Stop temporary chat' })).toBeTruthy()
  })

  it('retries an indeterminate send with the same id, attachments and model', async () => {
    let attempts = 0
    const app = harness((method) =>
      method === 'thread.sendTurn' && attempts++ === 0
        ? Promise.reject(new IndeterminateRequestError('Reply lost'))
        : undefined,
    )
    await app.ready()
    app.rerender({
      promptRequest: {
        parentThreadId: 'a',
        text: 'Keep this once',
        attachments: ['/work/image.png'],
        request: 1,
      },
    })
    await screen.findByRole('button', { name: 'Retry safely' })
    expect(screen.getByRole('alert').textContent).toContain('Delivery is unconfirmed')
    expect(screen.getByRole('button', { name: 'Stop temporary chat' })).toBeTruthy()
    expect((screen.getByLabelText('Message temporary chat') as HTMLTextAreaElement).value).toBe('')
    expect(screen.getByTestId('transcript').textContent).toBe('Keep this once')
    app.rerender({ startOptions: { model: 'model-b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Retry safely' }))
    await waitFor(() =>
      expect(
        app.request.mock.calls.filter(([method]) => method === 'thread.sendTurn'),
      ).toHaveLength(2),
    )
    const sends = app.request.mock.calls.filter(([method]) => method === 'thread.sendTurn')
    expect(sends[1]![1]).toEqual(sends[0]![1])
    expect(screen.getByTestId('transcript').textContent).toBe('Keep this once')
  })

  it('retains attachments with a definitely failed message and resends them', async () => {
    let attempts = 0
    const app = harness((method) =>
      method === 'thread.sendTurn' && attempts++ === 0
        ? Promise.reject(new Error('Send failed'))
        : undefined,
    )
    await app.ready()
    app.rerender({
      promptRequest: {
        parentThreadId: 'a',
        text: 'Check file',
        attachments: ['/work/input.png'],
        request: 1,
      },
    })
    await screen.findByText('Send failed')
    expect((screen.getByLabelText('Message temporary chat') as HTMLTextAreaElement).value).toBe(
      'Check file',
    )
    expect(screen.getByRole('list', { name: 'Attached files' }).textContent).toContain('input.png')
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() =>
      expect(
        app.request.mock.calls.filter(([method]) => method === 'thread.sendTurn'),
      ).toHaveLength(2),
    )
    expect(app.request).toHaveBeenLastCalledWith(
      'thread.sendTurn',
      expect.objectContaining({ text: 'Check file', attachments: ['/work/input.png'] }),
    )
  })

  it('retains attachments when a forwarded message is blocked by a running turn', async () => {
    const app = harness()
    await app.ready()
    app.emit({ threadId: 'side-a', event: started(), seq: 1 })
    app.rerender({
      promptRequest: {
        parentThreadId: 'a',
        text: 'Later message',
        attachments: ['/work/later.png'],
        request: 1,
      },
    })
    await waitFor(() =>
      expect((screen.getByLabelText('Message temporary chat') as HTMLTextAreaElement).value).toBe(
        'Later message',
      ),
    )
    expect(screen.getByRole('list', { name: 'Attached files' }).textContent).toContain('later.png')
    app.emit({
      threadId: 'side-a',
      seq: 2,
      event: { type: 'turn.completed', turnId: 'turn', status: 'completed' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() =>
      expect(app.request).toHaveBeenCalledWith(
        'thread.sendTurn',
        expect.objectContaining({ text: 'Later message', attachments: ['/work/later.png'] }),
      ),
    )
  })

  it('replays live events when reconnect history fails', async () => {
    const history = deferred<never>()
    const app = harness((method, params) =>
      method === 'thread.history' && params['afterSeq'] !== undefined ? history.promise : undefined,
    )
    await app.ready()
    app.reconnect()
    app.emit({ threadId: 'side-a', event: started(), seq: 1 })
    app.emit({ threadId: 'side-a', event: message('Live during reconnect'), seq: 2 })
    expect(screen.queryByText('Live during reconnect')).toBeNull()
    await act(async () => history.reject(new Error('History unavailable')))
    expect(screen.getByTestId('transcript').textContent).toContain('Live during reconnect')
    expect(screen.getByRole('button', { name: 'Stop temporary chat' })).toBeTruthy()
    app.emit({ threadId: 'side-a', event: message('Live after failure'), seq: 3 })
    expect(screen.getByTestId('transcript').textContent).toContain('Live after failure')
  })

  it('replays live events when initial history fails', async () => {
    const history = deferred<never>()
    const app = harness((method) => (method === 'thread.history' ? history.promise : undefined))
    await app.ready()
    app.emit({ threadId: 'side-a', event: started(), seq: 1 })
    app.emit({ threadId: 'side-a', event: message('Live during startup'), seq: 2 })
    await act(async () => history.reject(new Error('History unavailable')))
    expect(screen.getByTestId('transcript').textContent).toContain('Live during startup')
    expect(screen.getByRole('button', { name: 'Stop temporary chat' })).toBeTruthy()
  })

  it('keeps a buffered new turn running after loading an idle history snapshot', async () => {
    const history = deferred<{ events: []; running: boolean }>()
    const app = harness((method, params) =>
      method === 'thread.history' && params['afterSeq'] !== undefined ? history.promise : undefined,
    )
    await app.ready()
    app.reconnect()
    app.emit({ threadId: 'side-a', event: started(), seq: 1 })
    await act(async () => history.resolve({ events: [], running: false }))
    expect(screen.getByRole('button', { name: 'Stop temporary chat' })).toBeTruthy()
  })
})
