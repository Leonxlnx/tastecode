import type { ReactNode } from 'react'
import type { ProviderStatus } from '@harness/contracts'
import { IconCheck as Check, IconExternalLink as ExternalLink } from '@tabler/icons-react'
import { RowIssue } from './RowIssue.js'
import { providerMark, type ProviderMark } from '../model-catalog.js'
import { ProviderIcon } from './ProviderIcon.js'
import { Skeleton } from './Skeleton.js'

export type ProviderIssue = { message: string; announce?: boolean | undefined }
export type ProviderAction = {
  label: string
  /** Names the action with its subject, where several rows offer the same label. */
  ariaLabel?: string | undefined
  onClick?: (() => void) | undefined
  href?: string | undefined
  disabled?: boolean | undefined
  danger?: boolean | undefined
  expanded?: boolean | undefined
  controls?: string | undefined
  /** Already done: drawn in the action's place as a settled label, not a button. */
  done?: boolean | undefined
}

/**
 * How the provider is wired to an account. The row draws it as the line
 * between the name and the status: solid when an account is attached, the
 * settings leader while the provider waits for one, nothing when the provider
 * is not on this machine.
 */
export type ProviderLink = 'connected' | 'open' | 'none'

/** A settings entity row: the provider's mark and name, its wire, status and actions. */
export function ProviderRow(props: {
  provider: ProviderStatus
  /** Overrides the provider's own mark, for an ACP agent drawn as itself. */
  mark?: ProviderMark | undefined
  status: ReactNode
  link?: ProviderLink | undefined
  live?: boolean
  issue?: ProviderIssue | undefined
  primary?: ProviderAction | undefined
  secondary?: ProviderAction | undefined
}) {
  return (
    <div
      className="provider-row"
      data-link={props.link ?? 'open'}
      data-live={props.live || undefined}
      data-fault={props.issue?.announce || undefined}
    >
      <div className="provider-row__mark" title={props.provider.version}>
        <ProviderIcon mark={props.mark ?? providerMark(props.provider.id)} size={18} />
      </div>
      <div className="provider-row__identity">
        <p className="set-entity__name">{props.provider.displayName}</p>
      </div>
      <span className="set-leader" aria-hidden />
      <div
        className="provider-row__status set-entity__status"
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

// Fixed per position: a placeholder that reshuffles between renders jitters.
const SKELETON_NAME_WIDTHS = [52, 88, 40] as const
const SKELETON_STATUS_WIDTHS = [148, 136, 64] as const

/** A provider row before the provider list has arrived, wired like one waiting for an account. */
export function ProviderRowSkeleton(props: { index: number }) {
  const at = props.index % SKELETON_NAME_WIDTHS.length
  return (
    <div className="provider-row provider-row--skeleton" data-link="open" aria-hidden>
      <div className="provider-row__mark">
        <Skeleton className="skeleton--block" width={16} height={16} />
      </div>
      <div className="provider-row__identity">
        <Skeleton className="provider-row__skeleton-name" width={SKELETON_NAME_WIDTHS[at]} />
      </div>
      <span className="set-leader" />
      <div className="provider-row__status set-entity__status">
        <Skeleton className="provider-row__skeleton-status" width={SKELETON_STATUS_WIDTHS[at]} />
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
  if (action.done) {
    return (
      <span className="provider-row__done">
        <Check size={13} aria-hidden />
        {action.label}
      </span>
    )
  }
  // Signing out reads the same in either slot; otherwise the secondary slot is quiet.
  const className = action.danger
    ? 'set-button set-button--danger'
    : props.tone === 'secondary'
      ? 'set-button set-button--quiet'
      : 'set-button'
  return action.href ? (
    <a
      className={className}
      href={action.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={action.ariaLabel}
    >
      {action.label}
      <ExternalLink size={12} aria-hidden />
    </a>
  ) : (
    <button
      className={className}
      type="button"
      disabled={action.disabled}
      aria-label={action.ariaLabel}
      aria-expanded={action.expanded}
      aria-controls={action.controls}
      onClick={action.onClick}
    >
      {action.label}
    </button>
  )
}
