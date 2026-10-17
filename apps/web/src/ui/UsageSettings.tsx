import { useState, useSyncExternalStore } from 'react'
import type { ResultOf, UsageHistoryRange } from '@harness/contracts'
import { IconAlertCircle as CircleAlert, IconRefresh as RefreshCw } from '@tabler/icons-react'
import { providerDisplayName } from '../provider-presentation.js'
import '../styles/usage-page.css'
import type { Transport } from '../transport.js'
import { useUsageHistory } from '../usage-history-state.js'
import { compactRelativeTime, readSessionClock, subscribeSessionClock } from './session-clock.js'
import { SettingsNotice, SettingsPage } from './settings/SettingsLayout.js'
import { SettingsSegmented } from './settings/SettingsSegmented.js'
import { UsageLimits, type PlanLimitsSource } from './usage/UsageLimits.js'
import { formatDateRange, formatInteger } from './usage/usage-format.js'

const RANGE_OPTIONS = [
  { value: '7d', label: '7 days', period: 'Last 7 days' },
  { value: '30d', label: '30 days', period: 'Last 30 days' },
  { value: '90d', label: '90 days', period: 'Last 90 days' },
  { value: '365d', label: '1 year', period: 'Last year' },
  { value: 'all', label: 'All', period: 'All time' },
] as const satisfies ReadonlyArray<{ value: UsageHistoryRange; label: string; period: string }>

function isRange(value: string): value is UsageHistoryRange {
  return RANGE_OPTIONS.some((option) => option.value === value)
}

/**
 * Usage: plan limits first, since they are what can stop work today; then
 * the local history of the chosen period and where the numbers come from.
 */
export function UsageSettings(props: {
  transport: Transport
  /** The app's plan-limit owner; without one the page shows only the local history. */
  limits?: PlanLimitsSource | undefined
}) {
  const [range, setRange] = useState<UsageHistoryRange>('30d')
  const { data, loading, error, refresh } = useUsageHistory(props.transport, range)
  const scanning = data?.scan.status === 'scanning'
  const busy = loading || scanning

  return (
    <SettingsPage
      title="Usage"
      className={`usage-page${busy ? ' is-refreshing' : ''}`}
      description={
        data
          ? `${formatInteger(data.sessionCount)} ${data.sessionCount === 1 ? 'session' : 'sessions'} · ${formatDateRange(data.startDate, data.endDate)}`
          : undefined
      }
      actions={
        <>
          <SettingsSegmented
            ariaLabel="Usage period"
            value={range}
            options={RANGE_OPTIONS}
            onChange={(value) => {
              if (isRange(value)) setRange(value)
            }}
          />
          <button
            className="set-button set-button--quiet set-button--icon usage-page__refresh"
            type="button"
            aria-label="Check for new usage"
            title="Check for new usage"
            disabled={busy}
            onClick={refresh}
          >
            <RefreshCw size={14} aria-hidden />
          </button>
        </>
      }
    >
      {scanning && data ? (
        <SettingsNotice tone="progress">
          Indexing local usage
          {data.scan.filesTotal > 0
            ? ` · ${formatInteger(data.scan.filesProcessed)} of ${formatInteger(data.scan.filesTotal)} files`
            : ' · finding sessions'}
          . The figures update as it goes.
        </SettingsNotice>
      ) : null}
      {error && data ? (
        <SettingsNotice tone="error">
          The last refresh failed, so the figures are from the one before. {error}
        </SettingsNotice>
      ) : null}
      {!data && !loading ? (
        <SettingsNotice
          tone="error"
          action={
            <button className="set-button" type="button" onClick={refresh}>
              Try again
            </button>
          }
        >
          Usage could not be loaded. {error ?? 'The local session histories could not be read.'}
        </SettingsNotice>
      ) : null}

      {props.limits ? <UsageLimits source={props.limits} /> : null}

      {data ? (
        <>
          <UsageFooter data={data} />
        </>
      ) : loading ? (
        <HistorySkeleton />
      ) : null}
    </SettingsPage>
  )
}

/** While the first answer loads: the sections' outline, no numbers. */
function HistorySkeleton() {
  return (
    <div className="usage-skeleton" role="status" aria-label="Reading the usage index">
      <span className="skeleton usage-skeleton__title" />
      <span className="skeleton usage-skeleton__stats" />
      <span className="skeleton usage-skeleton__chart" />
    </div>
  )
}

/** Where the numbers come from and how current the index is. */
function UsageFooter(props: { data: ResultOf<'usage.history'> }) {
  const { data } = props
  const now = useSyncExternalStore(subscribeSessionClock, readSessionClock, readSessionClock)
  const age = data.generatedAt > 0 ? compactRelativeTime(data.generatedAt, now) : undefined
  const sources = data.sources
    .filter((source) => source.available)
    .map((source) => providerDisplayName(source.provider))
  const facts = [
    age === undefined
      ? 'Not indexed yet'
      : age === 'now'
        ? 'Indexed just now'
        : `Indexed ${age} ago`,
    data.scan.status === 'idle' && data.scan.filesTotal > 0
      ? `${formatInteger(data.scan.filesTotal)} ${data.scan.filesTotal === 1 ? 'file' : 'files'}`
      : undefined,
    sources.length > 0 ? sources.join(', ') : undefined,
  ].filter(Boolean)

  return (
    <footer className="usage-footer">
      <p className="usage-footer__facts">{facts.join(' · ')}</p>
      <p>
        Counted on this device from your providers&rsquo; local histories and TasteCode&rsquo;s own
        usage records.
      </p>
      {data.warnings.map((warning) => (
        <p className="usage-footer__warning" key={warning}>
          <CircleAlert size={13} aria-hidden />
          {warning}
        </p>
      ))}
    </footer>
  )
}
