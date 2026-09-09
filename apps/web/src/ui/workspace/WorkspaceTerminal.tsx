import { memo } from 'react'
import type { Transport } from '../../transport.js'
import { TerminalPane } from '../TerminalPane.js'
import { WorkspaceEmptyState } from './WorkspaceEmptyState.js'

export const WorkspaceTerminal = memo(function WorkspaceTerminal(props: {
  active: boolean
  transport: Transport
  threadId?: string | undefined
  projectPath?: string | undefined
  theme: 'light' | 'dark'
  onClose: () => void
}) {
  const target = props.threadId
    ? { threadId: props.threadId }
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
        transport={props.transport}
        {...target}
        theme={props.theme}
        mode="workspace"
        active={props.active}
        onClose={props.onClose}
      />
    </div>
  )
})
