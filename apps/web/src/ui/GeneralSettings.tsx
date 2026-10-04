import {
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import type { SidebarSettings } from '@harness/contracts'
import {
  readModelPickerLayout,
  subscribeModelPickerLayout,
  writeModelPickerLayout,
  type ModelPickerLayout,
} from '../model-picker-layout.js'
import {
  readTerminalPlacement,
  subscribeTerminalPlacement,
  writeTerminalPlacement,
  type TerminalPlacement,
} from '../terminal-placement.js'
import '../styles/general-settings.css'

/** The part of the window a setting decides, lit in the plan while the setting is in focus. */
type PlanPart = 'sidebar' | 'settle' | 'terminal' | 'picker'

type SidebarMode = SidebarSettings['mode']
/** `null` is "never", the stop past the 90-day end of the scale. */
type SettleDays = SidebarSettings['autoSettleDays']

const SIDEBAR_OPTIONS = [
  { value: 'classic', label: 'Classic' },
  { value: 'inbox', label: 'Inbox' },
] as const satisfies ReadonlyArray<{ value: SidebarMode; label: string }>

const TERMINAL_OPTIONS = [
  { value: 'bottom', label: 'Bottom' },
  { value: 'workspace', label: 'Right' },
] as const satisfies ReadonlyArray<{ value: TerminalPlacement; label: string }>

const PICKER_OPTIONS = [
  { value: 'list', label: 'List' },
  { value: 'rail', label: 'Rail' },
] as const satisfies ReadonlyArray<{ value: ModelPickerLayout; label: string }>

function caption(part: PlanPart, days: SettleDays): string {
  if (part === 'sidebar') {
    return 'Classic files chats under their projects. Inbox lines them up by last activity.'
  }
  if (part === 'settle') {
    return days === null
      ? 'Chats stay in the inbox until you settle them yourself.'
      : `Chats untouched for ${dayCount(days)} fold into Settled. New activity brings them back.`
  }
  if (part === 'terminal') return 'Where the Toggle terminal shortcut opens a terminal.'
  return 'Rail picks a provider first, then its models. List shows every model in one scroll.'
}

function dayCount(days: number): string {
  return days === 1 ? '1 day' : `${days} days`
}

/**
 * General is a drawing of the window it arranges. Each setting is one line of
 * the legend, and the plan beside it redraws what that line decides: the
 * sidebar regroups, idle chats fold away, the terminal moves, the model picker
 * opens to show its layout.
 */
export function GeneralSettings(props: {
  sidebarSettings: SidebarSettings
  onSidebarSettingsChange: (settings: Partial<SidebarSettings>) => void
}) {
  const picker = useSyncExternalStore(subscribeModelPickerLayout, readModelPickerLayout)
  const terminal = useSyncExternalStore(
    subscribeTerminalPlacement,
    readTerminalPlacement,
    readTerminalPlacement,
  )
  const [hovered, setHovered] = useState<PlanPart>()
  const [focused, setFocused] = useState<PlanPart>()
  // The caption keeps its last words while it fades out.
  const [described, setDescribed] = useState<PlanPart>()
  // While the settle scale is dragged the plan follows the pointer; the
  // server only hears the value the pointer lets go at.
  const [draftDays, setDraftDays] = useState<SettleDays | undefined>()
  const lit = hovered ?? focused
  if (lit && lit !== described) setDescribed(lit)

  const mode = props.sidebarSettings.mode
  const days = draftDays === undefined ? props.sidebarSettings.autoSettleDays : draftDays
  const inbox = mode === 'inbox'

  const leave = (part: PlanPart) =>
    setHovered((current) => (current === part ? undefined : current))
  const track = (part: PlanPart): Track => ({
    'data-lit': lit === part || undefined,
    onPointerEnter: () => setHovered(part),
    onPointerLeave: () => leave(part),
    onFocus: () => setFocused(part),
    onBlur: () => setFocused((current) => (current === part ? undefined : current)),
  })

  return (
    <section className="settings__panel" aria-labelledby="settings-general">
      <h1 className="settings__title" id="settings-general">
        General
      </h1>
      <div className="general">
        <div className="general__legend">
          <LegendLine name="Sidebar" track={track('sidebar')}>
            {(labelId) => (
              <Choice
                labelId={labelId}
                value={mode}
                options={SIDEBAR_OPTIONS}
                onChange={(next) => props.onSidebarSettingsChange({ mode: next })}
              />
            )}
          </LegendLine>
          <div
            className="general-settle"
            data-open={inbox || undefined}
            inert={!inbox}
            aria-hidden={!inbox || undefined}
          >
            <div className="general-settle__inner" {...track('settle')}>
              <SettleScale
                days={days}
                onDraft={setDraftDays}
                onCommit={(next) => {
                  setDraftDays(undefined)
                  if (next !== props.sidebarSettings.autoSettleDays) {
                    props.onSidebarSettingsChange({ autoSettleDays: next })
                  }
                }}
              />
            </div>
          </div>
          <LegendLine name="Terminal" track={track('terminal')}>
            {(labelId) => (
              <Choice
                labelId={labelId}
                value={terminal}
                options={TERMINAL_OPTIONS}
                onChange={writeTerminalPlacement}
              />
            )}
          </LegendLine>
          <LegendLine name="Model picker" track={track('picker')}>
            {(labelId) => (
              <Choice
                labelId={labelId}
                value={picker}
                options={PICKER_OPTIONS}
                onChange={writeModelPickerLayout}
              />
            )}
          </LegendLine>
        </div>
        <figure className="general__figure">
          <WindowPlan
            mode={mode}
            days={days}
            terminal={terminal}
            picker={picker}
            lit={lit}
            onHover={setHovered}
            onLeave={leave}
          />
          <figcaption className="general__caption" data-shown={lit ? true : undefined}>
            {described ? caption(described, days) : null}
          </figcaption>
        </figure>
      </div>
    </section>
  )
}

/** Hover and focus handlers that light one part of the plan. */
type Track = {
  'data-lit': true | undefined
  onPointerEnter: () => void
  onPointerLeave: () => void
  onFocus: () => void
  onBlur: () => void
}

function LegendLine(props: {
  name: string
  track: Track
  children: (labelId: string) => ReactNode
}) {
  const labelId = useId()
  return (
    <div className="general-line" {...props.track}>
      <p className="general-line__name" id={labelId}>
        {props.name}
      </p>
      {props.children(labelId)}
    </div>
  )
}

/** Two words, not a segmented control: the chosen one is set in full ink and underlined. */
function Choice<T extends string>(props: {
  labelId: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const choose = (index: number) => {
    const option = props.options[index]
    if (option && option.value !== props.value) props.onChange(option.value)
  }
  const onKeyDown = (event: ReactKeyboardEvent, index: number) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    if (step === 0) return
    event.preventDefault()
    const next = (index + step + props.options.length) % props.options.length
    choose(next)
    buttons.current[next]?.focus()
  }
  return (
    <div className="general-choice" role="radiogroup" aria-labelledby={props.labelId}>
      {props.options.map((option, index) => {
        const checked = option.value === props.value
        return (
          <button
            key={option.value}
            ref={(button) => {
              buttons.current[index] = button
            }}
            className="general-choice__option"
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => choose(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

// The scale is logarithmic: a day matters at the short end and barely
// registers at the long one. "Never" is one stop past its end.
const SETTLE_MAX = 90
const NEVER_STOP = SETTLE_MAX + 1
const SETTLE_TICKS = [1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 30, 45, 60, 90] as const
const SETTLE_LABELS = [1, 3, 7, 14, 30, 90] as const
const LABELLED_DAYS = new Set<number>(SETTLE_LABELS)
/** Room after the 90-day end for the dotted run out to "never", in px. */
const SETTLE_TAIL = 64

type AtStyle = CSSProperties & { '--at': number }

function settleStop(days: SettleDays): number {
  return days ?? NEVER_STOP
}

function stopDays(stop: number): SettleDays {
  return stop >= NEVER_STOP ? null : Math.min(SETTLE_MAX, Math.max(1, stop))
}

function runPosition(days: number): number {
  return Math.log(days) / Math.log(SETTLE_MAX)
}

function atStyle(days: SettleDays): AtStyle {
  return { '--at': days === null ? -1 : runPosition(days) }
}

function SettleScale(props: {
  days: SettleDays
  /** `undefined` drops the draft and shows the saved value again. */
  onDraft: (days: SettleDays | undefined) => void
  onCommit: (days: SettleDays) => void
}) {
  const nameId = useId()
  const dragging = useRef<SettleDays | undefined>(undefined)
  const [grabbing, setGrabbing] = useState(false)
  const stop = settleStop(props.days)

  const daysAt = (element: HTMLElement, clientX: number): SettleDays => {
    const box = element.getBoundingClientRect()
    const run = box.width - SETTLE_TAIL
    const x = clientX - box.left
    if (x > run + SETTLE_TAIL / 2) return null
    const position = Math.min(1, Math.max(0, x / run))
    return stopDays(Math.round(Math.exp(position * Math.log(SETTLE_MAX))))
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.focus()
    const next = daysAt(event.currentTarget, event.clientX)
    dragging.current = next
    setGrabbing(true)
    props.onDraft(next)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging.current === undefined) return
    const next = daysAt(event.currentTarget, event.clientX)
    if (next === dragging.current) return
    dragging.current = next
    props.onDraft(next)
  }
  const release = (commit: boolean) => {
    const next = dragging.current
    dragging.current = undefined
    setGrabbing(false)
    if (next === undefined) return
    if (commit) props.onCommit(next)
    else props.onDraft(undefined)
  }

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const labelled = [...SETTLE_LABELS, NEVER_STOP]
    let next: number | undefined
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = stop + 1
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = stop - 1
    else if (event.key === 'PageUp') next = labelled.find((label) => label > stop)
    else if (event.key === 'PageDown') next = labelled.findLast((label) => label < stop)
    else if (event.key === 'Home') next = 1
    else if (event.key === 'End') next = NEVER_STOP
    if (next === undefined) return
    event.preventDefault()
    const days = stopDays(Math.min(NEVER_STOP, Math.max(1, next)))
    if (days !== props.days) props.onCommit(days)
  }

  const valueText = props.days === null ? 'Never' : dayCount(props.days)
  return (
    <>
      <div className="general-settle__head">
        <p className="general-settle__name" id={nameId}>
          Settle idle chats
        </p>
        <p className="general-settle__value" aria-hidden>
          {props.days === null ? 'never' : `after ${dayCount(props.days)}`}
        </p>
      </div>
      <div
        className="settle-scale"
        role="slider"
        tabIndex={0}
        aria-labelledby={nameId}
        aria-valuemin={1}
        aria-valuemax={NEVER_STOP}
        aria-valuenow={stop}
        aria-valuetext={valueText}
        data-grabbing={grabbing || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => release(true)}
        onPointerCancel={() => release(false)}
        onKeyDown={onKeyDown}
      >
        <span className="settle-scale__run" aria-hidden />
        <span className="settle-scale__tail" aria-hidden />
        {SETTLE_TICKS.map((days) => (
          <span
            key={days}
            className="settle-scale__tick"
            data-major={LABELLED_DAYS.has(days) || undefined}
            style={atStyle(days)}
            aria-hidden
          />
        ))}
        <span
          className="settle-scale__tick"
          data-major
          data-never
          style={atStyle(null)}
          aria-hidden
        />
        {SETTLE_LABELS.map((days, index) => (
          <span
            key={days}
            className="settle-scale__label"
            data-edge={index === 0 ? 'start' : undefined}
            data-current={props.days === days || undefined}
            style={atStyle(days)}
            aria-hidden
          >
            {days}
          </span>
        ))}
        <span
          className="settle-scale__label"
          data-never
          data-edge="end"
          data-current={props.days === null || undefined}
          style={atStyle(null)}
          aria-hidden
        >
          never
        </span>
        <span
          className="settle-scale__needle"
          data-never={props.days === null || undefined}
          style={atStyle(props.days)}
          aria-hidden
        />
      </div>
    </>
  )
}

// A week of chats across two projects, newest first. Their ages are what the
// settle scale is measured against.
const PLAN_CHATS = [
  { project: 0, age: 0, width: 0.82 },
  { project: 1, age: 0.4, width: 0.6 },
  { project: 0, age: 1.5, width: 0.72 },
  { project: 1, age: 2.5, width: 0.9 },
  { project: 0, age: 4.5, width: 0.56 },
  { project: 1, age: 6, width: 0.76 },
  { project: 0, age: 12, width: 0.66 },
  { project: 1, age: 40, width: 0.5 },
] as const
const PLAN_PROJECTS = [0.62, 0.74] as const
const PROJECT_ROWS = 5

type RowStyle = CSSProperties & { '--row': number; '--w': number }

function rowStyle(row: number, width: number): RowStyle {
  return { '--row': row, '--w': width }
}

function planLabel(
  mode: SidebarMode,
  days: SettleDays,
  terminal: TerminalPlacement,
  picker: ModelPickerLayout,
): string {
  const sidebar =
    mode === 'classic'
      ? 'Classic sidebar'
      : `Inbox sidebar, chats settle ${days === null ? 'never' : `after ${dayCount(days)}`}`
  const where = terminal === 'bottom' ? 'terminal at the bottom' : 'terminal on the right'
  return `Window plan: ${sidebar}, ${where}, model picker as a ${picker}.`
}

function WindowPlan(props: {
  mode: SidebarMode
  days: SettleDays
  terminal: TerminalPlacement
  picker: ModelPickerLayout
  lit: PlanPart | undefined
  onHover: (part: PlanPart) => void
  onLeave: (part: PlanPart) => void
}) {
  const inbox = props.mode === 'inbox'
  const active = PLAN_CHATS.filter((chat) => props.days === null || chat.age < props.days).length
  const settled = inbox && active < PLAN_CHATS.length
  const hover = (part: PlanPart) => ({
    onPointerEnter: () => props.onHover(part),
    onPointerLeave: () => props.onLeave(part),
  })

  return (
    <div
      className="gplan"
      role="img"
      aria-label={planLabel(props.mode, props.days, props.terminal, props.picker)}
      data-mode={props.mode}
      data-terminal={props.terminal}
      data-picker={props.picker}
      data-lit={props.lit}
    >
      <div className="gplan__rail gplan__part" {...hover('sidebar')}>
        <span className="gplan__action" style={rowStyle(0, 0.5)} />
        <span className="gplan__action" style={rowStyle(1, 0.64)} />
        {PLAN_PROJECTS.map((width, project) => (
          <span
            key={project}
            className="gplan__project"
            style={rowStyle(project * PROJECT_ROWS, width)}
          />
        ))}
        {PLAN_CHATS.map((chat, index) => {
          const settles = index >= active
          const row = inbox
            ? index + (settles ? 1 : 0)
            : chat.project * PROJECT_ROWS +
              1 +
              PLAN_CHATS.slice(0, index).filter((earlier) => earlier.project === chat.project)
                .length
          return (
            <span
              key={index}
              className="gplan__chat"
              data-settled={(inbox && settles) || undefined}
              style={rowStyle(row, chat.width)}
            />
          )
        })}
        <span
          className="gplan__fold"
          data-shown={settled || undefined}
          style={rowStyle(active, 0.4)}
        />
      </div>
      <div className="gplan__main gplan__part">
        <div className="gplan__thread">
          <span className="gplan__ask" />
          <span className="gplan__line" style={rowStyle(0, 0.96)} />
          <span className="gplan__line" style={rowStyle(1, 0.88)} />
          <span className="gplan__line" style={rowStyle(2, 0.93)} />
          <span className="gplan__line" style={rowStyle(3, 0.52)} />
        </div>
        <div className="gplan__composer" {...hover('picker')}>
          <span className="gplan__placeholder" />
          <span className="gplan__chip" />
          <span className="gplan__send" />
          <div className="gplan__picker">
            <div className="gplan__picker-strip">
              <span className="gplan__picker-mark" data-selected />
              <span className="gplan__picker-mark" />
              <span className="gplan__picker-mark" />
            </div>
            {[0.4, 0.78, 0.64, 0.7, 0.34, 0.6, 0.82, 0.5].map((width, row) => (
              <span
                key={row}
                className="gplan__picker-row"
                data-head={row === 0 || (row === 4 && props.picker === 'list') || undefined}
                style={rowStyle(row, width)}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="gplan__terminal gplan__part" {...hover('terminal')}>
        <span className="gplan__tab" data-selected />
        <span className="gplan__tab" />
        <span className="gplan__prompt" style={rowStyle(0, 0.32)} />
        <span className="gplan__output" style={rowStyle(1, 0.58)} />
        <span className="gplan__output" style={rowStyle(2, 0.44)} />
        <span className="gplan__prompt gplan__prompt--cursor" style={rowStyle(3, 0)} />
      </div>
    </div>
  )
}
