/**
 * The profile menu that opens from the account card, as in the app
 * (apps/web/src/ui/AccountLimits.tsx + the account menu in Sidebar.tsx;
 * styles in account-limits.css and app.css .account-menu__*): plan limits
 * per provider, each collapsible, then Edit profile and Settings.
 * Numbers mirror the app's design sandbox. Styles: src/styles/menu.css.
 */
import {
  IconAsterisk,
  IconBolt,
  IconChevronRight,
  IconHexagon,
  IconRefresh,
  IconSettings,
  IconUser,
  type Icon,
} from '@tabler/icons-react'
import { useState, type CSSProperties } from 'react'

/* The app shows each provider's brand mark; these are neutral stand-ins. */
const SOURCES: { name: string; mark: Icon; weekly: number; session: number; pace: number; resets: string }[] = [
  { name: 'Claude Code', mark: IconAsterisk, weekly: 39, session: 72, pace: 55, resets: 'Resets Thu 09:00' },
  { name: 'Codex', mark: IconHexagon, weekly: 56, session: 88, pace: 62, resets: 'Resets Fri 14:30' },
  { name: 'Grok', mark: IconBolt, weekly: 78, session: 94, pace: 70, resets: 'Resets Mon 08:00' },
]

export function AccountMenu({ close }: { close: () => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [refreshing, setRefreshing] = useState(false)

  return (
    <>
      <section className="account-menu__usage" aria-label="Plan limits">
        {SOURCES.map((s, i) => {
          const expanded = Boolean(open[s.name])
          return (
            <section key={s.name} className={`account-menu__source${expanded ? '' : ' is-closed'}`}>
              <div className="account-menu__source-head">
                <h3>
                  <button
                    type="button"
                    className="account-menu__source-toggle"
                    aria-expanded={expanded}
                    onClick={() => setOpen((o) => ({ ...o, [s.name]: !o[s.name] }))}
                  >
                    <s.mark size={13} stroke={2} />
                    <span>{s.name}</span>
                    <IconChevronRight size={12} stroke={2} className="account-menu__source-chevron" />
                  </button>
                </h3>
                {i === 0 && (
                  <button
                    type="button"
                    className={`account-menu__refresh${refreshing ? ' is-busy' : ''}`}
                    aria-label="Refresh plan limits"
                    onClick={() => {
                      setRefreshing(true)
                      setTimeout(() => setRefreshing(false), 1200)
                    }}
                  >
                    <IconRefresh size={13} stroke={1.75} />
                  </button>
                )}
              </div>
              {expanded ? (
                <div className="account-menu__source-body">
                  <Limit label="5-hour limit" left={s.session} pace={s.pace} />
                  <Limit label="Weekly limit" left={s.weekly} pace={s.pace} note={s.resets} />
                </div>
              ) : (
                <Limit label="Weekly limit" left={s.weekly} pace={s.pace} inline />
              )}
            </section>
          )
        })}
      </section>
      <div className="account-menu__actions">
        <button type="button" className="menu__item" onClick={close}>
          <span className="menu__name">
            <span className="menu__label">
              <IconUser size={14} stroke={1.75} aria-hidden />
              <span>Edit profile</span>
            </span>
          </span>
        </button>
        <button type="button" className="menu__item" aria-keyshortcuts="Control+," onClick={close}>
          <span className="menu__name">
            <span className="menu__label">
              <IconSettings size={14} stroke={1.75} aria-hidden />
              <span>Settings</span>
            </span>
            <span className="menu__meta menu__shortcut">Ctrl ,</span>
          </span>
        </button>
      </div>
    </>
  )
}

/** One limit: label, a thin bar of what's left with an even-pace tick, and the value. */
function Limit(props: { label: string; left: number; pace: number; inline?: boolean; note?: string }) {
  return (
    <div className={`account-menu__limit${props.inline ? ' is-inline' : ''}`}>
      <div className="account-menu__limit-row">
        <span className="account-menu__limit-label">{props.label}</span>
        {props.inline && <Bar left={props.left} pace={props.pace} />}
        <span className="account-menu__limit-value">{props.left}% left</span>
      </div>
      {!props.inline && <Bar left={props.left} pace={props.pace} />}
      {props.note && <span className="account-menu__limit-note">{props.note}</span>}
    </div>
  )
}

function Bar({ left, pace }: { left: number; pace: number }) {
  return (
    <div
      className="account-menu__limit-bar"
      role="progressbar"
      aria-valuenow={left}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{ '--limit-fill': left / 100 } as CSSProperties}
    >
      <span />
      <span className="account-menu__limit-pace" style={{ left: `${pace}%` }} />
    </div>
  )
}
