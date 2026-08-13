import { FileDiff, FolderOpen, Globe2, MessageCirclePlus, SquareTerminal } from 'lucide-react'

const ICONS = {
  review: FileDiff,
  terminal: SquareTerminal,
  browser: Globe2,
  files: FolderOpen,
  chat: MessageCirclePlus,
}

export function WorkspaceEmptyState(props: {
  kind: keyof typeof ICONS
  title: string
  detail: string
}) {
  const Icon = ICONS[props.kind]
  return (
    <div className="workspace-empty">
      <Icon size={30} strokeWidth={1.6} aria-hidden />
      <strong>{props.title}</strong>
      <span>{props.detail}</span>
    </div>
  )
}
