// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MethodName } from '@harness/contracts'
import { TestTransport } from '../../test-transport.js'
import { WorkspacePanel } from './WorkspacePanel.js'
import { WorkspaceSideChat } from './WorkspaceSideChat.js'

vi.mock('../Thread.js', () => ({
  Thread: () => <div data-testid="side-thread" />,
}))

afterEach(() => {
  cleanup()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Mirrors the server: one side thread per main chat, gone once it is closed. */
function sideChatServer(startGate?: () => Promise<void> | undefined) {
  const sideThreads = new Map<string, string>()
  const live = new Set<string>()
  let created = 0
  let turns = 0
  const transport = new TestTransport(async (method, params) => {
    const values = params as Record<string, string>
    if (method === 'sideChat.start') {
      await startGate?.()
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

function send(composer: HTMLElement, text: string) {
  fireEvent.change(composer, { target: { value: text } })
  fireEvent.keyDown(composer, { key: 'Enter' })
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

  it('keeps a Temporary chat shown in both panels alive until the last one closes', async () => {
    const { transport, calls } = sideChatServer()
    const props = panelProps(transport)
    render(
      <>
        <WorkspacePanel {...props} placement="bottom" />
        <WorkspacePanel {...props} />
      </>,
    )
    const bottom = within(screen.getByRole('complementary', { name: 'Bottom workspace tools' }))
    const right = within(screen.getByRole('complementary', { name: 'Workspace tools' }))
    fireEvent.click(right.getByRole('button', { name: 'Temporary chat' }))
    fireEvent.click(bottom.getByRole('button', { name: 'Temporary chat' }))
    await waitFor(() => expect(calls('thread.history')).toHaveLength(2))

    fireEvent.click(bottom.getByRole('button', { name: 'Close bottom panel' }))
    await settle()
    expect(calls('sideChat.close')).toEqual([])

    send(right.getByRole('textbox', { name: 'Message temporary chat' }), 'still here?')
    await waitFor(() =>
      expect(calls('thread.sendTurn')).toEqual([
        expect.objectContaining({ threadId: 'side-1', text: 'still here?' }),
      ]),
    )
    await settle()
    expect(screen.queryByText(/no such thread/)).toBeNull()

    fireEvent.click(right.getByRole('button', { name: 'Close right panel' }))
    await waitFor(() => expect(calls('sideChat.close')).toEqual([{ threadId: 'side-1' }]))
  })

  it('keeps the side thread for a view that is still starting it', async () => {
    const gate = deferred()
    let starts = 0
    const { transport, calls } = sideChatServer(() => (++starts === 2 ? gate.promise : undefined))
    const props = {
      active: true,
      parentThreadId: 'main-1',
      parentStatus: 'idle' as const,
      transport,
      startOptions: { approval: 'ask' as const },
    }
    const first = render(<WorkspaceSideChat {...props} />)
    await waitFor(() => expect(calls('thread.history')).toHaveLength(1))
    const second = render(<WorkspaceSideChat {...props} />)
    await waitFor(() => expect(calls('sideChat.start')).toHaveLength(2))

    first.unmount()
    await settle()
    expect(calls('sideChat.close')).toEqual([])

    gate.resolve()
    await waitFor(() => expect(calls('thread.history')).toHaveLength(2))
    send(screen.getByRole('textbox', { name: 'Message temporary chat' }), 'still here?')
    await waitFor(() => expect(calls('thread.sendTurn')).toHaveLength(1))
    await settle()
    expect(screen.queryByText(/no such thread/)).toBeNull()

    second.unmount()
    await waitFor(() => expect(calls('sideChat.close')).toEqual([{ threadId: 'side-1' }]))
  })

  it('closes a side thread that finishes starting after its only view is gone', async () => {
    const gate = deferred()
    const { transport, calls } = sideChatServer(() => gate.promise)
    const view = render(
      <WorkspaceSideChat
        active
        parentThreadId="main-1"
        parentStatus="idle"
        transport={transport}
        startOptions={{ approval: 'ask' }}
      />,
    )
    await waitFor(() => expect(calls('sideChat.start')).toHaveLength(1))

    view.unmount()
    gate.resolve()

    await waitFor(() => expect(calls('sideChat.close')).toEqual([{ threadId: 'side-1' }]))
  })
})
