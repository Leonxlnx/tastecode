import {
  useCallback,
  useEffect,
  useMemo,
  useId,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type { Account, ResultOf, UsageHistoryDay } from '@harness/contracts'
import {
  IconDice5 as Dice,
  IconAlertCircle as CircleAlert,
  IconRefresh as RefreshCw,
} from '@tabler/icons-react'
import type { Transport } from '../transport.js'
import { providerPresentation } from '../provider-presentation.js'
import { SourceIdentity } from './SourceIdentity.js'
import {
  FALLBACK_PROFILE_NAME,
  PROFILE_IMAGE_ACCEPT,
  readProfileImage,
  type ProfileIdentityPreferences,
} from '../profile-preferences.js'
import { ProfileCoin, useStruckName, type CoinSide } from './ProfileCoin.js'
import { SealGuideToggle, SealNotes } from './SealGuide.js'
import { Skeleton, SkeletonStatus } from './Skeleton.js'
import '../styles/profile-settings.css'

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

// Words to strike a seal from when experimenting: concrete, varied in
// length and sound, so each roll looks clearly different.
const TRIAL_WORDS = [
  'harbor',
  'ember',
  'quartz',
  'lantern',
  'orbit',
  'fjord',
  'meadow',
  'cobalt',
  'juniper',
  'atlas',
  'saffron',
  'tundra',
  'willow',
  'comet',
  'basalt',
  'marlin',
  'sorrel',
  'glacier',
  'copper',
  'nimbus',
  'thistle',
  'onyx',
  'delta',
  'fable',
  'kestrel',
  'lumen',
  'mosaic',
  'prairie',
  'ripple',
  'sable',
  'tidal',
  'umber',
  'vesper',
  'zephyr',
  'cinder',
  'halcyon',
  'indigo',
  'larkspur',
  'monsoon',
  'obsidian',
] as const

function rollWord(current: string): string {
  const choices = TRIAL_WORDS.filter((word) => word !== current.trim().toLowerCase())
  return choices[Math.floor(Math.random() * choices.length)] ?? TRIAL_WORDS[0]
}

/** "JPEG, 12 KB", read from the data URL itself. */
function photoFacts(photo: string): string {
  const type = /^data:image\/(png|jpeg|webp);base64,/u.exec(photo)?.[1]
  const label = type === 'png' ? 'PNG' : type === 'jpeg' ? 'JPEG' : 'WebP'
  const base64 = photo.slice(photo.indexOf(',') + 1)
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  const bytes = Math.max(0, (base64.length * 3) / 4 - padding)
  return `${label}, ${bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`}`
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files')
}

/**
 * Profile is one coin. Its two faces are the two pictures: the seal struck
 * from your name, and your photo. Turning it over is how the picture changes.
 */
export function ProfileSettings(props: {
  transport: Transport
  account: Account | undefined
  accountLoading?: boolean | undefined
  providerName: string
  identity?: ProfileIdentityPreferences | undefined
  onIdentityChange?: ((updates: Partial<ProfileIdentityPreferences>) => void) | undefined
}) {
  const [imageError, setImageError] = useState<string>()
  // The photo last turned away from, so turning over brings it back this
  // session without choosing the file again.
  const [setAside, setSetAside] = useState<string>()
  // Turned to the photo face before there is a photo on it.
  const [turned, setTurned] = useState(false)
  const [dropping, setDropping] = useState(false)
  const imageRequest = useRef(0)
  const drags = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => () => void (imageRequest.current += 1), [])

  const photo = props.identity?.avatarDataUrl
  // A refused file's error belongs to the picture it failed to replace.
  const [errorPhoto, setErrorPhoto] = useState(photo)
  if (errorPhoto !== photo) {
    setErrorPhoto(photo)
    setImageError(undefined)
  }
  const name = props.identity?.displayName?.trim() || FALLBACK_PROFILE_NAME
  const seed = props.identity?.avatarSeed?.trim() || undefined
  // A word being tried on the seal; empty means your name. Nothing is kept
  // until Keep this seal.
  const [trial, setTrial] = useState<string>()
  const trialId = useId()
  const notesId = useId()
  // The notes show while the "?" is hovered or focused, or after a click pins them.
  const [guideHovered, setGuideHovered] = useState(false)
  const [guidePinned, setGuidePinned] = useState(false)
  const trying = trial !== undefined
  const struck = useStruckName((trying ? trial.trim() : seed) || name)
  const guideOpen = trying && (guideHovered || guidePinned)
  const side: CoinSide = photo || turned || dropping ? 'photo' : 'seal'

  const chooseImage = async (file: File | undefined) => {
    if (!file) return
    const request = ++imageRequest.current
    setImageError(undefined)
    try {
      const avatarDataUrl = await readProfileImage(file)
      if (request !== imageRequest.current) return
      setSetAside(undefined)
      setTurned(false)
      props.onIdentityChange?.({ avatarDataUrl })
    } catch (requestError) {
      if (request === imageRequest.current) {
        setImageError(requestError instanceof Error ? requestError.message : String(requestError))
      }
    }
  }

  const turnOver = () => {
    if (setAside) {
      setSetAside(undefined)
      props.onIdentityChange?.({ avatarDataUrl: setAside })
      return
    }
    setTurned(true)
    fileInput.current?.click()
  }
  const turnBack = () => {
    imageRequest.current += 1
    setImageError(undefined)
    setTurned(false)
    if (!photo) return
    setSetAside(photo)
    props.onIdentityChange?.({ avatarDataUrl: undefined })
  }

  const keepTrial = () => {
    if (trial === undefined) return
    props.onIdentityChange?.({ avatarSeed: trial.trim() || undefined })
    setTrial(undefined)
  }
  const onTrialKey = (event: ReactKeyboardEvent) => {
    if (event.key === 'Enter') keepTrial()
    if (event.key !== 'Escape') return
    // Leave the trial, not Settings.
    event.preventDefault()
    setTrial(undefined)
  }

  const facts = imageError
    ? undefined
    : side === 'seal'
      ? seed
        ? `Struck from \u201c${seed}\u201d`
        : 'Struck from your name'
      : photo
        ? `Your photo · ${photoFacts(photo)}`
        : 'PNG, JPEG or WebP up to 1 MB'
  const plan = props.account?.plan ? (
    <span className="profile__plan">{props.account.plan} plan</span>
  ) : props.accountLoading && !props.account ? (
    <SkeletonStatus label="Loading account plan…" className="profile__plan">
      <Skeleton width={52} height={9} />
    </SkeletonStatus>
  ) : null

  return (
    <section
      className="settings__panel profile"
      aria-labelledby="settings-profile"
      onDragEnter={(event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        drags.current += 1
        setDropping(true)
      }}
      onDragOver={(event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (!hasFiles(event)) return
        drags.current = Math.max(0, drags.current - 1)
        if (drags.current === 0) setDropping(false)
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        event.stopPropagation()
        drags.current = 0
        setDropping(false)
        setTurned(true)
        void chooseImage(event.dataTransfer.files[0])
      }}
    >
      <h1 className="settings__title" id="settings-profile">
        Profile
      </h1>
      {trying ? (
        <SealGuideToggle
          open={guideOpen}
          pinned={guidePinned}
          notesId={notesId}
          onHover={setGuideHovered}
          onPin={setGuidePinned}
        />
      ) : null}
      <div className="profile__stage">
        <div className="profile__coin">
          <ProfileCoin
            name={struck}
            // A photo turned away from stays on its face, so it is still there
            // while the coin turns back and when it turns over again.
            photo={photo ?? setAside}
            side={side}
            dropping={dropping}
            explain={guideOpen}
            label={side === 'seal' ? 'Turn over for a photo' : 'Turn back to the seal'}
            onTurn={side === 'seal' ? turnOver : turnBack}
          />
          {guideOpen ? <SealNotes id={notesId} word={struck} /> : null}
        </div>
        <input
          className="profile__name"
          type="text"
          maxLength={64}
          spellCheck={false}
          autoComplete="off"
          aria-label="Display name"
          value={props.identity?.displayName ?? ''}
          placeholder={FALLBACK_PROFILE_NAME}
          onChange={(event) => props.onIdentityChange?.({ displayName: event.target.value })}
        />
        {trying ? (
          <p className="profile__facts profile__facts--trying">
            <label htmlFor={trialId}>Struck from</label>
            <input
              id={trialId}
              className="profile__word"
              type="text"
              maxLength={64}
              spellCheck={false}
              autoComplete="off"
              autoFocus
              value={trial}
              placeholder={name}
              onChange={(event) => setTrial(event.target.value)}
              onKeyDown={onTrialKey}
            />
            <button
              className="profile__roll"
              type="button"
              aria-label="Another word"
              title="Another word"
              onClick={(event) => {
                setTrial(rollWord(trial))
                // The die tumbles a half turn with each roll.
                event.currentTarget
                  .querySelector('svg')
                  ?.animate?.([{ rotate: '0deg' }, { rotate: '180deg' }], {
                    duration: 360,
                    easing: 'cubic-bezier(0.3, 0, 0.2, 1)',
                  })
              }}
            >
              <Dice size={15} stroke={1.6} aria-hidden />
            </button>
          </p>
        ) : (
          <p className="profile__facts">
            {imageError ? (
              <span className="profile__error" role="alert">
                {imageError}
              </span>
            ) : (
              <span>{dropping ? 'Drop to use this photo' : facts}</span>
            )}
            {plan ? <span aria-hidden>·</span> : null}
            {plan}
          </p>
        )}
        <p className="profile__actions">
          {trying ? (
            <>
              <button className="profile__keep" type="button" onClick={keepTrial}>
                Keep this seal
              </button>
              <button type="button" onClick={() => setTrial(undefined)}>
                Cancel
              </button>
            </>
          ) : side === 'seal' ? (
            <>
              <button type="button" onClick={turnOver}>
                {setAside ? 'Turn over to your photo' : 'Turn over for a photo'}
              </button>
              <button type="button" onClick={() => setTrial(seed ?? '')}>
                Strike from a word
              </button>
              {seed ? (
                <button
                  type="button"
                  onClick={() => props.onIdentityChange?.({ avatarSeed: undefined })}
                >
                  Back to your name
                </button>
              ) : null}
            </>
          ) : (
            <>
              <button type="button" onClick={() => fileInput.current?.click()}>
                {photo ? 'Replace' : 'Choose a photo'}
              </button>
              <button type="button" onClick={turnBack}>
                Turn back
              </button>
            </>
          )}
        </p>
      </div>
      <input
        ref={fileInput}
        className="visually-hidden"
        type="file"
        tabIndex={-1}
        aria-hidden
        accept={PROFILE_IMAGE_ACCEPT}
        onChange={(event) => {
          void chooseImage(event.target.files?.[0])
          event.target.value = ''
        }}
      />
      <ProfileHistory transport={props.transport} />
    </section>
  )
}

function ProfileHistory(props: { transport: Transport }) {
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

  if (!data) {
    return (
      <section className="profile-history" aria-label="Local activity">
        <div
          className={`profile-page__notice${loading ? ' profile-page__notice--scan' : ''}`}
          role={loading ? 'status' : 'alert'}
        >
          {loading ? <RefreshCw size={14} aria-hidden /> : <CircleAlert size={14} aria-hidden />}
          <span>{loading ? 'Reading the local activity index.' : error}</span>
          {!loading ? (
            <button className="settings__action" type="button" onClick={refresh}>
              Try again
            </button>
          ) : null}
        </div>
      </section>
    )
  }

  const scanning = data.scan.status === 'scanning'
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
      className={`profile-history${loading || scanning ? ' is-refreshing' : ''}`}
      aria-label="Local activity"
    >
      <header className="profile-history__header">
        <h2>Local activity</h2>
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
              value={
                topProvider ? (
                  <SourceIdentity presentation={providerPresentation(topProvider.provider)} />
                ) : (
                  'No provider activity'
                )
              }
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
                    <SourceIdentity
                      presentation={providerPresentation(model.provider)}
                      qualifier={model.model}
                    />
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

function ProfileInsight(props: { label: string; value: ReactNode }) {
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
                        <SourceIdentity
                          presentation={providerPresentation(provider.provider)}
                          density="compact"
                        />
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
