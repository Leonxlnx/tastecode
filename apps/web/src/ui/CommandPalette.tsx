import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { IconSearch as Search } from '@tabler/icons-react'
import '../styles/command-palette.css'
import { useDialogFocus } from './dialog-focus.js'

export type CommandScope = 'all' | 'projects' | 'new-thread'

export type PaletteCommand = {
  id: string
  title: string
  detail?: string
  group: 'Actions' | 'Projects' | 'Chats'
  keywords?: string
  projectCommand?: boolean
  newThreadProject?: boolean
  shortcut?: string | undefined
  run: () => void
}

export type PaletteDeferredSearch = (terms: readonly string[], limit: number) => PaletteCommand[]

export const MAX_VISIBLE_PALETTE_COMMANDS = 100

class PaletteCommandSearchIndex {
  readonly #searchable = new Map<PaletteCommand, string>()

  constructor(readonly commands: readonly PaletteCommand[]) {}

  text(command: PaletteCommand): string {
    const cached = this.#searchable.get(command)
    if (cached !== undefined) return cached
    const searchable =
      `${command.title} ${command.detail ?? ''} ${command.group} ${command.keywords ?? ''}`.toLowerCase()
    this.#searchable.set(command, searchable)
    return searchable
  }
}

function visiblePaletteCommands(
  index: PaletteCommandSearchIndex,
  scope: CommandScope,
  preferredCommandId: string | undefined,
  query: string,
  deferredSearch: PaletteDeferredSearch | undefined,
): PaletteCommand[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const inScope = (command: PaletteCommand) =>
    scope === 'projects'
      ? command.projectCommand === true
      : scope === 'new-thread'
        ? command.newThreadProject === true
        : true
  const matches = (command: PaletteCommand) =>
    inScope(command) && terms.every((term) => index.text(command).includes(term))
  const visible: PaletteCommand[] = []
  const preferred = preferredCommandId
    ? index.commands.find((command) => command.id === preferredCommandId)
    : undefined
  if (preferred && matches(preferred)) visible.push(preferred)

  for (const command of index.commands) {
    if (visible.length >= MAX_VISIBLE_PALETTE_COMMANDS) break
    if (command !== preferred && matches(command)) visible.push(command)
  }
  if (scope === 'all' && deferredSearch && visible.length < MAX_VISIBLE_PALETTE_COMMANDS) {
    visible.push(...deferredSearch(terms, MAX_VISIBLE_PALETTE_COMMANDS - visible.length))
  }
  return visible
}

function CommandPaletteComponent(props: {
  commands: PaletteCommand[]
  scope: CommandScope
  preferredCommandId?: string | undefined
  deferredSearch?: PaletteDeferredSearch | undefined
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const results = useRef<HTMLDivElement>(null)
  const dialog = useDialogFocus<HTMLDivElement>(props.onClose)

  useEffect(() => {
    input.current?.focus()
  }, [])

  const searchIndex = useMemo(() => new PaletteCommandSearchIndex(props.commands), [props.commands])
  const commands = useMemo(
    () =>
      visiblePaletteCommands(
        searchIndex,
        props.scope,
        props.preferredCommandId,
        query,
        props.deferredSearch,
      ),
    [searchIndex, props.scope, props.preferredCommandId, props.deferredSearch, query],
  )

  useEffect(() => {
    setSelected(0)
  }, [query, props.scope])

  useEffect(() => {
    const command = commands[selected]
    if (!command) return
    // Scrolling the first item into view would clip its group heading, which
    // reads as an already-scrolled list the moment the palette opens.
    if (selected === 0) {
      results.current?.scrollTo?.({ top: 0 })
      return
    }
    results.current
      ?.querySelector<HTMLElement>(`#command-${CSS.escape(command.id)}`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [commands, selected])

  const choose = (command: PaletteCommand | undefined) => {
    if (!command) return
    props.onClose()
    command.run()
  }

  return (
    <div
      className="command-palette"
      role="dialog"
      aria-modal="true"
      ref={dialog.panel}
      tabIndex={-1}
      aria-label={
        props.scope === 'projects'
          ? 'Switch project'
          : props.scope === 'new-thread'
            ? 'Choose a project for the new thread'
            : 'Command palette'
      }
      onKeyDown={dialog.onKeyDown}
    >
      <button
        className="command-palette__scrim"
        onClick={props.onClose}
        aria-label="Close command palette"
        tabIndex={-1}
      />
      <div className="command-palette__panel">
        <div className="command-palette__search">
          <Search size={15} aria-hidden />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                props.onClose()
                return
              }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                if (commands.length === 0) return
                const direction = event.key === 'ArrowDown' ? 1 : -1
                setSelected((current) => (current + direction + commands.length) % commands.length)
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                choose(commands[selected])
              }
            }}
            placeholder={
              props.scope === 'projects'
                ? 'Switch project…'
                : props.scope === 'new-thread'
                  ? 'Choose a project…'
                  : 'Search commands, projects, chats…'
            }
            spellCheck={false}
            aria-label="Search commands"
            aria-controls="command-palette-results"
            aria-activedescendant={
              commands[selected] ? `command-${commands[selected].id}` : undefined
            }
          />
        </div>

        <div
          ref={results}
          className="command-palette__results"
          id="command-palette-results"
          role="listbox"
        >
          {commands.length === 0 ? (
            <p className="command-palette__empty">No matching commands.</p>
          ) : (
            commands.map((command, index) => {
              const startsGroup = index === 0 || commands[index - 1]?.group !== command.group
              return (
                <div key={command.id}>
                  {startsGroup ? <p className="command-palette__group">{command.group}</p> : null}
                  <button
                    id={`command-${command.id}`}
                    className={`command-palette__item ${index === selected ? 'is-selected' : ''}`}
                    onClick={() => choose(command)}
                    onMouseEnter={() => setSelected(index)}
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === selected}
                  >
                    <span className="command-palette__copy">
                      <span className="command-palette__name">{command.title}</span>
                      {command.detail ? (
                        <span className="command-palette__detail">{command.detail}</span>
                      ) : null}
                    </span>
                    {command.shortcut ? (
                      <kbd className="command-palette__shortcut">{command.shortcut}</kbd>
                    ) : null}
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

export const CommandPalette = memo(CommandPaletteComponent)
