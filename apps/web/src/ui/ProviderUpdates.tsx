import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react'
import type { ProviderUpdate } from '@harness/contracts'
import {
  IconArrowUp as ArrowUp,
  IconArrowUpRight as ArrowUpRight,
  IconCheck as Check,
  IconLoader2 as Loader,
  IconRefresh as Refresh,
  IconX as X,
} from '@tabler/icons-react'
import { useProviderUpdates, type UpdateOperation } from '../provider-updates.js'
import { installState, updateKey } from '../provider-install.js'
import { providerMark } from '../model-catalog.js'
import type { Transport } from '../transport.js'
import { NoticePresence } from './NoticePresence.js'
import { ProviderIcon } from './ProviderIcon.js'
import { IconMorph } from './IconMorph.js'

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

function isBusy(operation: UpdateOperation | undefined) {
  return (
    operation?.phase === 'starting' ||
    operation?.phase === 'running' ||
    operation?.phase === 'verifying'
  )
}

export function ProviderUpdateNotice(props: {
  transport: Transport
  onUpdated: () => void
  suppressed?: boolean
}) {
  const { store, state } = useProviderUpdates(props.transport)
  const [dismissed, setDismissed] = useState(readDismissed)
  const [dismissedOperations, setDismissedOperations] = useState<UpdateOperation[]>([])
  const [dismissedRevision, setDismissedRevision] = useState(state.noticeRevision)
  const notified = useRef(new WeakSet<UpdateOperation>())
  const { onUpdated } = props
  useEffect(() => store.monitor(), [store])
  useEffect(() => {
    for (const operation of Object.values(state.operations)) {
      if (operation.phase === 'succeeded' && !notified.current.has(operation)) {
        notified.current.add(operation)
        onUpdated()
      }
    }
  }, [state.operations, onUpdated])
  const entries = state.updates.filter((entry) => {
    const operation = state.operations[entry.provider]
    if (isBusy(operation)) return true
    if (operation && !dismissedOperations.includes(operation)) return true
    return (
      entry.updateAvailable &&
      (state.noticeRevision !== dismissedRevision ||
        (!operation && dismissed[entry.provider] !== entry.latestVersion))
    )
  })
  const busy = entries.some((entry) => isBusy(state.operations[entry.provider]))
  const dismiss = () => {
    const next = { ...dismissed }
    for (const entry of entries) if (entry.latestVersion) next[entry.provider] = entry.latestVersion
    setDismissed(next)
    setDismissedOperations(Object.values(state.operations))
    setDismissedRevision(state.noticeRevision)
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
    } catch {
      /* Keep the session preference when storage is unavailable. */
    }
  }
  return (
    <NoticePresence
      className="notice notice--provider-update"
      role="status"
      visible={entries.length > 0 && !props.suppressed}
      onDismiss={dismiss}
      autoDismissPaused={busy}
      dismissKey={JSON.stringify(
        entries.map((entry) => [
          entry.provider,
          entry.latestVersion,
          state.operations[entry.provider]?.phase,
        ]),
      )}
    >
      <div className="provider-toast__header">
        <span>
          <ArrowUp size={14} aria-hidden />
          Provider updates
        </span>
        <button
          className="ghost icon-button"
          type="button"
          aria-label="Dismiss provider updates"
          disabled={busy}
          onClick={dismiss}
        >
          <X size={14} aria-hidden />
        </button>
      </div>
      <div className="provider-toast__list">
        {entries.map((entry) => (
          <ProviderUpdateItem
            key={entry.provider}
            update={entry}
            operation={state.operations[entry.provider]}
            transport={props.transport}
            onStart={() => void store.start(entry.provider)}
          />
        ))}
      </div>
    </NoticePresence>
  )
}

function ProviderUpdateItem(props: {
  update: ProviderUpdate
  operation: UpdateOperation | undefined
  transport: Transport
  onStart: () => void
}) {
  const { update, operation } = props
  const [details, setDetails] = useState(false)
  const detailsId = useId()
  const busy = isBusy(operation)
  const succeeded = operation?.phase === 'succeeded'
  const failed = operation?.phase === 'failed'
  const key = updateKey(update.provider)
  const hasLog = Boolean(installState(key))
  const status = busy
    ? operation?.phase === 'verifying'
      ? 'Checking the new version…'
      : 'Updating…'
    : succeeded
      ? `Updated to ${update.currentVersion}`
      : failed
        ? 'Update failed'
        : `${update.currentVersion} → ${update.latestVersion}`
  return (
    <div className="provider-toast__item" aria-label={`${update.displayName} update`}>
      <div className="provider-toast__row">
        <span className="provider-toast__mark">
          <ProviderIcon mark={providerMark(update.provider)} size={18} />
        </span>
        <div className="provider-toast__copy">
          <span className="provider-toast__name">{update.displayName}</span>
          <span className="provider-toast__status" data-failed={failed || undefined}>
            <IconMorph active={busy ? 1 : succeeded ? 2 : failed ? 3 : 0}>
              <ArrowUp size={12} aria-hidden />
              <Loader className="provider-update-spinner" size={12} aria-hidden />
              <Check size={12} aria-hidden />
              <X size={12} aria-hidden />
            </IconMorph>
            {status}
          </span>
        </div>
        {!busy && !succeeded ? (
          update.canUpdate ? (
            <button className="ghost provider-toast__action" type="button" onClick={props.onStart}>
              {failed ? 'Retry' : 'Update'}
            </button>
          ) : (
            <a
              className="ghost provider-toast__action"
              href={update.updateUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Update guide
              <ArrowUpRight size={12} aria-hidden />
            </a>
          )
        ) : null}
      </div>
      {operation?.error ? (
        <p className="provider-toast__error" role="alert">
          {operation.error}
        </p>
      ) : null}
      {hasLog ? (
        <button
          className="ghost provider-toast__details"
          type="button"
          aria-expanded={details}
          aria-controls={detailsId}
          onClick={() => setDetails(!details)}
        >
          {details ? 'Hide details' : 'Details'}
        </button>
      ) : null}
      {details && hasLog ? (
        <div id={detailsId} className="provider-toast__terminal">
          <Suspense fallback={<span>Opening details…</span>}>
            <InstallTerminal
              transport={props.transport}
              installKey={key}
              appearance="notice"
              ariaLabel={`${update.displayName} update terminal`}
            />
          </Suspense>
        </div>
      ) : null}
    </div>
  )
}

export function ProviderUpdateCheck(props: { transport: Transport }) {
  const { store, state } = useProviderUpdates(props.transport)
  useEffect(() => {
    void store.refresh()
  }, [store])
  const error =
    state.error ??
    (state.updates.some((entry) => entry.error) ? 'Could not check all updates' : undefined)
  const count = state.updates.filter((entry) => entry.updateAvailable).length
  const busy = Object.values(state.operations).some(isBusy)
  const failed = Object.values(state.operations).some((entry) => entry.phase === 'failed')
  const review = count > 0 || busy || failed
  const summary = busy
    ? 'Update in progress'
    : failed
      ? 'Update needs attention'
      : count
        ? `${count} update${count === 1 ? '' : 's'} available`
        : 'Up to date'
  return (
    <div className="provider-updates-check">
      {review ? (
        <button
          className="ghost provider-updates-check__review"
          type="button"
          onClick={store.showNotice}
        >
          <IconMorph active={busy ? 1 : 0}>
            <ArrowUp size={13} aria-hidden />
            <Loader className="provider-update-spinner" size={13} aria-hidden />
          </IconMorph>
          {summary}
          <ArrowUpRight size={12} aria-hidden />
        </button>
      ) : (
        <span role="status">
          {!state.checking && !error ? <Check size={13} aria-hidden /> : null}
          {state.checking
            ? 'Checking for updates…'
            : (error ??
              (state.updates.some((entry) => entry.currentVersion) ? summary : 'Provider updates'))}
        </span>
      )}
      <button
        className="ghost provider-updates-check__refresh"
        type="button"
        disabled={state.checking}
        onClick={() => void store.refresh(true)}
      >
        <IconMorph active={state.checking ? 1 : 0}>
          <Refresh size={13} aria-hidden />
          <Loader className="provider-update-spinner" size={13} aria-hidden />
        </IconMorph>
        Check for updates
      </button>
    </div>
  )
}
