// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TestTransport } from '../../test-transport.js'
import { WorkspaceSideChat, type WorkspaceSideThread } from './WorkspaceSideChat.js'

const TestThread = (({ items }) => (
  <div data-testid="side-thread">{items.map((item) => item.text).join('|')}</div>
)) satisfies WorkspaceSideThread

afterEach(cleanup)

describe('WorkspaceSideChat', () => {
  it('starts a separate ephemeral session and consumes only its event stream', async () => {
    const transport = new TestTransport(async (method) => {
      if (method === 'sideChat.start') return { threadId: 'side-1' }
      if (method === 'thread.history') return { events: [], running: false }
      if (method === 'thread.sendTurn') return { queued: false, turnId: 'turn-1' }
      if (method === 'sideChat.close') return {}
      throw new Error(`Unexpected request: ${method}`)
    })

    const view = render(
      <WorkspaceSideChat
        active
        parentThreadId="main-1"
        parentStatus="working"
        projectName="TasteCode"
        transport={transport}
        threadComponent={TestThread}
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
      expect(transport.requests).toContainEqual({
        method: 'sideChat.start',
        params: {
          parentThreadId: 'main-1',
          model: 'model-1',
          effort: 'high',
          approval: 'ask',
        },
      }),
    )
    await waitFor(() =>
      expect(transport.requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'thread.sendTurn',
            params: expect.objectContaining({
              threadId: 'side-1',
              text: 'Explain the failure',
            }),
          }),
        ]),
      ),
    )
    expect(screen.queryByText('Main working')).toBeNull()
    expect(screen.queryByText('From main chat')).toBeNull()
    expect(screen.getByLabelText('Message temporary chat')).toBeTruthy()
    expect(screen.getByTestId('side-thread').textContent).toContain('Explain the failure')

    transport.emit('sideChat.event', {
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
      expect(transport.requests).toContainEqual({
        method: 'sideChat.close',
        params: { threadId: 'side-1' },
      }),
    )
  })

  it('does not allow a temporary chat before the main conversation exists', () => {
    render(
      <WorkspaceSideChat
        active
        parentStatus="idle"
        transport={new TestTransport()}
        threadComponent={TestThread}
        startOptions={{ approval: 'ask' }}
      />,
    )

    expect(screen.getByText('Start a chat first')).toBeTruthy()
  })

  it('keeps the normal composer visible while the temporary chat starts', async () => {
    const transport = new TestTransport(async (method) => {
      if (method === 'sideChat.start') return new Promise<never>(() => undefined)
      throw new Error(`Unexpected request: ${method}`)
    })
    render(
      <WorkspaceSideChat
        active
        parentThreadId="main-1"
        parentStatus="idle"
        transport={transport}
        threadComponent={TestThread}
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
