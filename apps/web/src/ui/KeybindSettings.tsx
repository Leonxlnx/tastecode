import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { IconRotate as RotateCcw, IconSearch as Search, IconX as X } from '@tabler/icons-react'
import '../styles/keybinds.css'
import {
  findKeybindingConflict,
  KEYBINDING_DEFINITIONS,
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

export function KeybindSettings(props: {
  keybindings: Keybindings
  macOS: boolean
  onChange: (action: KeybindingId, shortcut: Shortcut | null) => void
  onReset: () => void
}) {
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<KeybindingId>()
  const [message, setMessage] = useState<{ action: KeybindingId; text: string }>()
  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return KEYBINDING_DEFINITIONS
    return KEYBINDING_DEFINITIONS.filter((definition) => {
      const searchable =
        `${definition.label} ${definition.description} ${definition.group}`.toLowerCase()
      return terms.every((term) => searchable.includes(term))
    })
  }, [query])

  const record = (action: KeybindingId, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setRecording(undefined)
      setMessage(undefined)
      return
    }
    if (MODIFIER_KEYS.has(event.key)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }

    event.preventDefault()
    event.stopPropagation()
    const clear =
      (event.key === 'Backspace' || event.key === 'Delete') &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    if (clear) {
      props.onChange(action, null)
      setRecording(undefined)
      setMessage(undefined)
      return
    }

    const shortcut = shortcutFromKeyboardEvent(event.nativeEvent)
    if (!shortcut) {
      setMessage({
        action,
        text: `Add ${props.macOS ? 'Command or Option' : 'Ctrl or Alt'}, or use a function key.`,
      })
      return
    }
    const conflict = findKeybindingConflict(props.keybindings, action, shortcut)
    if (conflict) {
      setMessage({ action, text: `Already used by ${conflict.label}.` })
      return
    }

    props.onChange(action, shortcut)
    setRecording(undefined)
    setMessage(undefined)
  }

  return (
    <section className="settings__panel keybind-settings" aria-labelledby="settings-keybinds">
      <header className="keybind-settings__header">
        <div>
          <h1 className="settings__title" id="settings-keybinds">
            Keybinds
          </h1>
          <p>
            Click a keybind, then press a new combination. Backspace clears it. Changes save
            automatically.
          </p>
        </div>
        <button
          className="settings__action keybind-settings__reset"
          type="button"
          onClick={() => {
            props.onReset()
            setRecording(undefined)
            setMessage(undefined)
          }}
        >
          <RotateCcw size={13} aria-hidden />
          Reset all
        </button>
      </header>

      <label className="keybind-settings__search">
        <Search size={14} aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search keybinds…"
          aria-label="Search keybinds"
        />
      </label>

      {GROUPS.map((group) => {
        const definitions = filtered.filter((definition) => definition.group === group)
        if (definitions.length === 0) return null
        return (
          <section
            className="keybind-settings__section"
            key={group}
            aria-labelledby={`keybind-${group}`}
          >
            <h2 className="settings__group-title" id={`keybind-${group}`}>
              {group}
            </h2>
            <div className="settings__group keybind-settings__group">
              {definitions.map((definition) => {
                const shortcut = props.keybindings[definition.id]
                const active = recording === definition.id
                const rowMessage = message?.action === definition.id ? message.text : undefined
                const descriptionId = `keybind-description-${definition.id}`
                const messageId = `keybind-message-${definition.id}`
                return (
                  <div className="keybind-row" key={definition.id}>
                    <div className="settings__row-copy">
                      <p className="settings__row-title">{definition.label}</p>
                      <p className="settings__row-note" id={descriptionId}>
                        {definition.description}
                      </p>
                      {rowMessage ? (
                        <p className="keybind-row__message" id={messageId} role="alert">
                          {rowMessage}
                        </p>
                      ) : null}
                    </div>
                    <div className="keybind-row__controls">
                      {shortcut && !active ? (
                        <button
                          className="keybind-row__clear"
                          type="button"
                          aria-label={`Clear ${definition.label} keybind`}
                          onClick={() => {
                            props.onChange(definition.id, null)
                            setMessage(undefined)
                          }}
                        >
                          <X size={12} aria-hidden />
                        </button>
                      ) : null}
                      <button
                        className="keybind-recorder"
                        data-recording={active ? 'true' : undefined}
                        type="button"
                        aria-label={`Change ${definition.label} keybind`}
                        aria-pressed={active}
                        aria-describedby={`${descriptionId}${rowMessage ? ` ${messageId}` : ''}`}
                        onClick={() => {
                          setRecording(definition.id)
                          setMessage(undefined)
                        }}
                        onKeyDown={(event) => {
                          if (recording === definition.id) record(definition.id, event)
                        }}
                        onBlur={() => {
                          if (recording === definition.id) setRecording(undefined)
                        }}
                      >
                        {active ? (
                          <span>Press keys…</span>
                        ) : shortcut ? (
                          <kbd>{shortcutLabel(shortcut, props.macOS)}</kbd>
                        ) : (
                          <span>Set keybind</span>
                        )}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}

      {filtered.length === 0 ? (
        <p className="keybind-settings__empty" role="status">
          No matching keybinds.
        </p>
      ) : null}
    </section>
  )
}
