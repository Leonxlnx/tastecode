import type { ReactNode } from 'react'
import {
  IconAlertCircle,
  IconCircleCheck,
  IconInfoCircle,
  IconLoader2,
  IconX,
} from '@tabler/icons-react'
import '../styles/notice.css'

export type NoticeTone = 'info' | 'success' | 'error' | 'progress'

const ICONS = {
  info: IconInfoCircle,
  success: IconCircleCheck,
  error: IconAlertCircle,
  progress: IconLoader2,
} as const

/**
 * The one notice: the tone's icon, the message, its actions and a close button. The element
 * around it decides where it sits (a toast, the composer shelf, a settings page) and carries
 * `data-notice-tone`, which colours the icon.
 */
export function NoticeBody(props: {
  tone: NoticeTone
  /** Replaces the tone's icon, e.g. a trash can on a deleted chat. */
  icon?: ReactNode
  children: ReactNode
  /** Buttons after the message; `notice-action` styles them. */
  actions?: ReactNode
  onDismiss?: (() => void) | undefined
  dismissLabel?: string
  dismissTitle?: string
}) {
  const Icon = ICONS[props.tone]
  return (
    <>
      {props.icon ?? (
        <Icon
          className={props.tone === 'progress' ? 'notice-icon spinner' : 'notice-icon'}
          size={16}
          stroke={1.7}
          aria-hidden
        />
      )}
      <span className="notice__text">{props.children}</span>
      {props.actions}
      {props.onDismiss ? (
        <button
          className="notice-close"
          type="button"
          aria-label={props.dismissLabel ?? 'Dismiss'}
          title={props.dismissTitle}
          onClick={props.onDismiss}
        >
          <IconX size={15} stroke={1.7} aria-hidden />
        </button>
      ) : null}
    </>
  )
}
