import { useCallback, useState } from 'react'
import {
  IconAlertCircle,
  IconArrowRight,
  IconChevronDown,
  IconInfoCircle,
  IconX,
} from '@tabler/icons-react'
import { Menu, MenuItem } from './Menu.js'
import '../styles/composer-provider-shelf.css'
import '../styles/notice.css'

export type ComposerError = {
  id: string
  message: string
  role?: 'alert' | 'status'
  /** A note rather than a problem: drawn neutral, never red. */
  tone?: 'info'
  action?: { label: string; run: () => void }
  /** One action with several places to go, offered as a menu instead of a button. */
  choices?: {
    label: string
    options: ReadonlyArray<{
      id: string
      label: string
      detail?: string | undefined
      run: () => void
    }>
  }
  /** Opens the feedback dialog with this error attached. Never sends anything itself. */
  report?: () => void
  dismiss?: () => void
}

export function useComposerError() {
  const [error, setError] = useState<ComposerError>()
  const report = useCallback((message: string | undefined) => {
    setError(message ? { id: crypto.randomUUID(), message } : undefined)
  }, [])
  return [error, report] as const
}

/** Dismissal belongs to an occurrence, so a later failure can be shown again. */
export function ComposerErrors({
  errors,
  visible = true,
  onDismiss,
}: {
  errors: readonly ComposerError[]
  visible?: boolean
  onDismiss?: () => void
}) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  const visibleErrors = errors.filter(
    (error, index) =>
      !dismissed.has(error.id) &&
      !errors
        .slice(0, index)
        .some((previous) => previous.message === error.message && !dismissed.has(previous.id)),
  )
  if (!visible || visibleErrors.length === 0) return null
  return (
    <div
      className={`composer__shelf composer__provider-shelf${visibleErrors.every((error) => error.tone === 'info') ? ' composer__provider-shelf--info' : ''}`}
      aria-label="Errors"
    >
      {visibleErrors.map((error) => (
        <div
          className={`composer__error-row${error.tone === 'info' ? ' composer__error-row--info' : ''}`}
          data-notice-tone={error.tone === 'info' ? 'info' : 'error'}
          key={error.id}
        >
          {error.tone === 'info' ? (
            <IconInfoCircle className="notice-icon" size={16} stroke={1.7} aria-hidden />
          ) : (
            <IconAlertCircle className="notice-icon" size={16} stroke={1.7} aria-hidden />
          )}
          <span className="composer__provider-message notice__text" role={error.role ?? 'alert'}>
            {error.message}
          </span>
          {error.action ? (
            <button className="notice-action" type="button" onClick={error.action.run}>
              {error.action.label}
              <IconArrowRight size={13} aria-hidden />
            </button>
          ) : error.choices ? (
            <Menu
              align="right"
              drop="up"
              triggerClassName="notice-action"
              panelLabel={error.choices.label}
              trigger={() => (
                <>
                  {error.choices!.label}
                  <IconChevronDown size={13} aria-hidden />
                </>
              )}
            >
              {(close) =>
                error.choices!.options.map((option) => (
                  <MenuItem
                    key={option.id}
                    title={option.label}
                    detail={option.detail}
                    icon={null}
                    onClick={() => {
                      close()
                      option.run()
                    }}
                  />
                ))
              }
            </Menu>
          ) : null}
          {error.report && error.role !== 'status' ? (
            <button
              className="notice-action notice-action--quiet"
              type="button"
              title="Send this error to the TasteCode team"
              onClick={error.report}
            >
              Report
            </button>
          ) : null}
          <button
            className="notice-close"
            type="button"
            aria-label={`Dismiss error: ${error.message}`}
            title="Dismiss error"
            onClick={() => {
              const matching = errors.filter((entry) => entry.message === error.message)
              setDismissed(
                (current) =>
                  new Set([...current, ...matching.map((entry) => entry.id)].slice(-100)),
              )
              for (const entry of matching) entry.dismiss?.()
              onDismiss?.()
            }}
          >
            <IconX size={15} stroke={1.7} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  )
}
