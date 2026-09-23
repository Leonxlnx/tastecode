import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import {
  IconAlarmOff as AlarmOff,
  IconArchive as Archive,
  IconArrowBackUp as Undo,
  IconArrowLeft as ArrowLeft,
  IconCheck as Check,
  IconChevronRight as ChevronRight,
  IconClock as Clock,
  IconClockPause as ClockPause,
  IconCopy as Copy,
  IconFilter as Filter,
  IconFilterOff as FilterOff,
  IconFolder as Folder,
  IconFolderOpen as FolderOpen,
  IconPencil as Pencil,
  IconPinned as Pin,
  IconPinnedOff as PinOff,
  IconSearch as Search,
  IconX as X,
} from '@tabler/icons-react'
import { isDesktop, isMacOS, revealPath } from '../bridge.js'
import { useDialogFocus } from './dialog-focus.js'
import { Menu } from './Menu.js'
import type { Project } from './Sidebar.js'
import { canHide, type Entry } from './inbox-entry.js'
import { ProjectMark, projectName } from './ProjectMark.js'
import { localDateTimeValue, parseCustomSnooze, snoozePresets } from './inbox-sidebar-time.js'

/**
 * Everything a row can ask the sidebar to do. One object with a stable identity,
 * so memoised rows never re-render because a parent recreated a callback.
 */
export type ThreadCommands = {
  choose: (event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }, id: string) => void
  prepareContextMenu: (id: string) => void
  register: (id: string, node: HTMLElement | null) => void
  navigate: (id: string, direction: -1 | 1) => void
  clearSelection: () => void
  rename: (id: string, title: string) => void
  settle: (ids: string[]) => void
  unsettle: (ids: string[]) => void
  snooze: (ids: string[], wakeAt: number) => void
  customSnooze: (ids: string[]) => void
  wake: (ids: string[]) => void
  togglePin: (id: string) => void
  unpin: (ids: string[]) => void
  keepActive: (id: string, keepActive: boolean) => void
  archive: (ids: string[]) => void
  scope: (path: string) => void
  copy: (text: string) => void
  dragStart: (event: DragEvent, id: string) => void
  dragEnd: () => void
}

type MenuView = 'root' | 'snooze' | 'copy'

/** Right-click and Shift+F10 menu for one thread, or for the whole selection. */
export function ThreadMenu(props: {
  entry: Entry
  entries: Entry[] | undefined
  scope: string
  target: RefObject<HTMLElement | null>
  commands: ThreadCommands
  onRename: () => void
}) {
  return (
    <Menu
      drop="down"
      label={`Thread options for ${props.entry.session.title}`}
      panelClassName="menu--sidebar menu--thread"
      contextMenuOnly
      contextMenuTargetRef={props.target}
    >
      {(close) => <ThreadMenuContent {...props} close={close} />}
    </Menu>
  )
}

function ThreadMenuContent(props: {
  entry: Entry
  entries: Entry[] | undefined
  scope: string
  commands: ThreadCommands
  onRename: () => void
  close: () => void
}) {
  const [view, setView] = useState<MenuView>('root')
  const wrap = useRef<HTMLDivElement>(null)
  const openedFrom = useRef<MenuView | undefined>(undefined)
  const entries = props.entries ?? [props.entry]
  const ids = entries.map((entry) => entry.session.id)
  const multiple = entries.length > 1
  const { commands } = props

  useLayoutEffect(() => {
    const items = wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')
    if (!items?.length || !wrap.current?.contains(document.activeElement)) return
    const returnTo = openedFrom.current
      ? wrap.current.querySelector<HTMLElement>(`[data-submenu="${openedFrom.current}"]`)
      : undefined
    ;(returnTo ?? items[0])?.focus()
    if (view === 'root') openedFrom.current = undefined
  }, [view])

  const run = (action: () => void) => {
    action()
    props.close()
  }
  const open = (next: MenuView) => {
    openedFrom.current = next
    setView(next)
  }

  const hideable: string[] = []
  const snoozed: string[] = []
  const settled: string[] = []
  const pinned: string[] = []
  for (const { session } of entries) {
    if (session.pinned) pinned.push(session.id)
    if (session.lifecycle.state === 'snoozed') snoozed.push(session.id)
    else if (session.lifecycle.state === 'settled') settled.push(session.id)
    else if (canHide(session)) hideable.push(session.id)
  }
  const count = (label: string, ids: string[]) => (multiple ? `${label} (${ids.length})` : label)

  let content: ReactNode
  if (view === 'snooze') {
    content = (
      <>
        <MenuBack label="Snooze" onBack={() => setView('root')} />
        <div className="menu__rule" />
        {snoozePresets(Date.now()).map((preset) => (
          <ThreadMenuItem
            key={preset.id}
            label={preset.label}
            trailing={preset.when}
            onSelect={() => run(() => commands.snooze(hideable, preset.at))}
          />
        ))}
        <div className="menu__rule" />
        <ThreadMenuItem
          label="Custom…"
          onSelect={() => run(() => commands.customSnooze(hideable))}
        />
      </>
    )
  } else if (view === 'copy') {
    const { project, session } = props.entry
    content = (
      <>
        <MenuBack label="Copy" onBack={() => setView('root')} />
        <div className="menu__rule" />
        <ThreadMenuItem
          label="Project path"
          onSelect={() => run(() => commands.copy(project.path))}
        />
        {session.worktreeBranch ? (
          <ThreadMenuItem
            label="Branch"
            onSelect={() => run(() => commands.copy(session.worktreeBranch ?? ''))}
          />
        ) : null}
        <ThreadMenuItem label="Thread ID" onSelect={() => run(() => commands.copy(session.id))} />
      </>
    )
  } else if (multiple) {
    content = (
      <>
        <div className="menu__group">{entries.length} selected</div>
        {pinned.length > 0 ? (
          <ThreadMenuItem
            icon={<PinOff size={14} aria-hidden />}
            label={count('Unpin', pinned)}
            onSelect={() => run(() => commands.unpin(pinned))}
          />
        ) : null}
        {hideable.length > 0 ? (
          <>
            <ThreadMenuItem
              icon={<Check size={14} aria-hidden />}
              label={count('Settle', hideable)}
              onSelect={() => run(() => commands.settle(hideable))}
            />
            <ThreadMenuItem
              icon={<Clock size={14} aria-hidden />}
              label={count('Snooze', hideable)}
              submenu="snooze"
              onSelect={() => open('snooze')}
            />
          </>
        ) : null}
        {snoozed.length > 0 ? (
          <ThreadMenuItem
            icon={<AlarmOff size={14} aria-hidden />}
            label={count('Wake', snoozed)}
            onSelect={() => run(() => commands.wake(snoozed))}
          />
        ) : null}
        {settled.length > 0 ? (
          <ThreadMenuItem
            icon={<Undo size={14} aria-hidden />}
            label={count('Un-settle', settled)}
            onSelect={() => run(() => commands.unsettle(settled))}
          />
        ) : null}
        <div className="menu__rule" />
        <ThreadMenuItem
          icon={<Archive size={14} aria-hidden />}
          label={count('Archive', ids)}
          danger
          onSelect={() => run(() => commands.archive(ids))}
        />
      </>
    )
  } else {
    const { project, session } = props.entry
    const lifecycle = session.lifecycle
    const scoped = props.scope === project.path
    content = (
      <>
        <ThreadMenuItem
          icon={session.pinned ? <PinOff size={14} aria-hidden /> : <Pin size={14} aria-hidden />}
          label={session.pinned ? 'Unpin thread' : 'Pin thread'}
          onSelect={() => run(() => commands.togglePin(session.id))}
        />
        {lifecycle.state === 'snoozed' ? (
          <ThreadMenuItem
            icon={<AlarmOff size={14} aria-hidden />}
            label="Wake thread"
            onSelect={() => run(() => commands.wake([session.id]))}
          />
        ) : lifecycle.state === 'settled' ? (
          <ThreadMenuItem
            icon={<Undo size={14} aria-hidden />}
            label="Un-settle thread"
            onSelect={() => run(() => commands.unsettle([session.id]))}
          />
        ) : hideable.length > 0 ? (
          <>
            <ThreadMenuItem
              icon={<Check size={14} aria-hidden />}
              label="Settle thread"
              onSelect={() => run(() => commands.settle([session.id]))}
            />
            <ThreadMenuItem
              icon={<Clock size={14} aria-hidden />}
              label="Snooze"
              submenu="snooze"
              onSelect={() => open('snooze')}
            />
            <ThreadMenuItem
              icon={<ClockPause size={14} aria-hidden />}
              label={lifecycle.keepActive ? 'Allow auto-settle' : 'Keep active'}
              onSelect={() => run(() => commands.keepActive(session.id, !lifecycle.keepActive))}
            />
          </>
        ) : null}
        <div className="menu__rule" />
        <ThreadMenuItem
          icon={<Pencil size={14} aria-hidden />}
          label="Rename thread"
          onSelect={() => run(props.onRename)}
        />
        <ThreadMenuItem
          icon={scoped ? <FilterOff size={14} aria-hidden /> : <Filter size={14} aria-hidden />}
          label={scoped ? 'Show all projects' : `Filter by ${projectName(project)}`}
          onSelect={() => run(() => commands.scope(scoped ? '' : project.path))}
        />
        <div className="menu__rule" />
        <ThreadMenuItem
          icon={<Copy size={14} aria-hidden />}
          label="Copy"
          submenu="copy"
          onSelect={() => open('copy')}
        />
        {isDesktop ? (
          <ThreadMenuItem
            icon={<FolderOpen size={14} aria-hidden />}
            label={isMacOS() ? 'Reveal in Finder' : 'Open in Explorer'}
            onSelect={() => run(() => void revealPath(project.path))}
          />
        ) : null}
        <div className="menu__rule" />
        <ThreadMenuItem
          icon={<Archive size={14} aria-hidden />}
          label="Archive thread"
          danger
          onSelect={() => run(() => commands.archive([session.id]))}
        />
      </>
    )
  }

  return (
    <div
      ref={wrap}
      className="thread-menu"
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (view === 'root') return
        if (event.key === 'ArrowLeft' || event.key === 'Backspace') {
          event.preventDefault()
          setView('root')
        }
      }}
    >
      {content}
    </div>
  )
}

function ThreadMenuItem(props: {
  label: string
  icon?: ReactNode
  trailing?: string
  submenu?: MenuView
  danger?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={`menu__item${props.danger ? ' menu__item--danger' : ''}`}
      aria-haspopup={props.submenu ? 'menu' : undefined}
      data-submenu={props.submenu}
      onClick={props.onSelect}
      onKeyDown={(event) => {
        if (props.submenu && event.key === 'ArrowRight') {
          event.preventDefault()
          props.onSelect()
        }
      }}
    >
      <span className="menu__name">
        <span className="menu__label">
          {props.icon}
          <span>{props.label}</span>
        </span>
        {props.trailing || props.submenu ? (
          <span className="menu__meta">
            {props.trailing ? <span className="menu__trailing">{props.trailing}</span> : null}
            {props.submenu ? <ChevronRight size={13} aria-hidden /> : null}
          </span>
        ) : null}
      </span>
    </button>
  )
}

function MenuBack(props: { label: string; onBack: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className="menu__item"
      onClick={props.onBack}
    >
      <span className="menu__name">
        <span className="menu__label">
          <ArrowLeft size={14} aria-hidden />
          <span>{props.label}</span>
        </span>
      </span>
    </button>
  )
}

/** Clock button in a card's hover actions. Presets resolve when it opens. */
export function SnoozeButton(props: {
  label: string
  onSnooze: (wakeAt: number) => void
  onCustom: () => void
}) {
  return (
    <Menu
      drop="down"
      align="right"
      label={props.label}
      triggerClassName="thread-card__snooze"
      panelClassName="menu--sidebar menu--thread"
      trigger={() => <Clock size={13} aria-hidden />}
    >
      {(close) => (
        <div className="thread-menu">
          {snoozePresets(Date.now()).map((preset) => (
            <ThreadMenuItem
              key={preset.id}
              label={preset.label}
              trailing={preset.when}
              onSelect={() => {
                close()
                props.onSnooze(preset.at)
              }}
            />
          ))}
          <div className="menu__rule" />
          <ThreadMenuItem
            label="Custom…"
            onSelect={() => {
              close()
              props.onCustom()
            }}
          />
        </div>
      )}
    </Menu>
  )
}

/** Header filter: the chosen project's mark, or a folder when every project shows. */
export function ProjectScopeMenu(props: {
  projects: Project[]
  scope: string
  onScopeChange: (path: string) => void
}) {
  const scoped = props.scope
    ? props.projects.find((project) => project.path === props.scope)
    : undefined
  const label = scoped
    ? `Filter threads by project: ${projectName(scoped)}`
    : 'Filter threads by project'
  return (
    <Menu
      drop="down"
      align="right"
      label={label}
      panelRole="dialog"
      panelLabel="Filter threads by project"
      panelClassName="menu--project-scope"
      triggerClassName={`thread-rail__icon${scoped ? ' is-scoped' : ''}`}
      trigger={() => (
        <span className="thread-rail__icon-glyph" title={label}>
          {scoped ? <ProjectMark project={scoped} /> : <Folder size={16} aria-hidden />}
        </span>
      )}
    >
      {(close) => (
        <ProjectScopeList
          projects={props.projects}
          scope={props.scope}
          onChoose={(path) => {
            props.onScopeChange(path)
            close()
          }}
        />
      )}
    </Menu>
  )
}

function ProjectScopeList(props: {
  projects: Project[]
  scope: string
  onChoose: (path: string) => void
}) {
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const normalized = query.trim().toLocaleLowerCase()
  const options = useMemo(() => {
    const matches = props.projects.filter(
      (project) =>
        !normalized ||
        projectName(project).toLocaleLowerCase().includes(normalized) ||
        project.path.toLocaleLowerCase().includes(normalized),
    )
    return [
      ...(normalized ? [] : [{ path: '', project: undefined }]),
      ...matches.map((project) => ({ path: project.path, project })),
    ]
  }, [normalized, props.projects])
  const active = Math.min(highlight, Math.max(0, options.length - 1))

  useLayoutEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  return (
    <div className="project-scope">
      <label className="project-scope__search">
        <Search size={14} aria-hidden />
        <input
          value={query}
          placeholder="Search projects…"
          aria-label="Search projects"
          role="combobox"
          aria-expanded
          aria-controls="project-scope-options"
          aria-activedescendant={options[active] ? `project-scope-${active}` : undefined}
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.currentTarget.value)
            setHighlight(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              if (options.length === 0) return
              const step = event.key === 'ArrowDown' ? 1 : -1
              setHighlight((active + step + options.length) % options.length)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              const option = options[active]
              if (option) props.onChoose(option.path)
            }
          }}
        />
      </label>
      <div ref={list} className="project-scope__list" id="project-scope-options" role="listbox">
        {options.length === 0 ? (
          <p className="project-scope__empty">No matching projects.</p>
        ) : (
          options.map((option, index) => (
            <button
              key={option.path || 'all'}
              id={`project-scope-${index}`}
              data-index={index}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={option.path === props.scope}
              className={`project-scope__option${index === active ? ' is-highlighted' : ''}`}
              onMouseMove={() => setHighlight(index)}
              onClick={() => props.onChoose(option.path)}
            >
              {option.project ? (
                <ProjectMark project={option.project} />
              ) : (
                <Folder size={16} aria-hidden />
              )}
              <span className="project-scope__name">
                {option.project ? projectName(option.project) : 'All projects'}
              </span>
              {option.path === props.scope ? <Check size={14} aria-hidden /> : null}
            </button>
          ))
        )}
      </div>
    </div>
  )
}

/** A date and time of the user's choosing, for when no preset fits. */
export function CustomSnoozeDialog(props: {
  count: number
  onSnooze: (wakeAt: number) => void
  onClose: () => void
}) {
  const dialog = useDialogFocus<HTMLFormElement>(props.onClose)
  const [value, setValue] = useState(() => {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(9, 0, 0, 0)
    return localDateTimeValue(tomorrow.getTime())
  })
  const wakeAt = parseCustomSnooze(value, Date.now())
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (wakeAt !== undefined) props.onSnooze(wakeAt)
  }

  return createPortal(
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Custom snooze"
      onKeyDown={dialog.onKeyDown}
    >
      <button className="sheet__scrim" onClick={props.onClose} aria-label="Cancel" />
      <form
        className="sheet__panel snooze-dialog"
        ref={dialog.panel}
        tabIndex={-1}
        onSubmit={submit}
      >
        <header className="sheet__head">
          <h2 className="sheet__title">Custom snooze</h2>
          <button
            type="button"
            className="icon-btn icon-btn--always"
            onClick={props.onClose}
            title="Close"
          >
            <X size={13} aria-hidden />
          </button>
        </header>
        <section className="sheet__section snooze-dialog__body">
          <input
            className="snooze-dialog__input"
            type="datetime-local"
            aria-label="Wake at"
            value={value}
            min={localDateTimeValue(Date.now())}
            onChange={(event) => setValue(event.currentTarget.value)}
            autoFocus
          />
          {wakeAt === undefined ? (
            <p className="snooze-dialog__error" role="alert">
              Pick a time in the future.
            </p>
          ) : null}
          <div className="sidebar-confirm__actions">
            <button className="ghost" type="button" onClick={props.onClose}>
              Cancel
            </button>
            <button className="btn" type="submit" disabled={wakeAt === undefined}>
              {props.count > 1 ? `Snooze ${props.count} threads` : 'Snooze'}
            </button>
          </div>
        </section>
      </form>
    </div>,
    document.body,
  )
}
