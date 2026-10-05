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

type SidebarMode = SidebarSettings['mode']
/** `null` is "never", the stop past the 90-day end of the scale. */
type SettleDays = SidebarSettings['autoSettleDays']

type Option<T extends string> = { value: T; label: string }

const SIDEBAR_OPTIONS = [
  { value: 'classic', label: 'Classic' },
  { value: 'inbox', label: 'Inbox' },
] as const satisfies ReadonlyArray<Option<SidebarMode>>

const TERMINAL_OPTIONS = [
  { value: 'bottom', label: 'Bottom' },
  { value: 'workspace', label: 'Right' },
] as const satisfies ReadonlyArray<Option<TerminalPlacement>>

const PICKER_OPTIONS = [
  { value: 'list', label: 'List' },
  { value: 'rail', label: 'Rail' },
] as const satisfies ReadonlyArray<Option<ModelPickerLayout>>

function dayCount(days: number): string {
  return days === 1 ? '1 day' : `${days} days`
}

/**
 * General is chosen by picture, the way Appearance chooses a theme: each
 * setting is a name, a line on what it decides, and its two choices drawn as
 * the window they make, the part that changes in full ink and the chosen one
 * ringed. The settle scale sits under the Inbox picture and moves its fold.
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
  // While the settle scale is dragged the Inbox picture follows the pointer;
  // the server only hears the value the pointer lets go at.
  const [draftDays, setDraftDays] = useState<SettleDays | undefined>()

  const mode = props.sidebarSettings.mode
  const days = draftDays === undefined ? props.sidebarSettings.autoSettleDays : draftDays
  const inbox = mode === 'inbox'

  return (
    <section className="settings__panel" aria-labelledby="settings-general">
      <h1 className="settings__title" id="settings-general">
        General
      </h1>
      <div className="general">
        <Setting
          name="Sidebar"
          note="Classic files chats under their projects. Inbox lines them up by last activity."
          value={mode}
          options={SIDEBAR_OPTIONS}
          onChange={(next) => props.onSidebarSettingsChange({ mode: next })}
          picture={(value) => <MiniWindow focus="sidebar" mode={value} days={days} />}
        >
          <div
            className="general-settle"
            data-open={inbox || undefined}
            inert={!inbox}
            aria-hidden={!inbox || undefined}
          >
            <div className="general-settle__inner">
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
        </Setting>
        <Setting
          name="Terminal"
          note="Where the Toggle terminal shortcut opens a terminal."
          value={terminal}
          options={TERMINAL_OPTIONS}
          onChange={writeTerminalPlacement}
          picture={(value) => (
            <MiniWindow focus="terminal" mode={mode} days={days} terminal={value} />
          )}
        />
        <Setting
          name="Model picker"
          note="Rail picks a provider first, then its models. List shows every model in one scroll."
          value={picker}
          options={PICKER_OPTIONS}
          onChange={writeModelPickerLayout}
          picture={(value) => <MiniWindow focus="picker" mode={mode} days={days} picker={value} />}
        />
      </div>
    </section>
  )
}

/**
 * One setting: its name and what it decides, then its choices as pictures.
 * The pictures are one radio group; arrow keys move the choice, as in any
 * native radio group.
 */
function Setting<T extends string>(props: {
  name: string
  note: string
  value: T
  options: ReadonlyArray<Option<T>>
  onChange: (value: T) => void
  picture: (value: T) => ReactNode
  children?: ReactNode
}) {
  const nameId = useId()
  const noteId = useId()
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
    <div className="general-setting">
      <div className="general-setting__copy">
        <p className="general-setting__name" id={nameId}>
          {props.name}
        </p>
        <p className="general-setting__note" id={noteId}>
          {props.note}
        </p>
      </div>
      <div
        className="general-setting__options"
        role="radiogroup"
        aria-labelledby={nameId}
        aria-describedby={noteId}
      >
        {props.options.map((option, index) => {
          const checked = option.value === props.value
          return (
            <button
              key={option.value}
              ref={(button) => {
                buttons.current[index] = button
              }}
              className="general-option"
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              onClick={() => choose(index)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              <span className="general-option__picture" aria-hidden>
                {props.picture(option.value)}
              </span>
              <span className="general-option__label">{option.label}</span>
            </button>
          )
        })}
      </div>
      {props.children}
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
type RowStyle = CSSProperties & { '--row': number; '--w': number }

function rowStyle(row: number, width: number): RowStyle {
  return { '--row': row, '--w': width }
}

/** Rows from one project's heading to the next in the Classic picture. */
const CLASSIC_BLOCK = 4.6
const THREAD_LINES = [0.92, 0.84, 0.88, 0.5] as const
const PICKER_ROWS = [0.4, 0.78, 0.64, 0.7, 0.34, 0.6, 0.82] as const

/**
 * The window in miniature, painted in the app's own surfaces: the sidebar,
 * a reply, the prompt bar with its send button, and, where the setting asks
 * for them, the terminal or the open model picker. The part the setting
 * changes is drawn in full ink; the rest stays quiet around it.
 */
function MiniWindow(props: {
  focus: 'sidebar' | 'terminal' | 'picker'
  mode: SidebarMode
  days: SettleDays
  terminal?: TerminalPlacement
  picker?: ModelPickerLayout
}) {
  const inbox = props.mode === 'inbox'
  const active = PLAN_CHATS.filter((chat) => props.days === null || chat.age < props.days).length
  return (
    <span
      className="gwin"
      data-focus={props.focus}
      data-terminal={props.terminal}
      data-picker={props.picker}
    >
      <span className="gwin__rail">
        {inbox ? (
          <>
            {PLAN_CHATS.slice(0, active).map((chat, index) => (
              <i
                key={index}
                className="gwin__chat"
                data-project={chat.project}
                style={rowStyle(index, chat.width)}
              />
            ))}
            {active < PLAN_CHATS.length ? (
              <>
                <i className="gwin__fold" style={rowStyle(active, 0.42)} />
                {PLAN_CHATS.slice(active).map((chat, index) => (
                  <i
                    key={index}
                    className="gwin__chat"
                    data-settled
                    style={rowStyle(active + 1 + index, chat.width)}
                  />
                ))}
              </>
            ) : null}
          </>
        ) : (
          [0, 1].map((project) => (
            <span key={project} className="gwin__project">
              <i
                className="gwin__heading"
                data-project={project}
                style={rowStyle(project * CLASSIC_BLOCK, 0.62)}
              />
              {PLAN_CHATS.filter((chat) => chat.project === project)
                .slice(0, 3)
                .map((chat, index) => (
                  <i
                    key={index}
                    className="gwin__chat"
                    style={rowStyle(project * CLASSIC_BLOCK + index + 1, chat.width)}
                  />
                ))}
            </span>
          ))
        )}
      </span>
      <span className="gwin__main">
        <span className="gwin__thread">
          <i className="gwin__ask" />
          {THREAD_LINES.map((width, row) => (
            <i key={row} className="gwin__line" style={rowStyle(row, width)} />
          ))}
        </span>
        <span className="gwin__prompt">
          <b />
        </span>
        {props.picker ? (
          <span className="gwin__picker">
            {props.picker === 'rail' ? (
              <span className="gwin__strip">
                <i data-selected />
                <i />
                <i />
              </span>
            ) : null}
            <span className="gwin__models">
              {PICKER_ROWS.map((width, row) => (
                <i
                  key={row}
                  data-head={row === 0 || (row === 4 && props.picker === 'list') || undefined}
                  style={rowStyle(row, width)}
                />
              ))}
            </span>
          </span>
        ) : null}
      </span>
      {props.terminal ? (
        <span className="gwin__terminal">
          <i className="gwin__term-line" data-prompt style={rowStyle(0, 0.36)} />
          <i className="gwin__term-line" style={rowStyle(1, 0.62)} />
          <i className="gwin__term-line" style={rowStyle(2, 0.48)} />
          <i className="gwin__term-line" data-prompt data-cursor style={rowStyle(3, 0.1)} />
        </span>
      ) : null}
    </span>
  )
}
