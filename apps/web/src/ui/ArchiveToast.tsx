import { IconTrash } from '@tabler/icons-react'
import { NoticeBody } from './Notice.js'
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
      tone="info"
      role="status"
      visible={props.visible}
      onDismiss={props.onDismiss}
      dismissKey={props.count}
      followComposer={false}
    >
      <NoticeBody
        tone="info"
        icon={<IconTrash className="notice-icon" size={16} stroke={1.7} aria-hidden />}
        actions={
          <button
            className="notice-action notice-action--primary"
            type="button"
            onClick={props.onUndo}
          >
            Undo
          </button>
        }
        onDismiss={props.onDismiss}
        dismissLabel="Dismiss deletion notification"
      >
        {props.count > 1 ? `${props.count} chats deleted` : 'Chat deleted'}
      </NoticeBody>
    </NoticePresence>
  )
}
