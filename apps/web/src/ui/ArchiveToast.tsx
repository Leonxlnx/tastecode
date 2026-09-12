import { IconArchive, IconX } from '@tabler/icons-react'
import { NoticePresence } from './NoticePresence.js'
import './archive-toast.css'

export function ArchiveToast(props: {
  count: number
  visible: boolean
  onView: () => void
  onUndo: () => void
  onDismiss: () => void
}) {
  return (
    <NoticePresence className="notice notice--archive" role="status" visible={props.visible}>
      <IconArchive size={16} stroke={1.7} aria-hidden />
      <span className="notice__text">{props.count > 1 ? 'Archived chats' : 'Archived chat'}</span>
      <button className="archive-toast__view" type="button" onClick={props.onView}>
        View
      </button>
      <button className="archive-toast__undo" type="button" onClick={props.onUndo}>
        Undo
      </button>
      <button
        className="archive-toast__close"
        type="button"
        aria-label="Dismiss archive notification"
        onClick={props.onDismiss}
      >
        <IconX size={15} stroke={1.7} aria-hidden />
      </button>
    </NoticePresence>
  )
}
