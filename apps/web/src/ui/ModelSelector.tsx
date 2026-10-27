import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from 'react'
import { DEFAULT_ACCOUNT_ID } from '@harness/contracts'
import { IconChevronDown as ChevronDown, IconBolt as Zap } from '@tabler/icons-react'
import { isMacOS } from '../bridge.js'
import { preloadWhenIdle } from '../idle-preload.js'
import { readModelPickerLayout, subscribeModelPickerLayout } from '../model-picker-layout.js'
import { activeAccountOf } from '../provider-accounts-state.js'
import { shortcutAria, shortcutLabel, type Shortcut } from '../shortcuts.js'
import { Menu, type MenuHandle } from './Menu.js'
import { ModelLedgerFrameContext, type ModelLedgerData } from './model-ledger-context.js'
import { ProviderIcon } from './ProviderIcon.js'
import { SkeletonRows, SkeletonStatus } from './Skeleton.js'
import {
  getCompactModelName,
  getEffortWord,
  getFriendlyEffortLabel,
  getSelectedChoice,
  getSelectedEffort,
  isFastModeEnabled,
  modelSourceKey,
  type ModelSelectorProps,
} from './model-selector-utils.js'
import '../styles/model-selector.css'

const TRIGGER_LABEL = 'Model and reasoning'
const DIALOG_LABEL = 'Model and reasoning'
type ModelSelectorPanelModule = typeof import('./ModelSelectorPanel.js')
type ModelSelectorPanelComponent = ModelSelectorPanelModule['ModelSelectorPanel']
type LazyModelSelectorPanelModule = {
  default: ModelSelectorPanelComponent
}

let modelSelectorPanelPromise: Promise<LazyModelSelectorPanelModule> | undefined
let resolvedModelSelectorPanel: ModelSelectorPanelComponent | undefined
/** One import for the idle preload, the trigger intent and the open; a failed one is tried again by the next caller. */
const loadModelSelectorPanel = (): Promise<LazyModelSelectorPanelModule> =>
  (modelSelectorPanelPromise ??= import('./ModelSelectorPanel.js').then(
    (module) => {
      resolvedModelSelectorPanel = module.ModelSelectorPanel
      return { default: module.ModelSelectorPanel }
    },
    (error: unknown) => {
      modelSelectorPanelPromise = undefined
      throw error
    },
  ))
const ModelSelectorPanel = lazy(loadModelSelectorPanel)
/** Set once the first selector on screen asked for the panel to load in an idle moment. */
let panelPreloadScheduled = false

/**
 * The ledger layout's trigger, tooltip and effort HUD styles, and its panel.
 * Loaded only once someone picks the ledger, so List and Rail start as before.
 */
let ledgerPreloaded = false
function preloadLedger(): void {
  if (ledgerPreloaded) return
  ledgerPreloaded = true
  void import('../styles/model-ledger-trigger.css')
  preloadWhenIdle(() => import('./ModelLedgerPanel.js'))
}

/** How long the effort HUD stays after the last step. */
const HUD_MS = 1600
/** The ledger's height bounds: a new chat opens below the composer, a chat above it. */
const LEDGER_MIN_H = 260
/** A new chat opens downward only with at least this much room below. */
const LEDGER_MIN_DOWN = 280
const LEDGER_NEW_CHAT_MAX_H = 420
const LEDGER_CHAT_MAX_H = 452
/** Menu gap, viewport gutter and the panel's border, as Menu positions panels. */
const LEDGER_EDGE = 6 + 8 + 2 + 2

export {
  getCompactModelName,
  getEffortIndexFromPointer,
  getEffortProgressFromPointer,
  getFastModeOffValue,
  getFastServiceTier,
  getFriendlyEffortLabel,
  getNextServiceTierForModel,
  groupModelsBySource,
} from './model-selector-utils.js'
export type { ModelSelectorProps } from './model-selector-utils.js'

/** What the app may ask of the picker from a keyboard shortcut. */
export type ModelPickerHandle = {
  /** Opens the picker, or closes it when it is open. */
  toggle: () => void
  /** Raises the effort one level, back to the lowest after the highest. */
  stepEffort: () => void
}

/** Everything beyond `ModelSelectorProps` is optional; List and Rail ignore it. */
export type ModelSelectorExtras = {
  /** Plan limits, accounts, the open chat and listing state, for the ledger layout. */
  ledger?: ModelLedgerData | undefined
  pickerRef?: Ref<ModelPickerHandle> | undefined
  /** The shortcut that opens the picker, named in the ledger's tooltip. */
  openShortcut?: Shortcut | null | undefined
}

export const ModelSelector = memo(function ModelSelector(
  props: ModelSelectorProps & ModelSelectorExtras,
) {
  // The panel is its own chunk. Loading it in an idle moment keeps the first
  // open from compiling and styling it on the click.
  useEffect(() => {
    if (panelPreloadScheduled) return
    panelPreloadScheduled = true
    preloadWhenIdle(loadModelSelectorPanel)
  }, [])
  const layout = useSyncExternalStore(
    subscribeModelPickerLayout,
    readModelPickerLayout,
    readModelPickerLayout,
  )
  const ledgerLayout = layout === 'ledger'
  useEffect(() => {
    if (ledgerLayout) preloadLedger()
  }, [ledgerLayout])

  const menu = useRef<MenuHandle>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const [ledgerHeight, setLedgerHeight] = useState(LEDGER_NEW_CHAT_MAX_H)
  const [ledgerDrop, setLedgerDrop] = useState<'up' | 'down'>('up')
  const [hudShown, setHudShown] = useState(0)

  const choice = props.choice ?? getSelectedChoice(props.models, props.modelId)
  const model = choice?.model
  const selectedEffort = getSelectedEffort(model, props.effort)
  const effortLabel = getFriendlyEffortLabel(selectedEffort)
  const effortOptions = model?.reasoningEfforts ?? []
  const effortIndex = selectedEffort === undefined ? -1 : effortOptions.indexOf(selectedEffort)
  const fastEnabled = isFastModeEnabled(model, props.serviceTier)

  // The handle stays one object; it reads the newest values when called.
  const latest = useRef({ effortOptions, selectedEffort, onEffortChange: props.onEffortChange })
  latest.current = { effortOptions, selectedEffort, onEffortChange: props.onEffortChange }
  useImperativeHandle(
    props.pickerRef,
    () => ({
      toggle: () => {
        if (menu.current?.isOpen()) menu.current.close()
        else menu.current?.open()
      },
      stepEffort: () => {
        const { effortOptions: efforts, selectedEffort: effort, onEffortChange } = latest.current
        if (efforts.length > 0) {
          const index = effort === undefined ? -1 : efforts.indexOf(effort)
          const next = efforts[(index + 1) % efforts.length]
          if (next && next !== effort) onEffortChange(next)
        }
        setHudShown(Date.now())
      },
    }),
    [],
  )
  useEffect(() => {
    if (!hudShown) return
    const timer = window.setTimeout(() => setHudShown(0), HUD_MS)
    return () => window.clearTimeout(timer)
  }, [hudShown])

  /**
   * Fits the ledger to the room beside the trigger before the menu measures
   * it. A new chat opens downward, so the heading above the composer stays in
   * view; a chat (or a composer at the window's foot) opens over the transcript.
   */
  const fitLedger = () => {
    const bounds = anchor.current?.getBoundingClientRect()
    if (!bounds) return
    const below = window.innerHeight - bounds.bottom - LEDGER_EDGE
    const above = bounds.top - LEDGER_EDGE
    const down = props.ledger?.chat === undefined && below >= LEDGER_MIN_DOWN
    const room = down ? below : above
    const max = down ? LEDGER_NEW_CHAT_MAX_H : LEDGER_CHAT_MAX_H
    setLedgerDrop(down ? 'down' : 'up')
    setLedgerHeight(Math.round(Math.max(LEDGER_MIN_H, Math.min(max, room))))
  }

  const name = getCompactModelName(model?.displayName)
  const account = ledgerLayout && choice ? accountNameOf(props.ledger, choice) : undefined
  // Only the ledger's tooltip names the keys; List and Rail never read the platform.
  const keys = ledgerLayout && props.openShortcut ? shortcutKeys(props.openShortcut) : []

  const selector = (
    <Menu
      align="right"
      {...(ledgerLayout ? { drop: ledgerDrop } : {})}
      disabled={props.disabled}
      label={TRIGGER_LABEL}
      triggerClassName={`menutrigger--model-selector${ledgerLayout ? ' menutrigger--model-ledger' : ''}`}
      panelRole="dialog"
      panelLabel={DIALOG_LABEL}
      panelClassName={`model-selector__menu${ledgerLayout ? ' model-ledger__menu' : ''}`}
      shortcutAria={shortcutAria(props.openShortcut)}
      handleRef={menu}
      onOpen={() => {
        if (ledgerLayout) {
          fitLedger()
          setHudShown(0)
        }
        props.onOpen?.()
      }}
      onTriggerIntent={() => {
        void loadModelSelectorPanel()
        if (ledgerLayout) void import('./ModelLedgerPanel.js')
      }}
      trigger={(open) =>
        ledgerLayout ? (
          <span className={`model-selector__trigger model-ledger-trigger${open ? ' is-open' : ''}`}>
            <span className="model-selector__trigger-model">
              {choice ? <ProviderIcon mark={choice.mark} size={14} /> : null}
              <span className="model-selector__trigger-name">{name}</span>
            </span>
            {effortOptions.length > 0 && selectedEffort ? (
              <>
                <span className="model-ledger-trigger__sep" aria-hidden />
                <EffortDial efforts={effortOptions} effort={selectedEffort} />
                <span className="model-selector__trigger-effort">
                  {getEffortWord(selectedEffort)}
                </span>
              </>
            ) : null}
            {fastEnabled ? (
              <span className="model-ledger-trigger__fast" aria-hidden>
                <Zap size={12} />
              </span>
            ) : null}
            <span className="model-selector__trigger-chevron" aria-hidden>
              <ChevronDown size={15} />
            </span>
          </span>
        ) : (
          <span className={`model-selector__trigger${open ? ' is-open' : ''}`}>
            {fastEnabled ? (
              <span className="model-selector__trigger-fast" aria-hidden>
                <Zap size={13} fill="currentColor" />
              </span>
            ) : null}
            <span className="model-selector__trigger-copy">
              <span className="model-selector__trigger-model">
                {choice ? <ProviderIcon mark={choice.mark} size={14} /> : null}
                <span className="model-selector__trigger-name">
                  {getCompactModelName(model?.displayName)}
                </span>
              </span>
              {effortOptions.length > 1 && effortIndex >= 0 ? (
                <span className="model-selector__trigger-level" aria-hidden>
                  {effortOptions.map((option, index) => (
                    <span
                      key={option}
                      className={`model-selector__trigger-dot${index <= effortIndex ? ' is-filled' : ''}`}
                    />
                  ))}
                </span>
              ) : null}
              <span className="model-selector__trigger-effort">{effortLabel}</span>
            </span>
            <span className="model-selector__trigger-chevron" aria-hidden>
              <ChevronDown size={15} />
            </span>
          </span>
        )
      }
    >
      {(close) => {
        const ResolvedModelSelectorPanel = resolvedModelSelectorPanel
        const panel = ResolvedModelSelectorPanel ? (
          <ResolvedModelSelectorPanel {...props} />
        ) : (
          <Suspense
            fallback={
              <SkeletonStatus label="Loading models…" className="model-selector__loading">
                <SkeletonRows rows={5} icon />
              </SkeletonStatus>
            }
          >
            <ModelSelectorPanel {...props} />
          </Suspense>
        )
        return (
          <ModelLedgerFrameContext.Provider value={{ close, height: ledgerHeight }}>
            {panel}
          </ModelLedgerFrameContext.Provider>
        )
      }}
    </Menu>
  )

  if (!ledgerLayout) return selector
  return (
    <span className="model-ledger-anchor" ref={anchor}>
      {selector}
      {hudShown ? (
        <span className="model-ledger-hud" role="status">
          {effortOptions.length > 0 ? (
            <>
              <span className="model-ledger-hud__label">Effort</span>
              {effortOptions.map((level) => (
                <span
                  key={level}
                  className={`model-ledger-hud__level${level === selectedEffort ? ' is-on' : ''}`}
                >
                  {getEffortWord(level)}
                </span>
              ))}
            </>
          ) : (
            <span className="model-ledger-hud__label">{name} has no effort setting</span>
          )}
        </span>
      ) : (
        <span className="model-ledger-tip" aria-hidden>
          <span className="model-ledger-tip__line">
            {name}
            {selectedEffort && effortOptions.length > 0
              ? ` · ${getEffortWord(selectedEffort)} effort`
              : ''}
            {fastEnabled ? ' · Fast' : ''}
          </span>
          <span className="model-ledger-tip__sub">
            {[choice?.sourceName, account].filter(Boolean).join(' · ')}
          </span>
          {keys.length > 0 ? (
            <span className="model-ledger-tip__keys">
              {keys.map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
            </span>
          ) : null}
        </span>
      )}
    </span>
  )
})

/**
 * A small dial instead of a row of dots: a half-circle track filled up to the
 * level's place on the model's own scale, with a needle.
 */
function EffortDial(props: { efforts: readonly string[]; effort: string }) {
  const count = props.efforts.length
  const index = Math.max(0, props.efforts.indexOf(props.effort))
  const fraction = count <= 1 ? 1 : 0.12 + (0.88 * index) / (count - 1)
  const cx = 8
  const cy = 9
  const radius = 6.4
  const point = (at: number, length = radius) =>
    [cx - length * Math.cos(Math.PI * at), cy - length * Math.sin(Math.PI * at)] as const
  const [x0, y0] = point(0)
  const [x1, y1] = point(1)
  const [xf, yf] = point(fraction)
  const [xn, yn] = point(fraction, 3.6)
  const f = (value: number) => value.toFixed(2)
  return (
    <svg className="model-ledger-dial" viewBox="0 0 16 10.5" width={16} height={10.5} aria-hidden>
      <path d={`M${f(x0)} ${f(y0)} A${radius} ${radius} 0 0 1 ${f(x1)} ${f(y1)}`} />
      <path
        className="is-on"
        d={`M${f(x0)} ${f(y0)} A${radius} ${radius} 0 0 1 ${f(xf)} ${f(yf)}`}
      />
      <path className="is-needle" d={`M${cx} ${cy} L${f(xn)} ${f(yn)}`} />
    </svg>
  )
}

/** The account a model runs as, by name, where the provider lists accounts. */
function accountNameOf(
  ledger: ModelLedgerData | undefined,
  choice: NonNullable<ModelSelectorProps['choice']>,
): string | undefined {
  const accounts = ledger?.accounts
  if (!accounts || choice.agent || choice.connectionId) return undefined
  const chat = ledger.chat
  const id =
    choice.accountId ??
    (chat && modelSourceKey(choice) === chat.source
      ? (chat.accountId ?? DEFAULT_ACCOUNT_ID)
      : activeAccountOf(accounts, choice.provider))
  const listed = accounts.accounts.find(
    (account) => account.provider === choice.provider && account.id === id,
  )
  return listed ? (listed.email ?? listed.label) : undefined
}

/** "Ctrl", "M" on Windows and Linux; one "⌘M" cap on macOS. */
function shortcutKeys(shortcut: Shortcut): string[] {
  const macOS = isMacOS()
  const label = shortcutLabel(shortcut, macOS)
  return macOS ? [label] : label.split('+')
}
