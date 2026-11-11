// @vitest-environment happy-dom
import type { BrowserCommand } from '@harness/contracts'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { deliverAgentBrowserEvent } from '../../browser-capability.js'
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

it('runs a command for its chat in the agent tab and answers it', async () => {
  const { transport, props, answers } = panel()
  const asked = command()
  act(() => deliverAgentBrowserEvent({ kind: 'command', command: asked }))
  expect(props.onOpen).toHaveBeenCalledOnce()
  await screen.findByTestId('browser-surface')
  expect(agent.link).toMatchObject({ command: asked, active: true })

  act(() => agent.link!.onResult({ commandId: asked.commandId, ok: true, title: 'Shop' }))
  expect(answers()).toEqual([{ commandId: asked.commandId, ok: true, title: 'Shop' }])
  expect(agent.link).toMatchObject({ command: undefined, active: true })

  // Another chat's command is not this window's to answer.
  act(() => deliverAgentBrowserEvent({ kind: 'command', command: command('chat-9') }))
  expect(answers()).toHaveLength(1)
})

it('refuses a second command while one runs, and drops a cancelled one', async () => {
  const { transport, answers } = panel()
  const first = command()
  act(() => deliverAgentBrowserEvent({ kind: 'command', command: first }))
  await screen.findByTestId('browser-surface')
  const second = command()
  act(() => deliverAgentBrowserEvent({ kind: 'command', command: second }))
  expect(answers()).toEqual([
    { commandId: second.commandId, ok: false, error: 'Another browser command is still running.' },
  ])
  act(() => deliverAgentBrowserEvent({ kind: 'cancel', commandId: first.commandId }))
  expect(agent.link?.command).toBeUndefined()
})

it('stops the agent for the rest of its turn when the user presses Stop', async () => {
  const { transport, answers } = panel()
  const running = command()
  act(() => deliverAgentBrowserEvent({ kind: 'command', command: running }))
  await screen.findByTestId('browser-surface')
  act(() => agent.link!.onStop())
  expect(agent.link).toMatchObject({ command: undefined, active: false })

  const later = command()
  act(() => deliverAgentBrowserEvent({ kind: 'command', command: later }))
  act(() =>
    transport.emit('thread.event', {
      threadId: 'chat-1',
      seq: 1,
      event: { type: 'turn.completed', turnId: 't1', status: 'interrupted' },
    }),
  )
  const allowed = command()
  act(() => deliverAgentBrowserEvent({ kind: 'command', command: allowed }))
  expect(answers()).toEqual([
    { commandId: running.commandId, ok: false, error: STOPPED },
    { commandId: later.commandId, ok: false, error: STOPPED },
  ])
  expect(agent.link?.command).toEqual(allowed)
})

it('keeps Stop for a chat while the panel shows another chat', async () => {
  const { view, props, transport, answers } = panel()
  act(() => deliverAgentBrowserEvent({ kind: 'command', command: command() }))
  await screen.findByTestId('browser-surface')
  act(() => agent.link!.onStop())
  view.rerender(<WorkspacePanel {...props} threadId="chat-2" />)

  // The other chat's agent is not stopped.
  const elsewhere = command('chat-2')
  act(() => deliverAgentBrowserEvent({ kind: 'command', command: elsewhere }))
  expect(agent.link?.command).toEqual(elsewhere)
  act(() => agent.link!.onResult({ commandId: elsewhere.commandId, ok: true }))

  view.rerender(<WorkspacePanel {...props} threadId="chat-1" />)
  const later = command()
  act(() => deliverAgentBrowserEvent({ kind: 'command', command: later }))
  expect(answers()).toContainEqual({ commandId: later.commandId, ok: false, error: STOPPED })

  // The stopped turn ends while another chat is shown, and the next one may use the browser.
  view.rerender(<WorkspacePanel {...props} threadId="chat-2" />)
  act(() =>
    transport.emit('thread.event', {
      threadId: 'chat-1',
      seq: 1,
      event: { type: 'turn.completed', turnId: 't1', status: 'interrupted' },
    }),
  )
  view.rerender(<WorkspacePanel {...props} threadId="chat-1" />)
  const allowed = command()
  act(() => deliverAgentBrowserEvent({ kind: 'command', command: allowed }))
  expect(agent.link?.command).toEqual(allowed)
})
