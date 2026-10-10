import {
  useEffect,
  useMemo,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { IconSearch as Search } from '@tabler/icons-react'
import '../styles/keybinds.css'
import { suspendNativeMenuShortcuts } from '../bridge.js'
import {
  DEFAULT_KEYBINDINGS,
  findKeybindingConflict,
  KEYBINDING_DEFINITIONS,
  reservedShortcutLabel,
  sameShortcut,
  shortcutFromKeyboardEvent,
  shortcutLabel,
  type KeybindingGroup,
  type KeybindingId,
  type Keybindings,
  type Shortcut,
} from '../shortcuts.js'

const GROUPS = [
  'App',
  'Chats',
  'Projects',
  'Workspace',
] as const satisfies readonly KeybindingGroup[]
const MODIFIER_KEYS = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift'])

type Modifiers = { primary: boolean; alt: boolean; shift: boolean }
const NO_MODIFIERS: Modifiers = { primary: false, alt: false, shift: false }

const MODIFIERS = [
  { name: 'primary', icon: 'command', mac: '⌘', other: 'Ctrl' },
  { name: 'alt', icon: 'option', mac: '⌥', other: 'Alt' },
  { name: 'shift', icon: 'shift', mac: '⇧', other: 'Shift' },
] as const

type Fault = {
  action: KeybindingId
  text: string
  attempt?: Shortcut
  conflict?: KeybindingId
}

function heldModifiers(event: ReactKeyboardEvent): Modifiers {
  return {
    primary: event.metaKey || event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  }
}

/**
 * A shortcut set the way a macOS menu sets it: plain type, modifiers packed
 * against the key, and the key in a column of its own so every shortcut on
 * the page lines up under the one above.
 */
function Chord(props: { shortcut: Shortcut; macOS: boolean; landed?: boolean }) {
  const label = shortcutLabel(props.shortcut, props.macOS)
  if (!props.macOS) {
    return (
      <kbd className="keybind-shortcut" title={label} data-landed={props.landed || undefined}>
        {label}
      </kbd>
    )
  }
  return (
    <kbd className="keybind-shortcut" title={label} data-landed={props.landed || undefined}>
      {MODIFIERS.map((modifier) =>
        props.shortcut[modifier.name] ? (
          <span
            className="keybind-shortcut__modifier"
            data-shortcut-icon={modifier.icon}
            key={modifier.name}
          >
            {modifier.mac}
          </span>
        ) : null,
      )}
      <span className="keybind-shortcut__key">
        {shortcutLabel({ key: props.shortcut.key }, true)}
      </span>
    </kbd>
  )
}

/**
 * The chord being typed. Every modifier waits in its place, faint, and takes
 * ink while it is held; the caret stands where the key will land.
 */
function LiveChord(props: { held: Modifiers; macOS: boolean }) {
  return (
    <span
      className={`keybind-shortcut keybind-shortcut--live${props.macOS ? '' : ' keybind-shortcut--words'}`}
      aria-hidden
    >
      {MODIFIERS.map((modifier) => (
        <span
          className="keybind-shortcut__modifier"
          data-held={props.held[modifier.name] || undefined}
          key={modifier.name}
        >
          {props.macOS ? modifier.mac : `${modifier.other}+`}
        </span>
      ))}
      <span className="keybind-shortcut__key keybind-shortcut__caret" />
    </span>
  )
}

export function KeybindSettings(props: {
  keybindings: Keybindings
  macOS: boolean
  onChange: (action: KeybindingId, shortcut: Shortcut | null) => void
  onReset: () => void
}) {
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<KeybindingId>()
  const [held, setHeld] = useState<Modifiers>(NO_MODIFIERS)
  const [fault, setFault] = useState<Fault>()
  const [landed, setLanded] = useState<KeybindingId>()
  const recordingShortcut = recording !== undefined
  useEffect(() => {
    if (!recordingShortcut) return
    // Menu accelerators fire before the page sees the key, so a recorded
    // combination would run its old action instead of reaching the recorder.
    suspendNativeMenuShortcuts(true)
    return () => suspendNativeMenuShortcuts(false)
  }, [recordingShortcut])
  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return KEYBINDING_DEFINITIONS
    return KEYBINDING_DEFINITIONS.filter((definition) => {
      const searchable =
        `${definition.label} ${definition.description} ${definition.group}`.toLowerCase()
      return terms.every((term) => searchable.includes(term))
    })
  }, [query])
  const changed = KEYBINDING_DEFINITIONS.some(
    (definition) =>
      !sameShortcut(props.keybindings[definition.id], DEFAULT_KEYBINDINGS[definition.id]),
  )

  const stop = () => {
    setRecording(undefined)
    setHeld(NO_MODIFIERS)
    setFault(undefined)
  }
  const assign = (action: KeybindingId, shortcut: Shortcut | null) => {
    props.onChange(action, shortcut)
    setLanded(shortcut ? action : undefined)
    stop()
  }
  // Moving focus to the open row's own actions keeps it recording.
  const leaveRow = (event: ReactFocusEvent<HTMLElement>) => {
    const row = event.currentTarget.closest('.keybind-row')
    if (!row?.contains(event.relatedTarget as Node | null)) stop()
  }

  const record = (action: KeybindingId, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    // A bare Tab still moves on, to the row's own actions.
    const bare = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    if (event.key === 'Tab' && bare) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      stop()
      return
    }
    setHeld(heldModifiers(event))
    if (MODIFIER_KEYS.has(event.key)) {
      // Reaching for a modifier starts the next attempt, so the refused one goes.
      if (fault?.action === action) setFault(undefined)
      return
    }

    if (bare && (event.key === 'Backspace' || event.key === 'Delete')) {
      assign(action, null)
      return
    }

    const shortcut = shortcutFromKeyboardEvent(event.nativeEvent)
    if (!shortcut) {
      setFault({
        action,
        text: `Add ${props.macOS ? 'Command or Option' : 'Ctrl or Alt'}, or use a function key.`,
      })
      return
    }
    // A binding saved there before this check still runs; pressing it again keeps it.
    const reserved = sameShortcut(props.keybindings[action], shortcut)
      ? undefined
      : reservedShortcutLabel(shortcut)
    if (reserved) {
      setFault({ action, text: `Already used by ${reserved}.`, attempt: shortcut })
      return
    }
    const conflict = findKeybindingConflict(props.keybindings, action, shortcut)
    if (conflict) {
      setFault({
        action,
        text: `Already used by ${conflict.label}.`,
        attempt: shortcut,
        conflict: conflict.id,
      })
      return
    }
    assign(action, shortcut)
  }

  // Row actions keep focus on the recorder, so pressing one does not blur
  // the row closed before its click lands.
  const keepFocus = (event: ReactMouseEvent) => event.preventDefault()

  return (
    <section className="settings__panel keybind-settings" aria-labelledby="settings-keybinds">
      <header className="keybind-settings__header">
        <h1 className="settings__title" id="settings-keybinds">
          Keybinds
        </h1>
        {changed ? (
          <button
            className="keybind-settings__restore"
            type="button"
            onClick={() => {
              props.onReset()
              setLanded(undefined)
              stop()
            }}
          >
            Restore defaults
          </button>
        ) : null}
      </header>
      <p className="keybind-settings__intro">
        Click an action, then press the keys you want for it. Changes save as you go.
      </p>

      <label className="keybind-settings__search">
        <Search className="keybind-settings__search-icon" size={15} stroke={1.75} aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search actions"
          aria-label="Search keybinds"
          spellCheck={false}
        />
        {query ? (
          <button
            className="keybind-settings__search-clear"
            type="button"
            aria-label="Clear search"
            onClick={(event) => {
              setQuery('')
              event.currentTarget.parentElement?.querySelector('input')?.focus()
            }}
          >
            Clear
          </button>
        ) : null}
      </label>

      {GROUPS.map((group) => {
        const definitions = filtered.filter((definition) => definition.group === group)
        if (definitions.length === 0) return null
        return (
          <section className="keybind-group" key={group} aria-labelledby={`keybind-${group}`}>
            <h2 className="keybind-group__heading" id={`keybind-${group}`}>
              {group}
            </h2>
            {definitions.map((definition) => {
              const shortcut = props.keybindings[definition.id]
              const fallback = DEFAULT_KEYBINDINGS[definition.id]
              const active = recording === definition.id
              const rowFault = fault?.action === definition.id ? fault : undefined
              const descriptionId = `keybind-description-${definition.id}`
              const messageId = `keybind-message-${definition.id}`
              return (
                <div
                  className="keybind-row"
                  key={definition.id}
                  data-recording={active || undefined}
                  data-fault={rowFault ? true : undefined}
                  data-bound={shortcut ? true : undefined}
                  data-landed={landed === definition.id || undefined}
                >
                  <p className="keybind-row__name">{definition.label}</p>
                  <span className="keybind-row__leader" aria-hidden />
                  <button
                    className="keybind-recorder"
                    type="button"
                    aria-label={`Change ${definition.label} keybind`}
                    aria-pressed={active}
                    aria-describedby={`${descriptionId}${rowFault ? ` ${messageId}` : ''}`}
                    onClick={() => {
                      if (active) return
                      setRecording(definition.id)
                      setHeld(NO_MODIFIERS)
                      setFault(undefined)
                      setLanded(undefined)
                    }}
                    onKeyDown={(event) => {
                      if (active) record(definition.id, event)
                    }}
                    onKeyUp={(event) => {
                      if (active) setHeld(heldModifiers(event))
                    }}
                    onBlur={(event) => {
                      if (active) leaveRow(event)
                    }}
                  >
                    {active && rowFault?.attempt ? (
                      <Chord shortcut={rowFault.attempt} macOS={props.macOS} />
                    ) : active ? (
                      <LiveChord held={held} macOS={props.macOS} />
                    ) : shortcut ? (
                      <Chord
                        shortcut={shortcut}
                        macOS={props.macOS}
                        landed={landed === definition.id}
                      />
                    ) : (
                      <span className="keybind-recorder__empty">Not set</span>
                    )}
                  </button>
                  <div className="keybind-row__detail">
                    <div className="keybind-row__detail-inner">
                      <p className="keybind-row__note" id={descriptionId}>
                        {definition.description}
                      </p>
                      {active ? (
                        <div className="keybind-row__line">
                          {rowFault ? (
                            <p className="keybind-row__message" id={messageId} role="alert">
                              {rowFault.text}
                            </p>
                          ) : (
                            <p className="keybind-row__hint">
                              Hold {props.macOS ? '⌘ or ⌥' : 'Ctrl or Alt'} and press a key. Esc
                              cancels.
                            </p>
                          )}
                          <span
                            className="keybind-row__actions"
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') {
                                event.stopPropagation()
                                event.currentTarget
                                  .closest('.keybind-row')
                                  ?.querySelector<HTMLElement>('.keybind-recorder')
                                  ?.focus()
                                stop()
                              }
                            }}
                          >
                            {rowFault?.conflict && rowFault.attempt ? (
                              <button
                                className="keybind-row__action is-primary"
                                type="button"
                                onMouseDown={keepFocus}
                                onBlur={leaveRow}
                                onClick={() => {
                                  props.onChange(rowFault.conflict!, null)
                                  assign(definition.id, rowFault.attempt!)
                                }}
                              >
                                Move it here
                              </button>
                            ) : null}
                            {fallback && !sameShortcut(shortcut, fallback) ? (
                              <button
                                className="keybind-row__action"
                                type="button"
                                onMouseDown={keepFocus}
                                onBlur={leaveRow}
                                onClick={() => {
                                  const conflict = findKeybindingConflict(
                                    props.keybindings,
                                    definition.id,
                                    fallback,
                                  )
                                  if (conflict) props.onChange(conflict.id, null)
                                  assign(definition.id, { ...fallback })
                                }}
                              >
                                Restore {shortcutLabel(fallback, props.macOS)}
                              </button>
                            ) : null}
                            {shortcut ? (
                              <button
                                className="keybind-row__action"
                                type="button"
                                aria-label={`Clear ${definition.label} keybind`}
                                onMouseDown={keepFocus}
                                onBlur={leaveRow}
                                onClick={() => assign(definition.id, null)}
                              >
                                Clear
                              </button>
                            ) : null}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              )
            })}
          </section>
        )
      })}

      {filtered.length === 0 ? (
        <p className="keybind-settings__empty" role="status">
          No action matches “{query.trim()}”.
        </p>
      ) : null}
    </section>
  )
}
