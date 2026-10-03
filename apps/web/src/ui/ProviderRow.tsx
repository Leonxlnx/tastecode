import type { ReactNode } from 'react'
import type { ProviderStatus } from '@harness/contracts'
import { IconExternalLink as ExternalLink } from '@tabler/icons-react'
import { RowIssue } from './RowIssue.js'
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

/**
 * How the provider is wired to an account. The row draws it as the line
 * between the name and the status: solid when an account is attached, a
 * dotted leader while the provider waits for one, nothing when the provider
 * is not on this machine.
 */
export type ProviderLink = 'connected' | 'open' | 'none'

export function ProviderRow(props: {
  provider: ProviderStatus
  status: ReactNode
  link?: ProviderLink | undefined
  live?: boolean
  issue?: ProviderIssue | undefined
  primary?: ProviderAction | undefined
  secondary?: ProviderAction | undefined
}) {
  return (
    <div
      className="settings__row provider-row"
      data-link={props.link ?? 'open'}
      data-live={props.live || undefined}
      data-fault={props.issue?.announce || undefined}
    >
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
        {props.issue ? <RowIssue {...props.issue} label="Problem details" /> : null}
        <span className="provider-row__status-text">{props.status}</span>
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
