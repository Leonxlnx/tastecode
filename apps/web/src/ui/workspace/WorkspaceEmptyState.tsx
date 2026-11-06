import type { ReactNode } from 'react'
import {
  IconFileDiff as FileDiff,
  IconFolderOpen as FolderOpen,
  IconWorld as Globe2,
  IconWorldOff as GlobeOff,
  IconMessageCirclePlus as MessageCirclePlus,
  IconSubtask as Subtask,
  IconTerminal2 as SquareTerminal,
} from '@tabler/icons-react'
import { EmptyState } from '../EmptyState.js'

const ICONS = {
  review: FileDiff,
  terminal: SquareTerminal,
  browser: Globe2,
  'browser-failed': GlobeOff,
  files: FolderOpen,
  chat: MessageCirclePlus,
  agents: Subtask,
}

export function WorkspaceEmptyState(props: {
  kind: keyof typeof ICONS
  title: string
  detail: string
  /** Actions under the detail, e.g. Retry. */
  children?: ReactNode
}) {
  const Icon = ICONS[props.kind]
  return (
    <EmptyState
      icon={<Icon size={30} strokeWidth={1.6} aria-hidden />}
      title={props.title}
      detail={props.detail}
    >
      {props.children}
    </EmptyState>
  )
}
