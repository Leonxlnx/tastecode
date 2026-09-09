import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react'
import type { ProviderStatus, ProviderUpdate } from '@harness/contracts'
import { IconArrowUp as ArrowUp, IconX as X } from '@tabler/icons-react'
import { useProviderUpdates } from '../provider-updates.js'
import { installState, updateKey } from '../provider-install.js'
import type { Transport } from '../transport.js'
import { NoticePresence } from './NoticePresence.js'

const InstallTerminal = lazy(() =>
  import('./InstallTerminal.js').then((module) => ({ default: module.InstallTerminal })),
)
const DISMISSED_KEY = 'harness.providerUpdates.dismissed'

function readDismissed(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '{}')
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter((entry) => typeof entry[1] === 'string'))
      : {}
  } catch {
    return {}
  }
}

export function ProviderUpdateNotice(props: {
  transport: Transport
  onOpenProviders: () => void
  suppressed?: boolean
}) {
  const { store, state } = useProviderUpdates(props.transport)
  const [dismissed, setDismissed] = useState(readDismissed)
  useEffect(() => store.monitor(), [store])
  const available = state.updates.filter(
    (entry) =>
      entry.updateAvailable &&
      dismissed[entry.provider] !== entry.latestVersion &&
      !state.operations[entry.provider],
  )
  const dismiss = () => {
    const next = { ...dismissed }
    for (const entry of available)
      if (entry.latestVersion) next[entry.provider] = entry.latestVersion
    setDismissed(next)
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
    } catch {
      /* Keep the session preference when storage is unavailable. */
    }
  }
  const first = available[0]
  return (
    <NoticePresence
      className="notice notice--provider-update"
      role="status"
      visible={Boolean(first) && !props.suppressed}
    >
      <ArrowUp size={15} aria-hidden />
      <span className="notice__text">
        {available.length === 1
          ? `${first?.displayName} ${first?.latestVersion} is available`
          : `${available.length} provider updates available`}
      </span>
      <button
        className="ghost"
        type="button"
        onClick={() => {
          dismiss()
          props.onOpenProviders()
        }}
      >
        View updates
      </button>
      <button
        className="ghost icon-button"
        type="button"
        aria-label="Dismiss provider updates"
        onClick={dismiss}
      >
        <X size={14} aria-hidden />
      </button>
    </NoticePresence>
  )
}

export function ProviderUpdateCheck(props: { transport: Transport }) {
  const { store, state } = useProviderUpdates(props.transport)
  useEffect(() => {
    void store.refresh()
  }, [store])
  const error =
    state.error ??
    (state.updates.some((entry) => entry.error)
      ? 'Some updates could not be checked. Try again.'
      : undefined)
  const count = state.updates.filter((entry) => entry.updateAvailable).length
  const summary = count
    ? `${count} update${count === 1 ? '' : 's'} available`
    : state.updates.some((entry) => entry.currentVersion)
      ? 'All providers are up to date'
      : 'Updates for your installed providers'
  return (
    <div className="provider-updates-check">
      <span role="status">{state.checking ? 'Checking for updates…' : (error ?? summary)}</span>
      <button
        className="settings__action"
        type="button"
        disabled={state.checking}
        onClick={() => void store.refresh(true)}
      >
        {state.checking ? 'Checking…' : 'Check for updates'}
      </button>
    </div>
  )
}

export function ProviderUpdateControl(props: {
  provider: ProviderStatus
  transport: Transport
  onUpdated: () => void
}) {
  const { store, state } = useProviderUpdates(props.transport)
  const update = state.updates.find((entry) => entry.provider === props.provider.id)
  const operation = state.operations[props.provider.id]
  const [details, setDetails] = useState(false)
  const detailsId = useId()
  const key = updateKey(props.provider.id)
  const { onUpdated } = props
  const notified = useRef(false)
  useEffect(() => {
    if (operation?.phase === 'succeeded' && !notified.current) {
      notified.current = true
      onUpdated()
    } else if (operation?.phase !== 'succeeded') notified.current = false
  }, [operation?.phase, onUpdated])
  if (!props.provider.installed || (!update?.updateAvailable && !operation)) return null
  const busy =
    operation?.phase === 'starting' ||
    operation?.phase === 'running' ||
    operation?.phase === 'verifying'
  const label = busy
    ? operation.phase === 'verifying'
      ? 'Checking…'
      : 'Updating…'
    : operation?.phase === 'failed'
      ? 'Retry update'
      : 'Update'
  const hasLog = Boolean(installState(key))
  return (
    <div className="provider-update" aria-label={`${props.provider.displayName} update`}>
      <div className="provider-update__summary">
        <span className="provider-update__version" role="status">
          {operation?.phase === 'succeeded'
            ? `Updated to ${update?.currentVersion}`
            : versionLabel(update)}
        </span>
        <div className="provider-update__actions">
          {hasLog ? (
            <button
              className="settings__action"
              type="button"
              aria-expanded={details}
              aria-controls={detailsId}
              onClick={() => setDetails(!details)}
            >
              {details ? 'Hide details' : 'Details'}
            </button>
          ) : null}
          {operation?.phase !== 'succeeded' ? (
            update?.canUpdate ? (
              <button
                className="settings__action provider-update__button"
                type="button"
                disabled={busy}
                onClick={() => void store.start(props.provider.id)}
              >
                <ArrowUp size={13} aria-hidden />
                {label}
              </button>
            ) : (
              <a
                className="settings__action"
                href={update?.updateUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Update guide
              </a>
            )
          ) : null}
        </div>
      </div>
      {operation?.error ? (
        <p className="provider-update__error" role="alert">
          {operation.error}
        </p>
      ) : null}
      {details && hasLog ? (
        <div id={detailsId} className="provider-terminal">
          <Suspense fallback={<span>Opening details…</span>}>
            <InstallTerminal
              transport={props.transport}
              installKey={key}
              ariaLabel={`${props.provider.displayName} update terminal`}
            />
          </Suspense>
        </div>
      ) : null}
    </div>
  )
}

function versionLabel(update: ProviderUpdate | undefined) {
  return update?.latestVersion
    ? `${update.currentVersion} → ${update.latestVersion}`
    : 'Update available'
}
