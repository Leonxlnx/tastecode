import { lazy, Suspense, useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import type { ProviderId, ProviderUpdate } from '@harness/contracts'
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
import { SkeletonCode, SkeletonStatus } from './Skeleton.js'
import { CountReel, VersionReel, VersionTarget } from './VersionReel.js'

const InstallTerminal = lazy(() =>
  import('./InstallTerminal.js').then((module) => ({ default: module.InstallTerminal })),
)
const DISMISSED_KEY = 'harness.providerUpdates.dismissed'
let stylesLoaded = false

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

/** An update dismissed while it runs keeps running out of sight; only a
 *  failure needs the user again. Reopening the notice lifts that hold. */
function isDismissed(
  operation: UpdateOperation,
  dismissed: UpdateOperation | undefined,
  reopened: boolean,
) {
  if (!dismissed) return false
  if (dismissed === operation) return true
  return (
    !reopened &&
    dismissed.run === operation.run &&
    isBusy(dismissed) &&
    operation.phase !== 'failed'
  )
}

export function ProviderUpdateNotice(props: {
  transport: Transport
  onUpdated: () => void
  suppressed?: boolean
}) {
  const { store, state } = useProviderUpdates(props.transport)
  const [dismissed, setDismissed] = useState(readDismissed)
  const [dismissedOperations, setDismissedOperations] = useState<
    Partial<Record<ProviderId, UpdateOperation>>
  >({})
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
  const reopened = state.noticeRevision !== dismissedRevision
  const entries = state.updates.filter((entry) => {
    const operation = state.operations[entry.provider]
    if (operation && !isDismissed(operation, dismissedOperations[entry.provider], reopened))
      return true
    return (
      entry.updateAvailable &&
      (reopened || (!operation && dismissed[entry.provider] !== entry.latestVersion))
    )
  })
  const busy = entries.some((entry) => isBusy(state.operations[entry.provider]))
  // Releases are rare, so their styles stay out of the startup sheet and the
  // notice waits for them rather than flashing unstyled.
  const [styled, setStyled] = useState(stylesLoaded)
  const wanted = entries.length > 0
  useEffect(() => {
    if (!wanted || styled) return
    let live = true
    const done = () => {
      stylesLoaded = true
      if (live) setStyled(true)
    }
    import('../styles/provider-update-notice.css').then(done, done)
    return () => {
      live = false
    }
  }, [wanted, styled])
  const dismiss = () => {
    const next = { ...dismissed }
    for (const entry of entries) if (entry.latestVersion) next[entry.provider] = entry.latestVersion
    setDismissed(next)
    setDismissedOperations(state.operations)
    setDismissedRevision(state.noticeRevision)
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
    } catch {
      /* Keep the session preference when storage is unavailable. */
    }
  }
  const waiting = entries.filter(
    (entry) => state.operations[entry.provider]?.phase !== 'succeeded',
  ).length
  return (
    <NoticePresence
      className="notice notice--provider-update"
      role="status"
      visible={styled && entries.length > 0 && !props.suppressed}
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
      <div className="update-slip">
        <div className="update-slip__head">
          {waiting ? (
            <span>
              <CountReel value={waiting} />
              <span className="visually-hidden">{waiting}</span>
              {waiting === 1 ? ' update' : ' updates'}
            </span>
          ) : (
            <span>Up to date</span>
          )}
          <button
            className="ghost icon-button"
            type="button"
            aria-label="Dismiss provider updates"
            onClick={dismiss}
          >
            <X size={13} aria-hidden />
          </button>
        </div>
        {entries.map((entry, index) => (
          <ProviderUpdateItem
            key={entry.provider}
            index={index}
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
  index: number
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
  // The pair the wheels turn between is fixed when the update starts: the
  // check that confirms it already reports the new version as installed.
  const [versions, setVersions] = useState({
    from: update.currentVersion,
    to: update.latestVersion,
  })
  if (
    !busy &&
    !succeeded &&
    (versions.from !== update.currentVersion || versions.to !== update.latestVersion)
  )
    setVersions({ from: update.currentVersion, to: update.latestVersion })
  const from = versions.from ?? versions.to
  const to = versions.to ?? versions.from
  const key = updateKey(update.provider)
  const hasLog = Boolean(installState(key))
  const status = busy
    ? operation?.phase === 'verifying'
      ? 'Checking the new version…'
      : to
        ? `Updating to ${to}…`
        : 'Updating…'
    : succeeded
      ? `Updated to ${update.currentVersion}`
      : failed
        ? 'Update failed'
        : `${update.currentVersion} → ${update.latestVersion}`
  return (
    <div
      className="update-slip__item"
      aria-label={`${update.displayName} update`}
      data-phase={operation?.phase ?? 'available'}
      style={{ '--row': props.index } as CSSProperties}
    >
      <span className="update-slip__name">
        <ProviderIcon mark={providerMark(update.provider)} size={14} />
        {update.displayName}
      </span>
      <span className="update-slip__versions">
        {from && to ? (
          <>
            <VersionReel
              from={from}
              to={to}
              turn={busy ? 'turning' : succeeded ? 'turned' : 'rest'}
            />
            <span className="update-slip__arrow" aria-hidden>
              →
            </span>
            <VersionTarget from={from} to={to} />
          </>
        ) : null}
      </span>
      <span className="visually-hidden">{status}</span>
      <span className="update-slip__action">
        {busy || succeeded ? (
          <span className="update-slip__state" aria-hidden>
            {operation?.phase === 'verifying' ? 'Checking' : busy ? 'Updating' : 'Updated'}
          </span>
        ) : update.canUpdate ? (
          <button className="update-slip__button" type="button" onClick={props.onStart}>
            {failed ? 'Retry' : 'Update'}
          </button>
        ) : (
          <a
            className="update-slip__link"
            href={update.updateUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Update guide
            <ArrowUpRight size={12} aria-hidden />
          </a>
        )}
      </span>
      {operation?.error || hasLog ? (
        <span className="update-slip__note">
          {operation?.error ? <span role="alert">{operation.error}</span> : null}
          {hasLog ? (
            <button
              className="ghost"
              type="button"
              aria-expanded={details}
              aria-controls={detailsId}
              onClick={() => setDetails(!details)}
            >
              {details ? 'Hide details' : 'Details'}
            </button>
          ) : null}
        </span>
      ) : null}
      {details && hasLog ? (
        <div id={detailsId} className="update-slip__terminal">
          <Suspense
            fallback={
              <SkeletonStatus label="Opening details…" className="install-terminal">
                <SkeletonCode lines={5} />
              </SkeletonStatus>
            }
          >
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
