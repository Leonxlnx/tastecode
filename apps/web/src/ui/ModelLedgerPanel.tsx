import {
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { DEFAULT_ACCOUNT_ID, type AccountId, type ProviderId } from '@harness/contracts'
import {
  IconArrowNarrowRight as ArrowRight,
  IconBolt as Zap,
  IconCheck as Check,
  IconChevronDown as ChevronDown,
  IconClock as Clock,
  IconRefresh as Refresh,
  IconSearch as Search,
  IconUser as User,
  IconX as X,
} from '@tabler/icons-react'
import type { ModelChoice } from '../model-catalog.js'
import { readModelRecents, subscribeModelRecents } from '../model-recents.js'
import { activeAccountOf } from '../provider-accounts-state.js'
import { isComposingKey } from '../shortcuts.js'
import {
  buildLedgerRows,
  headroomGlance,
  headroomOf,
  initialHighlight,
  isNewModel,
  isSelectableRow,
  jumpToGroup,
  resetPhrase,
  roomElsewhere,
  stepEffort,
  stepHighlight,
  targetEffort,
  usd,
  type Headroom,
  type LedgerModelRow,
  type LedgerRow,
} from './model-ledger.js'
import { ModelLedgerFrameContext, type ModelLedgerData } from './model-ledger-context.js'
import {
  getCompactModelName,
  getEffortWord,
  getFastModeOffValue,
  getFastServiceTier,
  getSelectedChoice,
  getSelectedEffort,
  isFastModeEnabled,
  modelSourceKey,
  type ModelSelectorProps,
} from './model-selector-utils.js'
import { ProviderIcon } from './ProviderIcon.js'
import '../styles/model-ledger.css'

export type ModelLedgerPanelProps = ModelSelectorProps & {
  ledger?: ModelLedgerData | undefined
}

/** The fallback height when no trigger measured the room (tests, a first frame). */
const DEFAULT_HEIGHT = 420
/** Above this the inspector shows every reported window, not just the tightest. */
const TALL_HEIGHT = 400
/** Below this the inspector tightens its rhythm so the account line still fits. */
const SHORT_HEIGHT = 340
/** Sources with more models than this name their count beside their name. */
const LEDGER_COUNT_FROM = 12
/** The highlight sits on the model in use, wherever the list puts it. */
const IN_USE = '\u0000in-use'

/**
 * The ledger: one popover, a list beside an inspector. The list holds recent
 * pairs and every engine with its models and plan headroom; the inspector
 * shows the highlighted model's job, its own effort levels, Fast where the
 * model declares a tier, and the account with what it has left. Focus stays
 * in the search field: arrows move the model and the effort, Tab the engine,
 * Enter uses the pair. A click on an effort level uses model and effort at once.
 */
export function ModelLedgerPanel(props: ModelLedgerPanelProps) {
  const frame = useContext(ModelLedgerFrameContext)
  const ledger = props.ledger
  const baseId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const recents = useSyncExternalStore(subscribeModelRecents, readModelRecents, readModelRecents)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  /** Effort chosen with the arrows per row, until the pair is used. */
  const [previews, setPreviews] = useState<Readonly<Record<string, string>>>({})
  /** Fast switched for a model other than the one in use, until the pair is used. */
  const [fastPicks, setFastPicks] = useState<Readonly<Record<string, boolean>>>({})
  /** The effort level under the pointer, shown without being chosen. */
  const [hoverEffort, setHoverEffort] = useState<string>()
  // Ages and reset times are read when the panel opens; nothing ticks while it stays open.
  const [now] = useState(() => Date.now())
  const height = frame?.height ?? DEFAULT_HEIGHT
  const tall = height >= TALL_HEIGHT

  const choice = props.choice ?? getSelectedChoice(props.models, props.modelId)
  const effort = getSelectedEffort(choice?.model, props.effort)
  const current = useMemo(
    () => ({ key: choice?.key, effort, model: choice?.model }),
    [choice?.key, choice?.model, effort],
  )

  const rows = useMemo(
    () =>
      buildLedgerRows({
        models: props.models,
        query,
        recents,
        current: { key: current.key, effort: current.effort },
        chat: ledger?.chat,
        pending: ledger?.pendingSources,
        errors: ledger?.sourceErrors,
        expanded,
        checking: ledger?.catalogLoading,
      }),
    [
      props.models,
      query,
      recents,
      current,
      ledger?.chat,
      ledger?.pendingSources,
      ledger?.sourceErrors,
      ledger?.catalogLoading,
      expanded,
    ],
  )

  /** A row's id, or `IN_USE` for the model in use (the list may still be loading it). */
  const [highlightId, setHighlightId] = useState<string | undefined>(IN_USE)
  const highlightIndex = (() => {
    if (highlightId === IN_USE) return initialHighlight(rows, current.key)
    const index = rows.findIndex((row) => row.id === highlightId)
    return index >= 0 && isSelectableRow(rows[index]) ? index : rows.findIndex(isSelectableRow)
  })()
  const highlighted = rows[highlightIndex]
  /** Set by keys, so only a keyboard move scrolls the list. */
  const scrollOnMove = useRef(true)
  const lastPointer = useRef<{ x: number; y: number } | undefined>(undefined)

  // Showing the ledger lets the usage controller read sources it reads only
  // while a view shows them: other providers and further accounts.
  const showLimits = useRef(ledger?.onShowLimits)
  useLayoutEffect(() => showLimits.current?.(), [])

  useLayoutEffect(() => {
    if (!scrollOnMove.current) return
    scrollOnMove.current = false
    const list = listRef.current
    const row = list?.querySelector<HTMLElement>(`[data-row="${highlightIndex}"]`)
    if (!list || !row) return
    const top = row.offsetTop
    const bottom = top + row.offsetHeight
    if (top - 8 >= list.scrollTop && bottom + 8 <= list.scrollTop + list.clientHeight) return
    // Show the row with its source's heading when both fit, so the list never
    // stops on a model without saying whose it is.
    let head = highlightIndex - 1
    while (head >= 0 && rows[head]?.kind !== 'group' && rows[head]?.kind !== 'section') head -= 1
    const heading = head >= 0 ? list.querySelector<HTMLElement>(`[data-row="${head}"]`) : null
    const headTop = heading?.offsetTop ?? top
    if (bottom - headTop + 10 <= list.clientHeight) list.scrollTop = Math.max(0, headTop - 4)
    else if (top - 8 < list.scrollTop) list.scrollTop = Math.max(0, top - 8)
    else list.scrollTop = bottom + 8 - list.clientHeight
  }, [highlightIndex, rows])

  const search = (value: string) => {
    setQuery(value)
    setHoverEffort(undefined)
    scrollOnMove.current = true
    // A query starts at its first result; clearing it goes back to the model in use.
    setHighlightId(value.trim() ? undefined : IN_USE)
  }

  const accountOf = (entry: ModelChoice): AccountId | undefined => {
    if (entry.agent || entry.connectionId) return undefined
    if (entry.accountId !== undefined) return entry.accountId
    const chat = ledger?.chat
    if (chat && modelSourceKey(entry) === chat.source) return chat.accountId ?? DEFAULT_ACCOUNT_ID
    return ledger?.accounts ? activeAccountOf(ledger.accounts, entry.provider) : DEFAULT_ACCOUNT_ID
  }
  const accountName = (provider: ProviderId, accountId: AccountId | undefined) => {
    const id = accountId ?? DEFAULT_ACCOUNT_ID
    const listed = ledger?.accounts?.accounts.find(
      (account) => account.provider === provider && account.id === id,
    )
    return listed ? { name: listed.email ?? listed.label, plan: listed.plan } : undefined
  }
  const headroomFor = (entry: ModelChoice): Headroom | undefined =>
    entry.agent || entry.connectionId
      ? undefined
      : headroomOf(ledger?.limits, entry.provider, accountOf(entry), now)

  const effortFor = (row: LedgerModelRow): string | undefined => {
    const preview = previews[row.id]
    if (preview && row.choice.model.reasoningEfforts.includes(preview)) return preview
    return targetEffort(row, current)
  }
  const fastFor = (row: LedgerModelRow): boolean => {
    if (row.choice.key === current.key && !row.recent) {
      return isFastModeEnabled(row.choice.model, props.serviceTier)
    }
    const picked = fastPicks[row.id]
    if (picked !== undefined) return picked
    const tier = row.recent?.serviceTier
    return Boolean(tier && getFastServiceTier(row.choice.model)?.id === tier)
  }

  const close = () => frame?.close()
  const use = (row: LedgerModelRow, chosenEffort = effortFor(row)) => {
    const next = row.choice
    const moving = next.key !== current.key
    if (moving) props.onModelChange(next.key)
    if (chosenEffort && (moving || chosenEffort !== current.effort)) {
      props.onEffortChange(chosenEffort)
    }
    const tier = getFastServiceTier(next.model)
    const wantsFast = fastFor(row)
    if (tier && moving && (fastPicks[row.id] !== undefined || row.recent?.serviceTier)) {
      props.onServiceTierChange(wantsFast ? tier.id : getFastModeOffValue(next.model))
    }
    close()
  }
  /** Opens a folded source and moves to the first model the fold hid. */
  const expand = (source: string) => {
    const shown = new Set(
      rows.flatMap((row) =>
        row.kind === 'model' && !row.recent && row.source === source ? [row.choice.key] : [],
      ),
    )
    const revealed = props.models.find(
      (entry) => modelSourceKey(entry) === source && !shown.has(entry.key),
    )
    scrollOnMove.current = true
    setExpanded((open) => new Set([...open, source]))
    if (revealed) setHighlightId(`model:${revealed.key}`)
  }

  const moveHighlight = (index: number) => {
    const row = rows[index]
    if (!row || !isSelectableRow(row)) return
    scrollOnMove.current = true
    setHoverEffort(undefined)
    setHighlightId(row.id)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposingKey(event)) return
    const row = highlighted
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveHighlight(stepHighlight(rows, highlightIndex, event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (event.key === 'Tab') {
      // Tab walks engines here; the dialog's own focus trap never sees it.
      event.preventDefault()
      event.stopPropagation()
      moveHighlight(jumpToGroup(rows, highlightIndex, event.shiftKey ? -1 : 1))
      return
    }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && row?.kind === 'model') {
      const efforts = row.choice.model.reasoningEfforts
      if (efforts.length === 0 || event.altKey || event.ctrlKey || event.metaKey) return
      event.preventDefault()
      const next = stepEffort(efforts, effortFor(row), event.key === 'ArrowRight' ? 1 : -1)
      if (next) {
        setHoverEffort(undefined)
        setPreviews((all) => ({ ...all, [row.id]: next }))
      }
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (row?.kind === 'more') expand(row.source)
      else if (row?.kind === 'model') use(row)
      return
    }
    if (event.key === 'Escape' && query) {
      event.preventDefault()
      event.stopPropagation()
      search('')
    }
  }

  const onListPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const last = lastPointer.current
    const point = { x: event.clientX, y: event.clientY }
    lastPointer.current = point
    // A list that scrolls under a resting pointer is not a pointer move.
    if (last && last.x === point.x && last.y === point.y) return
    const target = (event.target as Element).closest<HTMLElement>('[data-row]')
    if (!target) return
    // Heading for the inspector: the row the pointer crosses on the way stays unpicked.
    const bounds = event.currentTarget.getBoundingClientRect()
    if (last && point.x - last.x > 1.5 * Math.abs(point.y - last.y) && point.x - bounds.left > 120)
      return
    const index = Number(target.dataset['row'])
    const row = rows[index]
    if (!row || !isSelectableRow(row) || row.id === highlightId) return
    setHoverEffort(undefined)
    setHighlightId(row.id)
  }

  const searching = query.trim().length > 0
  const hasRows = rows.some(isSelectableRow)
  const loadingAll = !hasRows && rows.some((row) => row.kind === 'skeleton')
  /** Nothing to inspect: the message takes the whole panel. */
  const empty: 'search' | 'none' | undefined = hasRows
    ? undefined
    : searching
      ? 'search'
      : !loadingAll && rows.length === 0
        ? 'none'
        : undefined
  const optionId = (index: number) => `${baseId}-row-${index}`

  return (
    <div
      className="model-ledger"
      data-short={height < SHORT_HEIGHT || undefined}
      style={{ '--ledger-h': `${height}px` } as CSSProperties}
    >
      <div className="model-ledger__head">
        <Search size={15} aria-hidden />
        <input
          ref={inputRef}
          className="model-ledger__search"
          type="text"
          role="combobox"
          aria-label="Search models or providers"
          aria-expanded
          aria-controls={`${baseId}-list`}
          aria-activedescendant={highlightIndex >= 0 ? optionId(highlightIndex) : undefined}
          aria-autocomplete="list"
          placeholder="Search models or providers"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          value={query}
          onChange={(event) => search(event.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        {query ? (
          <button
            type="button"
            className="model-ledger__clear"
            aria-label="Clear search"
            onClick={() => {
              search('')
              inputRef.current?.focus()
            }}
          >
            <X size={13} aria-hidden />
          </button>
        ) : null}
      </div>

      <div className={`model-ledger__body${empty ? ' is-empty' : ''}`}>
        <div
          ref={listRef}
          id={`${baseId}-list`}
          className="model-ledger__list"
          role="listbox"
          aria-label="Models"
          onPointerMove={onListPointerMove}
        >
          {empty === 'search' ? (
            <div className="model-ledger__empty" role="status">
              <b>No model matches “{query.trim()}”</b>
              Search looks at every engine you added, by model, provider and lab.
            </div>
          ) : empty === 'none' ? (
            <div className="model-ledger__empty" role="status">
              <b>No models yet</b>
              Add a provider in Settings to list its models here.
            </div>
          ) : (
            rows.map((row, index) => (
              <LedgerListRow
                key={row.id}
                row={row}
                index={index}
                id={optionId(index)}
                highlighted={index === highlightIndex}
                currentKey={current.key}
                query={query}
                now={now}
                effortWord={(entry) => {
                  const value = entry.kind === 'model' ? effortFor(entry) : undefined
                  return value ? getEffortWord(value) : undefined
                }}
                headroom={(entry) =>
                  entry.provider
                    ? headroomOf(
                        ledger?.limits,
                        entry.provider,
                        entry.accountId ?? accountFallback(entry.provider),
                        now,
                      )
                    : undefined
                }
                onUse={(entry) => use(entry)}
                onExpand={expand}
                onRetry={ledger?.onRetrySources}
              />
            ))
          )}
        </div>

        <div className="model-ledger__inspector" hidden={empty !== undefined}>
          {highlighted?.kind === 'model' ? (
            <Inspector
              row={highlighted}
              current={current}
              effort={hoverEffort ?? effortFor(highlighted)}
              chosenEffort={effortFor(highlighted)}
              fast={fastFor(highlighted)}
              tall={tall}
              now={now}
              headroom={headroomFor(highlighted.choice)}
              account={(() => {
                const entry = highlighted.choice
                if (entry.agent || entry.connectionId) return undefined
                return accountName(entry.provider, accountOf(entry))
              })()}
              room={(() => {
                const headroom = headroomFor(highlighted.choice)
                if (headroom?.kind !== 'windows' || !headroom.tightest.out) return undefined
                return roomElsewhere(
                  props.models,
                  highlighted.choice,
                  accountOf,
                  ledger?.limits,
                  now,
                )
              })()}
              roomName={(entry) =>
                accountName(entry.provider, accountOf(entry))?.name ?? entry.sourceName
              }
              onHoverEffort={setHoverEffort}
              onPickEffort={(value) => use(highlighted, value)}
              onToggleFast={() => {
                const tier = getFastServiceTier(highlighted.choice.model)
                if (!tier) return
                const on = !fastFor(highlighted)
                if (highlighted.choice.key === current.key && !highlighted.recent) {
                  props.onServiceTierChange(
                    on ? tier.id : getFastModeOffValue(highlighted.choice.model),
                  )
                } else {
                  setFastPicks((all) => ({ ...all, [highlighted.id]: on }))
                }
                inputRef.current?.focus()
              }}
              onUseElsewhere={(entry) =>
                use(
                  { ...highlighted, id: `room:${entry.key}`, choice: entry },
                  effortFor(highlighted),
                )
              }
            />
          ) : highlighted?.kind === 'more' ? (
            <div className="model-ledger__more-note">
              <p className="model-ledger__title">
                <ProviderIcon mark={highlighted.mark} size={15} />
                <span>{highlighted.name}</span>
              </p>
              <p className="model-ledger__job">
                {highlighted.hidden} more {highlighted.hidden === 1 ? 'model' : 'models'} from{' '}
                {highlighted.name}. Press Enter to list them all, or type a name to find one.
              </p>
            </div>
          ) : loadingAll ? (
            <p className="model-ledger__waiting">Asking your engines for their models…</p>
          ) : null}
        </div>
      </div>

      <div className="model-ledger__foot" aria-hidden>
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> Model
        </span>
        <span>
          <kbd>←</kbd>
          <kbd>→</kbd> Effort
        </span>
        <span>
          <kbd>Tab</kbd> Provider
        </span>
        <span>
          <kbd>↵</kbd> Use
        </span>
      </div>
    </div>
  )

  function accountFallback(provider: ProviderId): AccountId | undefined {
    const chat = ledger?.chat
    if (chat && chat.provider === provider && chat.source === provider) {
      return chat.accountId ?? DEFAULT_ACCOUNT_ID
    }
    return ledger?.accounts ? activeAccountOf(ledger.accounts, provider) : undefined
  }
}

function LedgerListRow(props: {
  row: LedgerRow
  index: number
  id: string
  highlighted: boolean
  currentKey: string | undefined
  query: string
  now: number
  effortWord: (row: LedgerModelRow) => string | undefined
  headroom: (row: Extract<LedgerRow, { kind: 'group' }>) => Headroom | undefined
  onUse: (row: LedgerModelRow) => void
  onExpand: (source: string) => void
  onRetry: (() => void) | undefined
}) {
  const row = props.row
  const data = { 'data-row': props.index }
  if (row.kind === 'section') {
    return (
      <div
        className={`model-ledger__section${row.id === 'section:move' ? ' is-move' : ''}`}
        {...data}
      >
        {row.label}
      </div>
    )
  }
  if (row.kind === 'group') {
    const glance = headroomGlance(props.headroom(row), props.now)
    return (
      <div className="model-ledger__group" {...data}>
        <ProviderIcon mark={row.mark} size={13} />
        <span className="model-ledger__group-name">{row.name}</span>
        <span className="model-ledger__group-meta">
          {row.status === 'loading' ? (
            <>
              <span className="model-ledger__spin" aria-hidden />
              Asking for models…
            </>
          ) : row.status === 'updating' ? (
            <>
              <span className="model-ledger__spin" aria-hidden />
              Updating
            </>
          ) : row.status === 'failed' ? (
            'Couldn’t list'
          ) : glance ? (
            <span className={`model-ledger__glance is-${glance.tone}`}>{glance.text}</span>
          ) : row.count > LEDGER_COUNT_FROM ? (
            `${row.count} models`
          ) : null}
        </span>
      </div>
    )
  }
  if (row.kind === 'checking') {
    return (
      <div className="model-ledger__group is-checking" {...data}>
        <span className="model-ledger__spin" aria-hidden />
        <span className="model-ledger__group-name">Checking which engines are set up…</span>
      </div>
    )
  }
  if (row.kind === 'skeleton') {
    return (
      <div className="model-ledger__skeleton" {...data} aria-hidden>
        <span style={{ width: row.width }} />
      </div>
    )
  }
  if (row.kind === 'failure') {
    return (
      <div className="model-ledger__failure" {...data}>
        <span>{row.message}</span>
        {props.onRetry ? (
          <button type="button" onClick={props.onRetry}>
            <Refresh size={12} aria-hidden />
            Retry
          </button>
        ) : null}
      </div>
    )
  }
  if (row.kind === 'more') {
    return (
      <div
        id={props.id}
        role="option"
        aria-selected={props.highlighted}
        className={`model-ledger__row is-more${props.highlighted ? ' is-highlighted' : ''}`}
        {...data}
        onClick={() => props.onExpand(row.source)}
      >
        <ChevronDown size={13} aria-hidden />
        <span className="model-ledger__name">{row.hidden} more · type to search</span>
      </div>
    )
  }
  const inUse = !row.recent && row.choice.key === props.currentKey
  const effortWord = row.recent ? props.effortWord(row) : undefined
  return (
    <div
      id={props.id}
      role="option"
      aria-selected={props.highlighted}
      aria-label={`${getCompactModelName(row.choice.model.displayName)}${effortWord ? `, ${effortWord}` : ''}, ${row.choice.sourceName}${inUse ? ', in use' : ''}`}
      className={`model-ledger__row${row.recent ? ' is-recent' : ''}${inUse ? ' is-current' : ''}${props.highlighted ? ' is-highlighted' : ''}`}
      {...data}
      onClick={() => props.onUse(row)}
    >
      {row.recent ? <ProviderIcon mark={row.choice.mark} size={13} /> : null}
      <span className="model-ledger__name">
        <Highlighted text={getCompactModelName(row.choice.model.displayName)} query={props.query} />
      </span>
      {isNewModel(row.choice, props.now) ? <span className="model-ledger__tag">New</span> : null}
      <span className="model-ledger__row-end">
        {effortWord ? <span>{effortWord}</span> : null}
        {inUse ? <Check size={14} aria-hidden /> : null}
      </span>
    </div>
  )
}

/** The query's words in bold where they occur in a model name. */
function Highlighted(props: { text: string; query: string }) {
  const terms = props.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return <>{props.text}</>
  const lower = props.text.toLowerCase()
  const marks = Array.from({ length: props.text.length }, () => false)
  for (const term of terms) {
    const at = lower.indexOf(term)
    if (at >= 0) for (let index = at; index < at + term.length; index += 1) marks[index] = true
  }
  const parts: Array<{ text: string; mark: boolean }> = []
  for (let index = 0; index < props.text.length; index += 1) {
    const mark = marks[index] ?? false
    const last = parts[parts.length - 1]
    if (last && last.mark === mark) last.text += props.text[index]
    else parts.push({ text: props.text[index] ?? '', mark })
  }
  return (
    <>
      {parts.map((part, index) =>
        part.mark ? <b key={index}>{part.text}</b> : <span key={index}>{part.text}</span>,
      )}
    </>
  )
}

function Inspector(props: {
  row: LedgerModelRow
  current: { key: string | undefined; effort: string | undefined }
  /** The level shown: the one under the pointer, else the one chosen. */
  effort: string | undefined
  chosenEffort: string | undefined
  fast: boolean
  tall: boolean
  now: number
  headroom: Headroom | undefined
  account: { name: string; plan?: string | undefined } | undefined
  room: { choice: ModelChoice; left: number | undefined } | undefined
  roomName: (choice: ModelChoice) => string
  onHoverEffort: (value: string | undefined) => void
  onPickEffort: (value: string) => void
  onToggleFast: () => void
  onUseElsewhere: (choice: ModelChoice) => void
}) {
  const entry = props.row.choice
  const model = entry.model
  const name = getCompactModelName(model.displayName)
  const efforts = model.reasoningEfforts
  const fastTier = getFastServiceTier(model)
  const fallback =
    model.defaultReasoningEffort && efforts.includes(model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : undefined
  const lab =
    model.lab && !entry.sourceName.toLowerCase().includes(model.lab.toLowerCase())
      ? model.lab
      : undefined
  const out =
    props.headroom?.kind === 'windows' && props.headroom.tightest.out
      ? props.headroom.tightest
      : undefined

  return (
    <div className="model-ledger__inspect">
      <p className="model-ledger__title">
        <ProviderIcon mark={entry.mark} size={15} />
        <span>{name}</span>
        {isNewModel(entry, props.now) ? <span className="model-ledger__tag">New</span> : null}
      </p>
      <p className="model-ledger__sub">
        {[entry.sourceName, lab, model.isDefault ? 'Default model' : undefined]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {model.description ? <p className="model-ledger__job">{model.description}</p> : null}

      <div className="model-ledger__label">
        <span>Effort</span>
        {fastTier ? (
          <button
            type="button"
            role="switch"
            aria-checked={props.fast}
            className={`model-ledger__fast${props.fast ? ' is-on' : ''}`}
            title={fastTier.description || undefined}
            onClick={props.onToggleFast}
          >
            <Zap size={12} aria-hidden />
            {fastTier.name}
            <span className="model-ledger__switch" aria-hidden />
          </button>
        ) : null}
      </div>
      {efforts.length > 0 ? (
        <>
          <div
            className="model-ledger__levels"
            role="radiogroup"
            aria-label={`${name} effort`}
            onPointerLeave={() => props.onHoverEffort(undefined)}
          >
            {efforts.map((level) => (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={level === props.chosenEffort}
                tabIndex={-1}
                className={`model-ledger__level${level === props.effort ? ' is-selected' : ''}${level === fallback ? ' is-default' : ''}`}
                title={level === fallback ? 'Default for this model' : undefined}
                onPointerEnter={() => props.onHoverEffort(level)}
                onClick={() => props.onPickEffort(level)}
              >
                {getEffortWord(level)}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="model-ledger__no-effort">
          {name} has no effort setting; it decides how long to think.
        </p>
      )}

      <div className="model-ledger__foot-area">
        {out ? (
          <div className="model-ledger__note">
            <Clock size={14} aria-hidden />
            <div>
              The {out.name} limit
              {props.account ? (
                <>
                  {' '}
                  on <b>{props.account.name}</b>
                </>
              ) : null}{' '}
              is used up
              {out.resetsAt ? ` until ${resetPhrase(out.resetsAt, props.now)}` : ''}.
              {props.room ? (
                <button
                  type="button"
                  className="model-ledger__note-action"
                  onClick={() => props.onUseElsewhere(props.room!.choice)}
                >
                  Use {props.roomName(props.room.choice)}
                  {props.room.left !== undefined ? ` · ${props.room.left}% left` : ''}
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <AccountLine
            fallbackName={entry.sourceName}
            account={props.account}
            headroom={props.headroom}
            tall={props.tall}
            now={props.now}
          />
        )}
        {props.row.moves ? (
          <div className="model-ledger__note">
            <ArrowRight size={14} aria-hidden />
            <div>
              Your next message switches this chat to <b>{entry.sourceName}</b>. The conversation so
              far goes with it.
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function AccountLine(props: {
  /** Who the line names when the provider lists no accounts: its engine. */
  fallbackName: string
  account: { name: string; plan?: string | undefined } | undefined
  headroom: Headroom | undefined
  tall: boolean
  now: number
}) {
  const headroom = props.headroom
  if (!headroom && !props.account) return null
  const windows =
    headroom?.kind === 'windows' ? (props.tall ? headroom.windows : [headroom.tightest]) : []
  const status =
    headroom === undefined
      ? undefined
      : headroom.kind === 'checking'
        ? 'Checking limits…'
        : headroom.kind === 'spend'
          ? `${usd(headroom.todayUsd)} spent today`
          : headroom.kind === 'not-reported'
            ? 'Limits not reported'
            : headroom.kind === 'unavailable'
              ? 'Limits unavailable'
              : undefined
  return (
    <div className="model-ledger__account">
      <div className="model-ledger__account-line">
        <User size={14} aria-hidden />
        <span className="model-ledger__who">{props.account?.name ?? props.fallbackName}</span>
        {props.account?.plan ? (
          <span className="model-ledger__plan">{capitalize(props.account.plan)}</span>
        ) : null}
        {status ? (
          <span
            className="model-ledger__left"
            title={headroom?.kind === 'unavailable' ? headroom.message : undefined}
          >
            {status}
          </span>
        ) : null}
      </div>
      {windows.map((window, index) => (
        <div className="model-ledger__window" key={`${window.name}:${index}`}>
          <div className="model-ledger__window-line">
            <span>{capitalize(window.name)}</span>
            <span className={`model-ledger__left${window.low ? ' is-low' : ''}`}>
              {window.left}% left
              {window.resetsAt ? ` · resets ${resetPhrase(window.resetsAt, props.now)}` : ''}
            </span>
          </div>
          <div
            className={`model-ledger__meter${window.low ? ' is-low' : ''}`}
            role="meter"
            aria-label={`${capitalize(window.name)} limit left`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={window.left}
          >
            <i style={{ width: `${window.left}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
