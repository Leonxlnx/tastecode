import type { ReactNode } from 'react'

const STATE_LABELS = {
  checking: 'Checking',
  ready: 'Ready',
  'update-available': 'Update available',
  'setup-needed': 'Setup needed',
  manual: 'Manual update',
  unavailable: 'Unavailable',
  failed: 'Failed',
} as const

export type SettingsState = keyof typeof STATE_LABELS

export function StateLabel(props: {
  state: SettingsState
  detail?: string | undefined
  live?: boolean | undefined
}) {
  const label = STATE_LABELS[props.state]
  const title = props.detail ? `${label} · ${props.detail}` : label
  return (
    <span
      className={`state-label is-${props.state}`}
      role={props.live ? 'status' : undefined}
      aria-atomic={props.live || undefined}
      // aria-label is only valid with a role; a plain span must not carry one.
      aria-label={props.live ? title : undefined}
      title={title}
    >
      <span className="state-label__state">{label}</span>
      {props.detail ? (
        <span className="state-label__detail">
          <span aria-hidden> · </span>
          {props.detail}
        </span>
      ) : null}
    </span>
  )
}

export function SettingsMeta(props: { children: ReactNode }) {
  return <span className="settings-meta">{props.children}</span>
}
