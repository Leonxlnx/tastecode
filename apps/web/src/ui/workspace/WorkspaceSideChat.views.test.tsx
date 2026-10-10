// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MethodName } from '@harness/contracts'
import { TestTransport } from '../../test-transport.js'
import { WorkspacePanel } from './WorkspacePanel.js'

vi.mock('../Thread.js', () => ({
  Thread: () => <div data-testid="side-thread" />,
}))

afterEach(() => {
  cleanup()
})

/** Mirrors the server: one side thread per main chat, gone once it is closed. */
function sideChatServer() {
  const sideThreads = new Map<string, string>()
  const live = new Set<string>()
  let created = 0
  let turns = 0
  const transport = new TestTransport(async (method, params) => {
    const values = params as Record<string, string>
    if (method === 'sideChat.start') {
      const parentThreadId = values['parentThreadId']!
      let threadId = sideThreads.get(parentThreadId)
      if (!threadId) {
        threadId = `side-${++created}`
        sideThreads.set(parentThreadId, threadId)
        live.add(threadId)
      }
      return { threadId }
    }
    if (method === 'sideChat.close') {
      live.delete(values['threadId']!)
      for (const [parent, threadId] of sideThreads) {
        if (threadId === values['threadId']) sideThreads.delete(parent)
      }
      return {}
    }
    if (method === 'thread.history') return { events: [], running: false }
    if (method === 'thread.sendTurn') {
      if (!live.has(values['threadId']!)) throw new Error(`no such thread: ${values['threadId']}`)
      return { queued: false, turnId: `turn-${++turns}` }
    }
    throw new Error(`Unhandled test request: ${method}`)
  })
  const calls = (method: MethodName) =>
    transport.requests.filter((request) => request.method === method).map(({ params }) => params)
  return { transport, calls }
}

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))

function panelProps(transport: TestTransport) {
  return {
    open: true,
    expanded: false,
    width: 400,
    transport,
    theme: 'dark' as const,
    threadId: 'main-1',
    projectPath: '/ws',
    sideChatParentStatus: 'idle' as const,
    sideChatStartOptions: { approval: 'ask' as const },
    nativeSurfacesVisible: true,
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onWidthChange: vi.fn(),
  }
}

describe('Temporary chat views', () => {
  it('does not send a delivered /side prompt again when Temporary chat reopens', async () => {
    const { transport, calls } = sideChatServer()
    render(
      <WorkspacePanel
        {...panelProps(transport)}
        sideChatPromptRequest={{
          parentThreadId: 'main-1',
          text: 'why did the build fail?',
          attachments: [],
          request: 1,
        }}
      />,
    )
    await waitFor(() => expect(calls('thread.sendTurn')).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'Close right panel' }))
    await waitFor(() => expect(calls('sideChat.close')).toEqual([{ threadId: 'side-1' }]))
    fireEvent.click(screen.getByRole('button', { name: 'Temporary chat' }))
    await waitFor(() => expect(calls('thread.history')).toHaveLength(2))
    await settle()

    expect(calls('sideChat.start')).toHaveLength(2)
    expect(calls('thread.sendTurn')).toHaveLength(1)
  })
})
