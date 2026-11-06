// @vitest-environment happy-dom
import type { BrowserCommand } from '@harness/contracts'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TestTransport } from '../../test-transport.js'
import type { AgentBrowserLink } from './WorkspaceBrowser.js'

vi.mock('../../bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../bridge.js')>()),
  isDesktop: true,
}))

// The agent's tab hands its link to the test, the way the real guest would run commands.
const agent = vi.hoisted(() => ({ link: undefined as AgentBrowserLink | undefined }))
vi.mock('./WorkspaceBrowser.js', () => ({
  WorkspaceBrowser: (props: { agent?: AgentBrowserLink }) => {
    if (props.agent) agent.link = props.agent
    return <div data-testid="browser-surface" />
  },
}))

const { WorkspacePanel } = await import('./WorkspacePanel.js')

afterEach(() => {
  cleanup()
  agent.link = undefined
})

const STOPPED = "The user stopped the agent's use of the browser for this turn."
let next = 0
const command = (threadId = 'chat-1'): BrowserCommand => ({
  threadId,
  commandId: `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
  action: 'screenshot',
})

function panel(threadId = 'chat-1') {
  const transport = new TestTransport(async () => ({}))
  const props = {
    open: false,
    expanded: false,
    width: 400,
    transport,
    theme: 'dark' as const,
    sideChatParentStatus: 'idle' as const,
    sideChatStartOptions: { approval: 'ask' as const },
    nativeSurfacesVisible: true,
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onWidthChange: vi.fn(),
  }
  const view = render(<WorkspacePanel {...props} threadId={threadId} />)
  const answers = () =>
    transport.requests
      .filter(({ method }) => method === 'browser.result')
      .map(({ params }) => params)
  const announced = () =>
    transport.requests
      .filter(({ method }) => method === 'client.capabilities')
      .map(({ params }) => (params as { browserThreads?: string[] }).browserThreads)
  return { transport, props, view, answers, announced }
}

it('tells the server which chat this window shows, and again when that changes', () => {
  const { props, view, announced } = panel('chat-1')
  view.rerender(<WorkspacePanel {...props} threadId="chat-2" />)
  view.unmount()
  expect(announced()).toEqual([['chat-1'], [], ['chat-2'], []])
})

it('runs a command for its chat in the agent tab and answers it', async () => {
  const { transport, props, answers } = panel()
  const asked = command()
  act(() => transport.emit('browser.command', asked))
  expect(props.onOpen).toHaveBeenCalledOnce()
  await screen.findByTestId('browser-surface')
  expect(agent.link).toMatchObject({ command: asked, active: true })

  act(() => agent.link!.onResult({ commandId: asked.commandId, ok: true, title: 'Shop' }))
  expect(answers()).toEqual([{ commandId: asked.commandId, ok: true, title: 'Shop' }])
  expect(agent.link).toMatchObject({ command: undefined, active: true })

  // Another chat's command is not this window's to answer.
  act(() => transport.emit('browser.command', command('chat-9')))
  expect(answers()).toHaveLength(1)
})

it('refuses a second command while one runs, and drops a cancelled one', async () => {
  const { transport, answers } = panel()
  const first = command()
  act(() => transport.emit('browser.command', first))
  await screen.findByTestId('browser-surface')
  const second = command()
  act(() => transport.emit('browser.command', second))
  expect(answers()).toEqual([
    { commandId: second.commandId, ok: false, error: 'Another browser command is still running.' },
  ])
  act(() => transport.emit('browser.commandCancelled', { commandId: first.commandId }))
  expect(agent.link?.command).toBeUndefined()
})

it('stops the agent for the rest of its turn when the user presses Stop', async () => {
  const { transport, answers } = panel()
  const running = command()
  act(() => transport.emit('browser.command', running))
  await screen.findByTestId('browser-surface')
  act(() => agent.link!.onStop())
  expect(agent.link).toMatchObject({ command: undefined, active: false })

  const later = command()
  act(() => transport.emit('browser.command', later))
  act(() =>
    transport.emit('thread.event', {
      threadId: 'chat-1',
      seq: 1,
      event: { type: 'turn.completed', turnId: 't1', status: 'interrupted' },
    }),
  )
  const allowed = command()
  act(() => transport.emit('browser.command', allowed))
  expect(answers()).toEqual([
    { commandId: running.commandId, ok: false, error: STOPPED },
    { commandId: later.commandId, ok: false, error: STOPPED },
  ])
  expect(agent.link?.command).toEqual(allowed)
})
