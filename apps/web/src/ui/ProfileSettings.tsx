import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Account, ProviderId, ResultOf, UsageHistoryDay } from '@harness/contracts'
import { CircleAlert, RefreshCw } from 'lucide-react'
import { providerMark } from '../model-catalog.js'
import type { Transport } from '../transport.js'
import { ProviderIcon } from './ProviderIcon.js'

const PROFILE_ACTIVITY_DAYS = 365
const integer = new Intl.NumberFormat('en-US')
const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const percent = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 0,
})
const month = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  timeZone: 'UTC',
})
const shortDate = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

export function ProfileSettings(props: {
  transport: Transport
  account: Account | undefined
  providerName: string
}) {
  const [data, setData] = useState<ResultOf<'usage.history'>>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [requestVersion, setRequestVersion] = useState(0)
  const forceRefresh = useRef(false)

  useEffect(() => {
    let active = true
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    const schedulePoll = () => {
      pollTimer = setTimeout(() => {
        if (active) setRequestVersion((version) => version + 1)
      }, 500)
    }
    const refresh = forceRefresh.current
    forceRefresh.current = false
    setLoading(true)
    setError(undefined)
    void props.transport
      .request('usage.history', { range: 'all', ...(refresh ? { refresh: true } : {}) })
      .then((result) => {
        if (!active) return
        setData(result)
        if (result.scan.status === 'scanning') {
          schedulePoll()
        }
      })
      .catch((requestError: unknown) => {
        if (!active) return
        setError(requestError instanceof Error ? requestError.message : String(requestError))
        if (data?.scan.status === 'scanning') schedulePoll()
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      clearTimeout(pollTimer)
    }
  }, [props.transport, requestVersion])

  const refresh = useCallback(() => {
    forceRefresh.current = true
    setRequestVersion((version) => version + 1)
  }, [])

  if (!data && loading) {
    return (
      <section className="profile-page profile-page--loading" aria-live="polite">
        <div className="profile-page__loading-mark" aria-hidden />
        <h1>Loading your profile</h1>
        <p>Reading the local activity index.</p>
      </section>
    )
  }

  if (!data) {
    return (
      <section className="profile-page profile-page--error" role="alert">
        <CircleAlert size={20} aria-hidden />
        <h1>Profile could not be loaded</h1>
        <p>{error ?? 'The local activity index could not be read.'}</p>
        <button type="button" onClick={refresh}>
          Try again
        </button>
      </section>
    )
  }

  const scanning = data.scan.status === 'scanning'
  const identity = profileIdentity(props.account, props.providerName)
  const streaks = streakSummary(data.daily)
  const peakTokens = data.daily.reduce((peak, day) => Math.max(peak, day.totals.processedTokens), 0)
  const topProvider = data.providers.toSorted(
    (left, right) => right.totals.processedTokens - left.totals.processedTokens,
  )[0]
  const topModels = data.models
    .toSorted((left, right) => right.totals.processedTokens - left.totals.processedTokens)
    .slice(0, 5)
  const cacheRate = cacheHitRate(data)
  const perActiveDay =
    data.activeDays > 0 ? data.totals.processedTokens / data.activeDays : undefined

  return (
    <section
      className={`profile-page${loading || scanning ? ' is-refreshing' : ''}`}
      aria-labelledby="profile-title"
    >
      <header className="profile-page__header">
        <h1 id="profile-title">Profile</h1>
        <div className="profile-page__actions">
          <button
            className="profile-page__refresh"
            type="button"
            aria-label="Refresh profile activity"
            title="Refresh profile activity"
            disabled={loading || scanning}
            onClick={refresh}
          >
            <RefreshCw size={14} aria-hidden />
          </button>
        </div>
      </header>

      {scanning ? (
        <div className="profile-page__notice profile-page__notice--scan" role="status">
          <RefreshCw size={14} aria-hidden />
          <span>
            Indexing local activity
            {data.scan.filesTotal > 0
              ? ` · ${integer.format(data.scan.filesProcessed)} of ${integer.format(data.scan.filesTotal)} files`
              : ' · discovering sessions'}
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="profile-page__notice" role="status">
          <CircleAlert size={14} aria-hidden />
          The refresh failed, so the last completed profile is still shown. {error}
        </div>
      ) : null}

      <section className="profile-identity" aria-label="Profile identity">
        <div className="profile-identity__avatar" aria-hidden>
          {identity.initials}
        </div>
        <h2>{identity.name}</h2>
        <div className="profile-identity__meta">
          <span>{identity.handle}</span>
          {props.account?.plan ? (
            <span className="profile-identity__plan">{props.account.plan}</span>
          ) : null}
        </div>
      </section>

      <dl className="profile-stats" aria-label="Lifetime activity">
        <ProfileStat value={formatTokens(data.totals.processedTokens)} label="Lifetime tokens" />
        <ProfileStat value={formatTokens(peakTokens)} label="Peak day" />
        <ProfileStat value={integer.format(data.sessionCount)} label="Total chats" />
        <ProfileStat value={formatDays(streaks.current)} label="Current streak" />
        <ProfileStat value={formatDays(streaks.longest)} label="Longest streak" />
      </dl>

      <ActivityHeatmap daily={data.daily} endDate={data.endDate} />

      <div className="profile-details">
        <section className="profile-insights" aria-labelledby="profile-insights-title">
          <h2 id="profile-insights-title">Activity insights</h2>
          <dl>
            <ProfileInsight
              label="Most used model"
              value={topModels[0]?.model ?? 'No model activity'}
            />
            <ProfileInsight
              label="Top provider"
              value={topProvider ? providerLabel(topProvider.provider) : 'No provider activity'}
            />
            <ProfileInsight
              label="Cache hit rate"
              value={cacheRate === undefined ? 'No cached input' : percent.format(cacheRate)}
            />
            <ProfileInsight
              label="Average per active day"
              value={perActiveDay === undefined ? 'No active days' : formatTokens(perActiveDay)}
            />
            <ProfileInsight label="Active days" value={integer.format(data.activeDays)} />
          </dl>
        </section>

        <section className="profile-models" aria-labelledby="profile-models-title">
          <h2 id="profile-models-title">Most used models</h2>
          {topModels.length > 0 ? (
            <ol>
              {topModels.map((model) => (
                <li data-provider={model.provider} key={`${model.provider}:${model.model}`}>
                  <span className="profile-models__name">
                    <ProviderIcon mark={providerMark(model.provider)} size={16} />
                    <span>{model.model}</span>
                  </span>
                  <span>{formatTokens(model.totals.processedTokens)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p>No model activity has been indexed yet.</p>
          )}
        </section>
      </div>

      {data.warnings.length > 0 ? (
        <div className="profile-page__warnings">
          {data.warnings.map((warning) => (
            <p key={warning}>
              <CircleAlert size={13} aria-hidden />
              {warning}
            </p>
          ))}
        </div>
      ) : null}

      <p className="profile-page__source-note">
        Generated from local provider histories and Harness usage records. This data stays on this
        device.
      </p>
    </section>
  )
}

function ProfileStat(props: { value: string; label: string }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  )
}

function ProfileInsight(props: { label: string; value: string }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  )
}

type ActivityCell = {
  date: string
  tokens: number
  providers: UsageHistoryDay['providers']
}

type ActivityTooltip = {
  cell: ActivityCell
  x: number
  y: number
}

function ActivityHeatmap(props: { daily: UsageHistoryDay[]; endDate: string }) {
  const [tooltip, setTooltip] = useState<ActivityTooltip>()
  const activity = useMemo(
    () => buildActivityGrid(props.daily, props.endDate),
    [props.daily, props.endDate],
  )
  const activeDays = activity.days.filter((day) => day.tokens > 0).length

  const showTooltip = useCallback((element: HTMLElement, cell: ActivityCell) => {
    const bounds = element.getBoundingClientRect()
    const edgeInset = Math.min(160, window.innerWidth / 2)
    const center = bounds.left + bounds.width / 2
    setTooltip({
      cell,
      x: Math.max(edgeInset, Math.min(center, window.innerWidth - edgeInset)),
      y: bounds.top,
    })
  }, [])

  return (
    <section className="profile-activity" aria-labelledby="profile-activity-title">
      <header>
        <h2 id="profile-activity-title">Activity</h2>
        <p>
          {integer.format(activeDays)} {activeDays === 1 ? 'active day' : 'active days'} · Last 12
          months
        </p>
      </header>

      <div className="profile-activity__plot">
        <div className="profile-activity__canvas">
          <div
            className="profile-activity__heatmap"
            role="img"
            aria-label={`${integer.format(activeDays)} active days in the last 12 months`}
          >
            {activity.cells.map((cell, index) =>
              cell ? (
                <span
                  data-activity-date={cell.date}
                  data-level={activityLevel(cell.tokens, activity.maxTokens)}
                  aria-hidden
                  onPointerEnter={(event) => showTooltip(event.currentTarget, cell)}
                  onPointerLeave={() => setTooltip(undefined)}
                  onPointerCancel={() => setTooltip(undefined)}
                  key={cell.date}
                />
              ) : (
                <i aria-hidden key={`padding:${index}`} />
              ),
            )}
          </div>
          <div
            className="profile-activity__months"
            style={{ gridTemplateColumns: `repeat(${activity.weeks}, minmax(0, 1fr))` }}
            aria-hidden
          >
            {activity.months.map((label) => (
              <span
                style={{ gridColumn: `${label.column} / span 4` }}
                key={`${label.column}:${label.text}`}
              >
                {label.text}
              </span>
            ))}
          </div>
        </div>
      </div>
      {tooltip ? (
        <div
          className="profile-activity__tooltip"
          role="tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <p className="profile-activity__tooltip-title">
            {formatTokens(tooltip.cell.tokens)} tokens on{' '}
            {shortDate.format(dateFromKey(tooltip.cell.date))}
          </p>
          {tooltip.cell.providers.length > 0 ? (
            <>
              <div className="profile-activity__tooltip-heading">
                <strong>Usage by provider</strong>
                <span>Tokens · share</span>
              </div>
              <ul>
                {tooltip.cell.providers.map((provider) => {
                  const share = tooltip.cell.tokens > 0 ? provider.tokens / tooltip.cell.tokens : 0
                  return (
                    <li data-provider={provider.provider} key={provider.provider}>
                      <span className="profile-activity__tooltip-provider-name">
                        <ProviderIcon mark={providerMark(provider.provider)} size={15} />
                        {providerLabel(provider.provider)}
                      </span>
                      <span className="profile-activity__tooltip-provider-value">
                        <b>{formatTokens(provider.tokens)}</b>
                        <small>{percent.format(share)}</small>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </>
          ) : (
            <p className="profile-activity__tooltip-empty">No token records for this day.</p>
          )}
        </div>
      ) : null}
    </section>
  )
}

function buildActivityGrid(daily: UsageHistoryDay[], endDate: string) {
  const byDate = new Map(daily.map((day) => [day.date, day]))
  const days: ActivityCell[] = Array.from({ length: PROFILE_ACTIVITY_DAYS }, (_, index) => {
    const date = shiftDate(endDate, index - (PROFILE_ACTIVITY_DAYS - 1))
    const day = byDate.get(date)
    return {
      date,
      tokens: day?.totals.processedTokens ?? 0,
      providers: (day?.providers ?? []).toSorted((left, right) => right.tokens - left.tokens),
    }
  })
  const cells: Array<ActivityCell | undefined> = [
    ...Array<ActivityCell | undefined>(weekday(days[0]?.date ?? endDate)).fill(undefined),
    ...days,
  ]
  while (cells.length % 7 !== 0) cells.push(undefined)

  const months: Array<{ column: number; text: string }> = []
  let previousMonth = ''
  let previousColumn = -10
  cells.forEach((cell, index) => {
    if (!cell) return
    const monthKey = cell.date.slice(0, 7)
    if (monthKey === previousMonth) return
    previousMonth = monthKey
    const column = Math.floor(index / 7) + 1
    if (column - previousColumn < 3) return
    months.push({ column, text: month.format(dateFromKey(cell.date)) })
    previousColumn = column
  })

  return {
    cells,
    days,
    months,
    weeks: cells.length / 7,
    maxTokens: days.reduce((maximum, day) => Math.max(maximum, day.tokens), 0),
  }
}

function profileIdentity(account: Account | undefined, providerName: string) {
  const localPart = account?.email?.split('@')[0]?.trim()
  const name = localPart ? titleCase(localPart) : 'Local profile'
  return {
    name,
    handle: localPart ? `@${localPart}` : providerName,
    initials: profileInitials(name || providerName),
  }
}

function profileInitials(value: string): string {
  const words = value.trim().split(/\s+/u).filter(Boolean)
  if (words.length > 1) {
    return words
      .slice(0, 2)
      .map((word) => Array.from(word)[0])
      .join('')
      .toUpperCase()
  }
  return Array.from(words[0] ?? 'P')
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

function titleCase(value: string): string {
  return value.replace(/[._-]+/g, ' ').replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())
}

function streakSummary(daily: UsageHistoryDay[]) {
  let longest = 0
  let running = 0
  for (const day of daily) {
    if (day.totals.processedTokens > 0) {
      running += 1
      longest = Math.max(longest, running)
    } else {
      running = 0
    }
  }

  let index = daily.length - 1
  if (index >= 0 && daily[index]?.totals.processedTokens === 0) index -= 1
  let current = 0
  while (index >= 0 && (daily[index]?.totals.processedTokens ?? 0) > 0) {
    current += 1
    index -= 1
  }
  return { current, longest }
}

function cacheHitRate(data: ResultOf<'usage.history'>): number | undefined {
  const observed = data.totals.cachedInputTokens + data.totals.uncachedInputTokens
  return observed > 0 ? data.totals.cachedInputTokens / observed : undefined
}

function activityLevel(tokens: number, maximum: number): number {
  if (tokens <= 0 || maximum <= 0) return 0
  return Math.max(1, Math.min(4, Math.ceil((Math.log1p(tokens) / Math.log1p(maximum)) * 4)))
}

function formatTokens(value: number): string {
  return value < 1_000 ? integer.format(Math.round(value)) : compact.format(value)
}

function formatDays(value: number): string {
  return `${integer.format(value)} ${value === 1 ? 'day' : 'days'}`
}

function weekday(value: string): number {
  return dateFromKey(value).getUTCDay()
}

function shiftDate(value: string, days: number): string {
  const [year = 1970, monthValue = 1, day = 1] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, monthValue - 1, day + days))
  return date.toISOString().slice(0, 10)
}

function dateFromKey(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`)
}

function providerLabel(provider: ProviderId): string {
  const labels: Record<ProviderId, string> = {
    codex: 'Codex',
    'claude-code': 'Claude Code',
    grok: 'Grok',
    cursor: 'Cursor',
    opencode: 'OpenCode',
    antigravity: 'Antigravity',
    acp: 'ACP',
    api: 'API',
  }
  return labels[provider]
}
