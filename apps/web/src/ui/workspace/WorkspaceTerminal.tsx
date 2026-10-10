import { memo } from 'react'
import type { Transport } from '../../transport.js'
import { TerminalPane } from '../TerminalPane.js'
import { WorkspaceEmptyState } from './WorkspaceEmptyState.js'

export const WorkspaceTerminal = memo(function WorkspaceTerminal(props: {
  active: boolean
  terminalKey: string
  transport: Transport
  threadId?: string | undefined
  projectPath?: string | undefined
  onClose: () => void
}) {
  // The server does not know a chat's provisional id while its first message
  // creates it; stay in the project checkout until the real id arrives.
  const threadId = props.threadId?.startsWith('pending:') ? undefined : props.threadId
  const target = threadId
    ? { threadId }
    : props.projectPath
      ? { projectPath: props.projectPath }
      : undefined
  if (!target) {
    return (
      <WorkspaceEmptyState
        kind="terminal"
        title="Choose a project"
        detail="The terminal opens in the selected project's current checkout."
      />
    )
  }
  return (
    <div className="workspace-terminal">
      <TerminalPane
        terminalKey={props.terminalKey}
        transport={props.transport}
        {...target}
        mode="workspace"
        active={props.active}
        onClose={props.onClose}
      />
    </div>
  )
})
