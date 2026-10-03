import { IconTrash, IconX } from '@tabler/icons-react'
import { NoticePresence } from './NoticePresence.js'
import './archive-toast.css'

export function ArchiveToast(props: {
  count: number
  visible: boolean
  onUndo: () => void
  onDismiss: () => void
}) {
  return (
    <NoticePresence
      className="notice notice--archive"
      role="status"
      visible={props.visible}
      onDismiss={props.onDismiss}
      dismissKey={props.count}
    >
      <IconTrash size={16} stroke={1.7} aria-hidden />
      <span className="notice__text">
        {props.count > 1 ? `${props.count} chats deleted` : 'Chat deleted'}
      </span>
      <button className="archive-toast__undo" type="button" onClick={props.onUndo}>
        Undo
      </button>
      <button
        className="archive-toast__close"
        type="button"
        aria-label="Dismiss deletion notification"
        onClick={props.onDismiss}
      >
        <IconX size={15} stroke={1.7} aria-hidden />
      </button>
    </NoticePresence>
  )
}
