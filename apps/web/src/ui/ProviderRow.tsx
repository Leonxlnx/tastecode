import { useId, type ReactNode } from 'react'
import type { ProviderStatus } from '@harness/contracts'
import {
  IconAlertCircle as CircleAlert,
  IconExternalLink as ExternalLink,
} from '@tabler/icons-react'
import { providerMark } from '../model-catalog.js'
import { ProviderIcon } from './ProviderIcon.js'

export type ProviderIssue = { message: string; announce?: boolean | undefined }
export type ProviderAction = {
  label: string
  onClick?: (() => void) | undefined
  href?: string | undefined
  disabled?: boolean | undefined
  danger?: boolean | undefined
  expanded?: boolean | undefined
  controls?: string | undefined
}

export function ProviderRow(props: {
  provider: ProviderStatus
  status: ReactNode
  live?: boolean
  issue?: ProviderIssue | undefined
  primary?: ProviderAction | undefined
  secondary?: ProviderAction | undefined
}) {
  return (
    <div className="settings__row provider-row">
      <div className="provider-row__mark" title={props.provider.version}>
        <ProviderIcon mark={providerMark(props.provider.id)} size={18} />
      </div>
      <div className="provider-row__identity">
        <p className="settings__row-title">{props.provider.displayName}</p>
      </div>
      <div
        className="provider-row__status"
        role={props.live ? 'status' : undefined}
        aria-atomic={props.live || undefined}
      >
        {props.status}
      </div>
      <div className="provider-row__issue">
        {props.issue ? <ProviderRowIssue {...props.issue} /> : null}
      </div>
      <div className="provider-row__secondary">
        <ProviderRowAction action={props.secondary} tone="secondary" />
      </div>
      <div className="provider-row__primary">
        <ProviderRowAction action={props.primary} tone="primary" />
      </div>
    </div>
  )
}

function ProviderRowAction(props: {
  action: ProviderAction | undefined
  tone: 'primary' | 'secondary'
}) {
  const action = props.action
  if (!action) return null
  const className = `settings__action is-${props.tone}${action.danger ? ' is-danger' : ''}`
  return action.href ? (
    <a className={className} href={action.href} target="_blank" rel="noopener noreferrer">
      {action.label}
      <ExternalLink size={12} aria-hidden />
    </a>
  ) : (
    <button
      className={className}
      type="button"
      disabled={action.disabled}
      aria-expanded={action.expanded}
      aria-controls={action.controls}
      onClick={action.onClick}
    >
      {action.label}
    </button>
  )
}

function ProviderRowIssue(props: ProviderIssue) {
  const tooltipId = useId()
  return (
    <span className="row-issue">
      {props.announce ? (
        <span className="visually-hidden" role="alert">
          {props.message}
        </span>
      ) : null}
      <button
        type="button"
        className="row-issue__dot"
        aria-label="Problem details"
        aria-describedby={tooltipId}
      >
        <CircleAlert size={14} aria-hidden />
      </button>
      <span id={tooltipId} role="tooltip" className="row-issue__bubble">
        {props.message}
      </span>
    </span>
  )
}
