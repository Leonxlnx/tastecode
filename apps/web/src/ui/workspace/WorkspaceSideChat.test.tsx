// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DomainEvent } from '@harness/contracts'
import type { Transport } from '../../transport.js'

vi.mock('../Thread.js', () => ({
  Thread: (props: { items: Array<{ id: string; text?: string | undefined }> }) => (
    <div data-testid="side-thread">{props.items.map((item) => item.text).join('|')}</div>
  ),
}))

import { WorkspaceSideChat } from './WorkspaceSideChat.js'

afterEach(cleanup)

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
        projectName="Harness"
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
