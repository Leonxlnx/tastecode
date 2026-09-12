// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TestTransport } from '../../test-transport.js'
import { WorkspaceTerminal } from './WorkspaceTerminal.js'

vi.mock('../TerminalPane.js', () => ({
  TerminalPane: (props: {
    terminalKey?: string
    threadId?: string
    projectPath?: string
    onClose?: () => void
  }) => (
    <button
      type="button"
      data-testid="terminal-pane"
      data-terminal-key={props.terminalKey}
      data-thread-id={props.threadId}
      data-project-path={props.projectPath}
      onClick={props.onClose}
    >
      Terminal pane
    </button>
  ),
}))

afterEach(cleanup)

describe('WorkspaceTerminal', () => {
  it('uses the selected project checkout when no chat exists', () => {
    render(
      <WorkspaceTerminal
        active
        terminalKey="terminal-1"
        transport={new TestTransport()}
        projectPath="/workspace/current-project"
        theme="dark"
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByTestId('terminal-pane').getAttribute('data-project-path')).toBe(
      '/workspace/current-project',
    )
    expect(screen.getByTestId('terminal-pane').getAttribute('data-terminal-key')).toBe('terminal-1')
    expect(screen.queryByText('Start a chat first')).toBeNull()
  })

  it('keeps an active chat attached to its exact checkout', () => {
    render(
      <WorkspaceTerminal
        active
        terminalKey="terminal-2"
        transport={new TestTransport()}
        threadId="thread-1"
        projectPath="/workspace/current-project"
        theme="dark"
        onClose={vi.fn()}
      />,
    )

    const terminal = screen.getByTestId('terminal-pane')
    expect(terminal.getAttribute('data-thread-id')).toBe('thread-1')
    expect(terminal.getAttribute('data-project-path')).toBeNull()
  })

  it('forwards shell exit closure to the workspace tab', () => {
    const onClose = vi.fn()
    render(
      <WorkspaceTerminal
        active
        terminalKey="terminal-3"
        transport={new TestTransport()}
        projectPath="/workspace/current-project"
        theme="dark"
        onClose={onClose}
      />,
    )

    screen.getByTestId('terminal-pane').click()
    expect(onClose).toHaveBeenCalledOnce()
  })
})
