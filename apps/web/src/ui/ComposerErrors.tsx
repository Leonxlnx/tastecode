import { useCallback, useState } from 'react'
import { IconAlertCircle, IconArrowRight, IconX } from '@tabler/icons-react'
import '../styles/composer-provider-shelf.css'

export type ComposerError = {
  id: string
  message: string
  role?: 'alert' | 'status'
  action?: { label: string; run: () => void }
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
    <div className="composer__shelf composer__provider-shelf" aria-label="Errors">
      {visibleErrors.map((error) => (
        <div className="composer__error-row" key={error.id}>
          <IconAlertCircle size={15} strokeWidth={1.8} aria-hidden />
          <span className="composer__provider-message" role={error.role ?? 'alert'}>
            {error.message}
          </span>
          {error.action ? (
            <button className="composer__provider-action" type="button" onClick={error.action.run}>
              {error.action.label}
              <IconArrowRight size={13} aria-hidden />
            </button>
          ) : null}
          <button
            className="composer__error-dismiss"
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
            <IconX size={14} strokeWidth={1.8} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  )
}
