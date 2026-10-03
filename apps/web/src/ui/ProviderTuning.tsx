import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import {
  IconCheck as Check,
  IconChevronDown as ChevronDown,
  IconRotate as RotateCcw,
} from '@tabler/icons-react'
import type {
  ApprovalMode,
  ContextControl,
  ProviderContextSettings,
  ProviderContextSettingsMap,
  ProviderId,
  ProviderStatus,
} from '@harness/contracts'
import type { ModelChoice } from '../model-catalog.js'
import type { ProviderDefault } from '../provider-defaults.js'
import type { Transport } from '../transport.js'
import { APPROVAL_MODES } from './approval-modes.js'
import { Menu, MenuItem } from './Menu.js'
import { getFriendlyEffortLabel } from './model-selector-utils.js'
import { Skeleton } from './Skeleton.js'
import '../styles/provider-tuning.css'

/** The contract's floor: compacting earlier than this leaves no room to work. */
const EARLIEST_COMPACT_AT = 10
const LATEST_COMPACT_AT = 99
/** Close enough to the engine's own point that the user surely meant it. */
const DEFAULT_SNAP = 1
const AUTO_WINDOW = 'auto'

type CompactAt = NonNullable<ProviderContextSettings['compactAt']>
type CompactionDraft = { value: number | undefined }

export type ContextSettingsState =
  | { phase: 'loading' }
  | { phase: 'ready'; settings: ProviderContextSettingsMap }
  | { phase: 'error'; message: string }

type ProviderContextState =
  | { phase: 'loading' }
  | { phase: 'ready'; settings: ProviderContextSettings | undefined }
  | { phase: 'error'; message: string }

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function withProviderSettings(
  map: ProviderContextSettingsMap,
  provider: ProviderId,
  settings: ProviderContextSettings,
): ProviderContextSettingsMap {
  const next = { ...map }
  if (settings.window === undefined && settings.compactAt === undefined) delete next[provider]
  else next[provider] = settings
  return next
}

/**
 * Context settings live on the server, because the server applies them at
 * launch. Edits show at once and fall back to the last saved state when the
 * server refuses them.
 */
export function useProviderContextSettings(transport: Transport, enabled: boolean) {
  const [state, setState] = useState<ContextSettingsState>({ phase: 'loading' })
  const [errors, setErrors] = useState<Partial<Record<ProviderId, string>>>({})
  const confirmed = useRef<ProviderContextSettingsMap>({})
  const loads = useRef(0)
  const updates = useRef(0)

  useEffect(() => {
    if (!enabled) return
    const load = ++loads.current
    setState({ phase: 'loading' })
    void (async () => {
      try {
        const settings = await transport.request('providers.contextSettings', {})
        if (loads.current !== load) return
        confirmed.current = settings
        setState({ phase: 'ready', settings })
      } catch (cause) {
        if (loads.current === load) setState({ phase: 'error', message: errorMessage(cause) })
      }
    })()
    return () => {
      loads.current += 1
    }
  }, [transport, enabled])

  const update = useCallback(
    (provider: ProviderId, settings: ProviderContextSettings) => {
      const request = ++updates.current
      setState((current) =>
        current.phase === 'ready'
          ? { phase: 'ready', settings: withProviderSettings(current.settings, provider, settings) }
          : current,
      )
      setErrors((current) => {
        if (current[provider] === undefined) return current
        const next = { ...current }
        delete next[provider]
        return next
      })
      void (async () => {
        try {
          const saved = await transport.request('providers.updateContextSettings', {
            provider,
            settings,
          })
          confirmed.current = saved
          if (updates.current === request) setState({ phase: 'ready', settings: saved })
        } catch (cause) {
          if (updates.current !== request) return
          setState({ phase: 'ready', settings: confirmed.current })
          setErrors((current) => ({ ...current, [provider]: errorMessage(cause) }))
        }
      })()
    },
    [transport],
  )

  return { state, errors, update }
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  return `${Math.round(tokens / 1000)}K`
}

function compactionBounds(control: ContextControl) {
  const latest = Math.min(control.latestCompactAt ?? LATEST_COMPACT_AT, LATEST_COMPACT_AT)
  return { latest, defaultAt: Math.min(control.defaultCompactAt ?? latest, latest) }
}

function contextSummary(window: number | undefined, point: number | 'off'): string {
  if (window === undefined) return point === 'off' ? 'Never compacts' : `Compacts at ${point}%`
  return `${formatTokens(window)} · ${point === 'off' ? 'never compacts' : `compacts at ${point}%`}`
}

/**
 * The few things people change per provider, hung off the provider's mark as
 * one trunk with a branch per setting. Like a table of contents, each line
 * ends in exactly one value; the controls that change it open on demand, so
 * the page reads at a glance and is only as busy as the one thing being
 * edited. Model, reasoning and access shape new chats; context reaches every
 * session the server launches.
 */
export function ProviderTuning(props: {
  provider: ProviderStatus
  /** The provider's own models the user can see in the picker. */
  models: ModelChoice[]
  pinned: ProviderDefault | undefined
  /** Display name for a pinned model the picker no longer lists. */
  pinnedName?: string | undefined
  onPinnedChange: (pin: ProviderDefault | undefined) => void
  access: ApprovalMode
  onAccessChange: (mode: ApprovalMode) => void
  context: ContextSettingsState
  contextError?: string | undefined
  onContextChange: (settings: ProviderContextSettings) => void
  /** The account is still being checked, so the rows hold their place without values. */
  pending?: boolean | undefined
}) {
  const id = props.provider.id
  const name = props.provider.displayName
  const control = props.provider.capabilities?.context
  const context: ProviderContextState =
    props.context.phase === 'ready'
      ? { phase: 'ready', settings: props.context.settings[id] }
      : props.context
  const pending = props.pending === true

  return (
    <div
      className="provider-tune"
      role="group"
      aria-label={`${name} defaults`}
      aria-busy={pending || (control !== undefined && context.phase === 'loading') || undefined}
    >
      <div className="provider-tune__rows">
        <TuneRow label="Model">
          {pending ? (
            <ValueSkeleton width={VALUE_SKELETON_WIDTHS.model} />
          ) : (
            <ModelDefault
              name={name}
              models={props.models}
              pinned={props.pinned}
              pinnedName={props.pinnedName}
              onPinnedChange={props.onPinnedChange}
            />
          )}
        </TuneRow>
        <TuneRow label="Access">
          {pending ? (
            <ValueSkeleton width={VALUE_SKELETON_WIDTHS.access} />
          ) : (
            <AccessDefault
              name={name}
              autoReview={props.provider.capabilities?.autoReview === true}
              value={props.access}
              onChange={props.onAccessChange}
            />
          )}
        </TuneRow>
        {control ? (
          <TuneRow label="Context">
            {pending || context.phase === 'loading' ? (
              <ValueSkeleton width={VALUE_SKELETON_WIDTHS.context} />
            ) : (
              <ContextDefault
                name={name}
                control={control}
                state={context}
                onChange={props.onContextChange}
              />
            )}
          </TuneRow>
        ) : null}
      </div>
      {props.contextError ? (
        <p className="provider-tune__error" role="alert">
          Could not save the context setting. {props.contextError}
        </p>
      ) : null}
    </div>
  )
}

/**
 * The defaults' frame before any provider is known. The names and wiring are
 * the same for every provider, so only the values are placeholders.
 */
export function ProviderTuningSkeleton() {
  return (
    <div className="provider-tune" aria-hidden>
      <div className="provider-tune__rows">
        <TuneRow label="Model">
          <ValueSkeleton width={VALUE_SKELETON_WIDTHS.model} />
        </TuneRow>
        <TuneRow label="Access">
          <ValueSkeleton width={VALUE_SKELETON_WIDTHS.access} />
        </TuneRow>
        <TuneRow label="Context">
          <ValueSkeleton width={VALUE_SKELETON_WIDTHS.context} />
        </TuneRow>
      </div>
    </div>
  )
}

function TuneRow(props: { label: string; children: ReactNode }) {
  return (
    <div className="provider-tune__row">
      <span className="provider-tune__label">{props.label}</span>
      <span className="provider-tune__leader" aria-hidden />
      <div className="provider-tune__value">{props.children}</div>
    </div>
  )
}

/** Close to the widths of the values they stand in for, so the fill-in barely moves. */
const VALUE_SKELETON_WIDTHS = { model: 64, access: 82, context: 108 } as const

function ValueSkeleton(props: { width: number }) {
  return (
    <span className="tune-skeleton">
      <Skeleton width={props.width} />
      <span className="visually-hidden">Loading</span>
    </span>
  )
}

/** A closed row's value, with a quiet chevron so it reads as something to open. */
function TuneValue(props: {
  open: boolean
  quiet?: boolean
  tone?: string | undefined
  children: ReactNode
}) {
  return (
    <span
      className="tune-value"
      data-open={props.open || undefined}
      data-quiet={props.quiet || undefined}
      data-tone={props.tone}
    >
      {props.children}
      <ChevronDown className="tune-value__chevron" size={12} aria-hidden />
    </span>
  )
}

/** A menu row for panels that also hold other controls, so it stays in the tab order. */
function PanelChoice(props: {
  title: string
  detail?: string
  selected: boolean
  disabled?: boolean
  onClick?: () => void
}) {
  const detailId = useId()
  return (
    <button
      type="button"
      className={`menu__item${props.selected ? ' is-active' : ''}`}
      aria-pressed={props.selected}
      aria-label={props.title}
      aria-describedby={props.detail ? detailId : undefined}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span className="menu__name">
        <span className="menu__label">
          <span>{props.title}</span>
        </span>
        {props.selected ? (
          <span className="menu__meta">
            <Check size={13} aria-hidden />
          </span>
        ) : null}
      </span>
      {props.detail ? (
        <span className="menu__desc" id={detailId}>
          {props.detail}
        </span>
      ) : null}
    </button>
  )
}

function ModelDefault(props: {
  name: string
  models: ModelChoice[]
  pinned: ProviderDefault | undefined
  pinnedName?: string | undefined
  onPinnedChange: (pin: ProviderDefault | undefined) => void
}) {
  const { pinned } = props
  const pinnedChoice = pinned
    ? props.models.find((choice) => choice.model.id === pinned.model)
    : undefined
  const efforts = pinnedChoice?.model.reasoningEfforts ?? []
  const effort = pinnedChoice
    ? (pinned?.effort ?? pinnedChoice.model.defaultReasoningEffort ?? efforts[0])
    : undefined
  const effortLabel = efforts.length > 0 && effort ? getFriendlyEffortLabel(effort) : undefined
  const unavailable =
    pinned && !pinnedChoice ? `${props.pinnedName ?? pinned.model} (unavailable)` : undefined
  const value = pinnedChoice?.model.displayName ?? unavailable ?? 'Last used'

  const pin = (choice: ModelChoice) => {
    const kept = pinned?.effort
    props.onPinnedChange({
      model: choice.model.id,
      ...(kept && choice.model.reasoningEfforts.includes(kept) ? { effort: kept } : {}),
    })
  }

  return (
    <Menu
      align="right"
      drop="down"
      label={`${props.name} default model: ${value}${effortLabel ? `, ${effortLabel}` : ''}`}
      triggerClassName="provider-tune__trigger"
      panelRole="dialog"
      panelLabel={`${props.name} default model`}
      panelClassName="menu--compact provider-tune__menu"
      trigger={(open) => (
        <TuneValue open={open} quiet={!pinned}>
          <span className="tune-value__text">{value}</span>
          {pinnedChoice && effortLabel ? (
            <EffortGlyph efforts={efforts} value={effort} pinned={pinned?.effort !== undefined} />
          ) : null}
        </TuneValue>
      )}
    >
      {(close) => (
        <>
          <PanelChoice
            title="Last used"
            detail="New chats keep the model you used last"
            selected={!pinned}
            onClick={() => {
              if (pinned) props.onPinnedChange(undefined)
              close()
            }}
          />
          {unavailable || props.models.length > 0 ? (
            <>
              <div className="menu__rule" />
              <p className="menu__group">Always start with</p>
            </>
          ) : null}
          {unavailable ? <PanelChoice title={unavailable} selected disabled /> : null}
          {props.models.map((choice) => (
            <PanelChoice
              key={choice.key}
              title={choice.model.displayName}
              selected={choice === pinnedChoice}
              onClick={() => {
                if (choice !== pinnedChoice) pin(choice)
                // A model with effort levels keeps the panel open for them.
                if (choice.model.reasoningEfforts.length === 0) close()
              }}
            />
          ))}
          {pinnedChoice && efforts.length > 0 ? (
            <>
              <div className="menu__rule" />
              <EffortLadder
                ariaLabel={`${props.name} default reasoning`}
                efforts={efforts}
                value={effort}
                pinned={pinned?.effort !== undefined}
                onChange={(next) => {
                  if (next === pinned?.effort) return
                  props.onPinnedChange({ model: pinnedChoice.model.id, effort: next })
                }}
              />
            </>
          ) : null}
        </>
      )}
    </Menu>
  )
}

/** The effort ladder in miniature, so a closed row shows the level without a word. */
function EffortGlyph(props: { efforts: string[]; value: string | undefined; pinned: boolean }) {
  const count = props.efforts.length
  const level = Math.max(0, props.value ? props.efforts.indexOf(props.value) : 0)
  return (
    <span className="effort-glyph" data-pinned={props.pinned || undefined} aria-hidden>
      {props.efforts.map((effort, index) => (
        <span
          key={effort}
          data-lit={index <= level || undefined}
          style={{ '--step': count > 1 ? index / (count - 1) : 1 } as CSSProperties}
        />
      ))}
    </span>
  )
}

/** Effort is ordinal, so it reads as a rising ladder rather than a list of words. */
function EffortLadder(props: {
  ariaLabel: string
  efforts: string[]
  value: string | undefined
  pinned: boolean
  onChange: (effort: string) => void
}) {
  const [preview, setPreview] = useState<number>()
  const steps = useRef<Array<HTMLButtonElement | null>>([])
  const count = props.efforts.length
  const selected = Math.max(0, props.value ? props.efforts.indexOf(props.value) : 0)
  const shown = preview ?? selected

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(count - 1, index + 1)
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, index - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = count - 1
    else return
    event.preventDefault()
    const effort = props.efforts[next]
    if (!effort) return
    steps.current[next]?.focus()
    props.onChange(effort)
  }

  return (
    <div
      className="effort-ladder"
      data-pinned={props.pinned || undefined}
      data-previewing={preview !== undefined || undefined}
    >
      <span className="tune-panel__title">Effort</span>
      {/* Left of the steps, so a longer name grows away from them instead of moving them. */}
      <span className="tune-panel__readout" aria-hidden>
        {getFriendlyEffortLabel(props.efforts[shown])}
        {!props.pinned && preview === undefined ? (
          <span className="tune-panel__quiet"> · default</span>
        ) : null}
      </span>
      <div
        className="effort-ladder__steps"
        role="radiogroup"
        aria-label={props.ariaLabel}
        onPointerLeave={() => setPreview(undefined)}
      >
        {props.efforts.map((effort, index) => (
          <button
            key={effort}
            ref={(element) => {
              steps.current[index] = element
            }}
            className="effort-ladder__step"
            type="button"
            role="radio"
            aria-checked={index === selected}
            aria-label={getFriendlyEffortLabel(effort)}
            tabIndex={index === selected ? 0 : -1}
            data-lit={index <= shown || undefined}
            style={{ '--step': count > 1 ? index / (count - 1) : 1 } as CSSProperties}
            onPointerEnter={() => setPreview(index)}
            onClick={() => {
              setPreview(undefined)
              props.onChange(effort)
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
          />
        ))}
      </div>
    </div>
  )
}

function AccessDefault(props: {
  name: string
  autoReview: boolean
  value: ApprovalMode
  onChange: (mode: ApprovalMode) => void
}) {
  const modes = APPROVAL_MODES.filter((mode) => mode.id !== 'auto-review' || props.autoReview)
  const current = modes.find((mode) => mode.id === props.value) ?? modes[0]!
  const Icon = current.icon
  return (
    <Menu
      align="right"
      drop="down"
      label={`${props.name} default access: ${current.short}`}
      triggerClassName="provider-tune__trigger"
      panelLabel={`${props.name} default access`}
      panelClassName="menu--compact menu--permissions"
      trigger={(open) => (
        <TuneValue open={open} tone={current.id}>
          <Icon className="tune-value__icon" size={13} aria-hidden />
          <span className="tune-value__text">{current.short}</span>
        </TuneValue>
      )}
    >
      {(close) =>
        modes.map((mode) => {
          const ModeIcon = mode.icon
          return (
            <MenuItem
              key={mode.id}
              title={mode.title}
              detail={
                mode.id === 'auto-review' ? `${props.name} reviews elevated actions` : mode.detail
              }
              icon={<ModeIcon size={14} aria-hidden />}
              className={`composer__permission-option composer__permission-option--${mode.id}`}
              active={mode.id === props.value}
              checked={mode.id === props.value}
              onClick={() => {
                if (mode.id !== props.value) props.onChange(mode.id)
                close()
              }}
            />
          )
        })
      }
    </Menu>
  )
}

/** The composer's context ring in miniature, filled to the compaction point. */
function ContextGlyph(props: { at: number }) {
  return (
    <svg
      className="ctx-glyph"
      viewBox="0 0 16 16"
      width={13}
      height={13}
      aria-hidden
      style={{ '--at': props.at } as CSSProperties}
    >
      <circle className="ctx-glyph__track" cx="8" cy="8" r="6" />
      <circle className="ctx-glyph__fill" cx="8" cy="8" r="6" pathLength="100" />
    </svg>
  )
}

function ContextDefault(props: {
  name: string
  control: ContextControl
  state: Exclude<ProviderContextState, { phase: 'loading' }>
  onChange: (settings: ProviderContextSettings) => void
}) {
  const { control } = props
  const settings = props.state.phase === 'ready' ? props.state.settings : undefined
  // Held here rather than in the ruler so the closed row follows a drag live.
  const [draft, setDraft] = useState<CompactionDraft>()

  if (props.state.phase === 'error') {
    return (
      <span className="provider-tune__unavailable" title={props.state.message}>
        Unavailable
      </span>
    )
  }

  const { defaultAt } = compactionBounds(control)
  const saved = settings?.compactAt
  const off = saved === 'off'
  const point = typeof saved === 'number' ? saved : undefined
  const current = draft ? draft.value : point
  const shown = current ?? defaultAt
  const customized = settings?.window !== undefined || saved !== undefined
  const summary = contextSummary(settings?.window, off ? 'off' : shown)

  const save = (next: { window: number | undefined; compactAt: CompactAt | undefined }) => {
    props.onChange({
      ...(next.window !== undefined ? { window: next.window } : {}),
      ...(next.compactAt !== undefined ? { compactAt: next.compactAt } : {}),
    })
  }

  return (
    <Menu
      align="right"
      drop="down"
      label={`${props.name} context: ${summary}`}
      triggerClassName="provider-tune__trigger"
      panelRole="dialog"
      panelLabel={`${props.name} context`}
      panelClassName="menu--compact provider-tune__menu provider-tune__menu--context"
      trigger={(open) => (
        <TuneValue open={open} quiet={!customized && !draft}>
          <ContextGlyph at={off ? 100 : shown} />
          <span className="tune-value__text">{summary}</span>
        </TuneValue>
      )}
    >
      {() => (
        <div className="tune-panel">
          <section className="tune-panel__section">
            <div className="tune-panel__head">
              <span className="tune-panel__title">Window</span>
              {control.windows.length > 1 ? (
                <Segmented
                  ariaLabel={`${props.name} context window`}
                  value={settings?.window === undefined ? AUTO_WINDOW : String(settings.window)}
                  options={[
                    { value: AUTO_WINDOW, label: 'Auto', title: "The model's own window" },
                    ...control.windows.map((window) => ({
                      value: String(window),
                      label: formatTokens(window),
                    })),
                  ]}
                  onChange={(value) =>
                    save({
                      window: value === AUTO_WINDOW ? undefined : Number(value),
                      compactAt: saved,
                    })
                  }
                />
              ) : (
                <span className="tune-panel__readout">{formatTokens(control.windows[0] ?? 0)}</span>
              )}
            </div>
          </section>
          <section className="tune-panel__section">
            <div className="tune-panel__head">
              <span className="tune-panel__title">Compact at</span>
              <span className="tune-panel__readout">
                {off ? 'Off' : `${shown}%`}
                {!off && current === undefined ? (
                  <span className="tune-panel__quiet"> · default</span>
                ) : null}
              </span>
            </div>
            <ContextRuler
              name={props.name}
              control={control}
              compactAt={point}
              off={off}
              draft={draft}
              onDraft={setDraft}
              onCommit={(compactAt) => save({ window: settings?.window, compactAt })}
            />
          </section>
          {control.compactionOff ? (
            <div className="tune-panel__switch">
              <span>Compact automatically</span>
              <button
                className={`switch${off ? '' : ' is-on'}`}
                type="button"
                role="switch"
                aria-label={`Compact ${props.name} chats automatically`}
                aria-checked={!off}
                onClick={() =>
                  save({ window: settings?.window, compactAt: off ? undefined : 'off' })
                }
              >
                <span className="switch__thumb" />
              </button>
            </div>
          ) : null}
          {customized ? (
            <button
              className="tune-panel__reset"
              type="button"
              aria-label={`Reset ${props.name} context to its defaults`}
              onClick={() => props.onChange({})}
            >
              <RotateCcw size={12} aria-hidden />
              Reset to defaults
            </button>
          ) : null}
        </div>
      )}
    </Menu>
  )
}

/** A few equal choices side by side, the chosen one raised. */
function Segmented(props: {
  ariaLabel: string
  value: string
  options: readonly { value: string; label: string; title?: string }[]
  onChange: (value: string) => void
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const selected = props.options.findIndex((option) => option.value === props.value)
  const focusable = selected >= 0 ? selected : 0

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = props.options.length
    let next: number
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % count
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (index - 1 + count) % count
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = count - 1
    else return
    event.preventDefault()
    const option = props.options[next]
    if (!option) return
    buttons.current[next]?.focus()
    if (option.value !== props.value) props.onChange(option.value)
  }

  return (
    <div className="tune-segmented" role="radiogroup" aria-label={props.ariaLabel}>
      {props.options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => {
            buttons.current[index] = element
          }}
          className="tune-segmented__option"
          type="button"
          role="radio"
          aria-checked={index === selected}
          tabIndex={index === focusable ? 0 : -1}
          title={option.title}
          onClick={() => {
            if (option.value !== props.value) props.onChange(option.value)
          }}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/**
 * The context window drawn to scale. The solid line is what a session fills
 * before it compacts, the dotted rest is the headroom the engine keeps, and
 * the notch between them is the compaction point. With compaction off the
 * line runs solid to the end and holds still.
 */
function ContextRuler(props: {
  name: string
  control: ContextControl
  /** The saved point; undefined is the engine's own. */
  compactAt: number | undefined
  off: boolean
  draft: CompactionDraft | undefined
  onDraft: (draft: CompactionDraft | undefined) => void
  onCommit: (compactAt: number | undefined) => void
}) {
  const { control, draft, onDraft } = props
  const { latest, defaultAt } = compactionBounds(control)
  const movable = control.compaction && !props.off
  const [dragging, setDragging] = useState(false)
  const track = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLSpanElement>(null)

  const current = draft ? draft.value : props.compactAt
  const value = current ?? defaultAt
  const at = props.off ? 100 : value
  const state = props.off ? 'off' : current === undefined ? 'default' : 'custom'

  /** The engine's own point is stored as no setting at all. */
  const settle = (next: number): number | undefined => {
    const clamped = Math.min(latest, Math.max(EARLIEST_COMPACT_AT, Math.round(next)))
    return clamped === defaultAt ? undefined : clamped
  }

  const fromPointer = (clientX: number): number | undefined => {
    const bounds = track.current?.getBoundingClientRect()
    if (!bounds || bounds.width <= 0) return current
    const percent = ((clientX - bounds.left) / bounds.width) * 100
    if (Math.abs(percent - defaultAt) <= DEFAULT_SNAP) return undefined
    return settle(percent)
  }

  const finish = (next: number | undefined) => {
    onDraft(undefined)
    if (next !== props.compactAt) props.onCommit(next)
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!movable || event.button !== 0) return
    event.preventDefault()
    track.current?.setPointerCapture?.(event.pointerId)
    thumb.current?.focus({ preventScroll: true })
    setDragging(true)
    onDraft({ value: fromPointer(event.clientX) })
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging) onDraft({ value: fromPointer(event.clientX) })
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    setDragging(false)
    finish(fromPointer(event.clientX))
  }
  const onPointerCancel = () => {
    setDragging(false)
    onDraft(undefined)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (!movable) return
    let next: number
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = value + 1
        break
      case 'ArrowLeft':
      case 'ArrowDown':
        next = value - 1
        break
      case 'PageUp':
        next = value + 10
        break
      case 'PageDown':
        next = value - 10
        break
      case 'Home':
        next = EARLIEST_COMPACT_AT
        break
      case 'End':
        next = latest
        break
      case 'Delete':
      case 'Backspace':
        event.preventDefault()
        onDraft({ value: undefined })
        return
      default:
        return
    }
    event.preventDefault()
    onDraft({ value: settle(next) })
  }

  const valueText = props.off
    ? 'Never compacts on its own'
    : `Compacts at ${value}% of the window${current === undefined ? ', the default' : ''}`

  return (
    <div
      className="ctx-ruler"
      data-state={state}
      data-dragging={dragging || undefined}
      data-disabled={!movable || undefined}
      style={{ '--at': `${at}%`, '--default-at': `${defaultAt}%` } as CSSProperties}
    >
      <div
        ref={track}
        className="ctx-ruler__track"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <span className="ctx-ruler__rest" aria-hidden />
        <span className="ctx-ruler__fill" aria-hidden />
        <span className="ctx-ruler__tick" style={{ left: '25%' }} aria-hidden />
        <span className="ctx-ruler__tick" style={{ left: '50%' }} aria-hidden />
        <span className="ctx-ruler__tick" style={{ left: '75%' }} aria-hidden />
        {state === 'custom' ? <span className="ctx-ruler__default" aria-hidden /> : null}
        <span
          ref={thumb}
          className="ctx-ruler__thumb"
          role="slider"
          tabIndex={movable ? 0 : -1}
          aria-label={`${props.name} compaction point`}
          aria-valuemin={EARLIEST_COMPACT_AT}
          aria-valuemax={latest}
          aria-valuenow={at}
          aria-valuetext={valueText}
          aria-disabled={!movable || undefined}
          onKeyDown={onKeyDown}
          onKeyUp={() => {
            if (draft && !dragging) finish(draft.value)
          }}
          onBlur={() => {
            if (draft && !dragging) finish(draft.value)
          }}
        />
      </div>
    </div>
  )
}
