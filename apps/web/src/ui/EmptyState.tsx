import type { ReactNode } from 'react'
import '../styles/empty-state.css'

/** The one empty state: an icon, a one-line title, a short detail, then any actions. */
export function EmptyState(props: {
  icon?: ReactNode
  title: ReactNode
  detail?: ReactNode
  role?: 'alert' | 'status'
  className?: string
  /** Actions under the detail, e.g. Retry. */
  children?: ReactNode
}) {
  return (
    <div
      className={props.className ? `empty-state ${props.className}` : 'empty-state'}
      role={props.role}
    >
      {props.icon}
      <strong>{props.title}</strong>
      {props.detail ? <span>{props.detail}</span> : null}
      {props.children}
    </div>
  )
}
