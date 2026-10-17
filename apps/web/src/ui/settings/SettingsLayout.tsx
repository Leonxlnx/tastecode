import { useId, type ReactNode } from 'react'
import {
  IconAlertCircle as AlertCircle,
  IconInfoCircle as Info,
  IconLoader2 as LoaderCircle,
} from '@tabler/icons-react'
import '../../styles/settings-system.css'

/*
 * Settings v1: every tab is one page header, open sections and leader rows.
 * Nothing here paints a card; cards stay for dashboards and forms.
 */

function classes(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(' ')
}

/** The tab itself: its title (the nav label), an optional line under it and actions on its right. */
export function SettingsPage(props: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  className?: string | undefined
  children: ReactNode
}) {
  const titleId = useId()
  return (
    <section
      className={classes('settings__panel set-page', props.className)}
      aria-labelledby={titleId}
    >
      <header className="set-page__head">
        <div className="set-page__heading">
          <h1 className="settings__title" id={titleId}>
            {props.title}
          </h1>
          {props.description ? <p className="set-page__description">{props.description}</p> : null}
        </div>
        {props.actions ? <div className="set-page__actions">{props.actions}</div> : null}
      </header>
      {props.children}
    </section>
  )
}

/**
 * A run of rows under a quiet heading, with an optional note and one quiet
 * action. A section without a visible heading can still be named for
 * assistive technology with `label`.
 */
export function SettingsSection(props: {
  title?: ReactNode
  label?: string | undefined
  note?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  const titleId = useId()
  const titled = props.title !== undefined
  return (
    <section
      className="set-section"
      aria-labelledby={titled ? titleId : undefined}
      aria-label={titled ? undefined : props.label}
    >
      {titled || props.action ? (
        <div className="set-section__head">
          {titled ? (
            <h2 className="set-section__title" id={titleId}>
              {props.title}
            </h2>
          ) : null}
          {props.action ? <div className="set-section__action">{props.action}</div> : null}
        </div>
      ) : null}
      {props.note ? <p className="set-section__note">{props.note}</p> : null}
      {props.children}
    </section>
  )
}

export type SettingsRowTone = 'muted' | 'active' | 'error'

/**
 * One setting: its name, a dotted leader that lights while the row is hovered
 * or focused, and the value at the far edge. A note runs under the whole row.
 */
export function SettingsRow(props: {
  name: ReactNode
  note?: ReactNode
  tone?: SettingsRowTone | undefined
  className?: string | undefined
  children?: ReactNode
}) {
  return (
    <div className={classes('set-row', props.className)} data-tone={props.tone}>
      <p className="set-row__name">{props.name}</p>
      <span className="set-leader" aria-hidden />
      <div className="set-row__value">{props.children}</div>
      {props.note ? <p className="set-row__note">{props.note}</p> : null}
    </div>
  )
}

const NOTICE_ICONS = { info: Info, progress: LoaderCircle, error: AlertCircle } as const

/** A page-level message above the rows it concerns. A row-level error stays a RowIssue. */
export function SettingsNotice(props: {
  tone: keyof typeof NOTICE_ICONS
  action?: ReactNode
  children: ReactNode
}) {
  const Icon = NOTICE_ICONS[props.tone]
  return (
    <div
      className="set-notice"
      data-tone={props.tone}
      role={props.tone === 'error' ? 'alert' : 'status'}
    >
      <Icon className="set-notice__icon" size={14} aria-hidden />
      <p className="set-notice__text">{props.children}</p>
      {props.action ? <div className="set-notice__action">{props.action}</div> : null}
    </div>
  )
}

/** Nothing to list yet: one plain line where the rows would start, never a centred card. */
export function SettingsEmpty(props: {
  icon?: ReactNode
  title: ReactNode
  detail?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="set-empty">
      {props.icon ? (
        <span className="set-empty__icon" aria-hidden>
          {props.icon}
        </span>
      ) : null}
      <div className="set-empty__copy">
        <p className="set-empty__title">{props.title}</p>
        {props.detail ? <p className="set-empty__detail">{props.detail}</p> : null}
        {props.action ? <div className="set-empty__action">{props.action}</div> : null}
      </div>
    </div>
  )
}
