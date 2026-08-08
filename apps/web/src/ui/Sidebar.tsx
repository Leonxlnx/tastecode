import {
  memo,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  Account,
  ProviderId,
  ResultOf,
  ThreadInboxStatus,
  ThreadLifecycle,
} from '@harness/contracts'
import {
  Archive,
  Ellipsis,
  Folder,
  FolderOpen,
  FolderPen,
  Gauge,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  X,
} from 'lucide-react'
import { isDesktop, isMacOS, revealPath } from '../bridge.js'
import { SHORTCUTS, shortcutAria, shortcutLabel } from '../shortcuts.js'
import { Menu, MenuItem } from './Menu.js'
import { ShortcutHint } from './ShortcutHint.js'
import { InboxSidebar, type InboxActions } from './InboxSidebar.js'

/**
 * The rail. Collapsible, searchable, and everything in it can be renamed.
 *
 * Nothing wraps: titles are arbitrary user text and a list whose rows change
 * height as titles grow is visually unstable.
 */

export type Session = {
  id: string
  title: string
  provider: ProviderId
  agent?: string | undefined
  createdAt: number
  /** Client-observed start of the current status, used for elapsed/relative labels. */
  statusSince?: number | undefined
  status: ThreadInboxStatus
  lifecycle: ThreadLifecycle
  unread: boolean
  pinned?: boolean
  worktreeBranch?: string | undefined
}

export type Project = {
  path: string
  /** User-chosen name. Falls back to the folder name. */
  name?: string
  sessions: Session[]
  pinned?: boolean
}

type DropPosition = 'before' | 'after'

const BRAILLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
/** Narrowest width at which the New chat row and the chat rows stay
 *  roomy — the narrowest rail still looks deliberate, never squeezed. */
const MIN_RAIL_WIDTH = 240
/** Pulling the rail down to half its narrowest width reads as intent to
 *  collapse. A ratio rather than a pixel overshoot, so it keeps meaning the
 *  same thing when MIN_RAIL_WIDTH moves. */
const COLLAPSE_WIDTH = Math.round(MIN_RAIL_WIDTH * 0.5)
/** Mirrors --dur-rail: how long a fold or unfold takes to play out. */
const RAIL_FOLD_MS = 380
/** How far past the rail's own edge still counts as "at the rail" while it is
 *  revealed. Generous on purpose: the pointer travels diagonally toward the
 *  title bar toggle, and clipping that path retracted the rail mid-aim. */
const REVEAL_KEEP_BUFFER = 96
/** Grace before a revealed rail hides. Short, because position alone decides
 *  whether to arm it at all: it never fires while the pointer is still at the
 *  rail, so it no longer has to cover the walk to the toggle. */
const REVEAL_GRACE_MS = 120
/** Mirrors --dur-reveal: how long the retract itself takes. */
const REVEAL_OUT_MS = 160
const MAX_RAIL_WIDTH = 420
const COLLAPSED_PROJECT_SESSION_COUNT = 5

function SidebarComponent(props: {
  projects: Project[]
  activeProjectPath: string | undefined
  activeSessionId: string | undefined
  account: Account | undefined
  providerName: string
  usageSummary?: ResultOf<'usage.summary'> | undefined
  mode?: 'classic' | 'inbox'
  inbox?: InboxActions | undefined
  collapsed: boolean
  width: number
  onClose: () => void
  onWidthChange: (width: number) => void
  onAddProject: () => void
  onNewSession: (projectPath?: string, chooseProject?: boolean) => void
  onSelectSession: (id: string) => void
  onRenameProject: (path: string, name: string) => void
  onRemoveProject: (path: string) => void
  onTogglePin: (path: string) => void
  onRenameSession: (id: string, title: string) => void
  onToggleSessionPin?: (id: string) => void
  onDeleteSession: (id: string) => void
  onArchiveProject: (sessionIds: string[]) => void
  onReorderSession: (
    projectPath: string,
    sourceId: string,
    targetId: string,
    position: DropPosition,
  ) => void
  onOpenSearch: (projectPath?: string) => void
  onOpenSettings: () => void
}) {
  const [edgeRevealed, setEdgeRevealed] = useState(false)
  const slotRef = useRef<HTMLDivElement>(null)
  /** Set by the resize handle when its release is what collapsed the rail. */
  const foldedByDrag = useRef(false)
  /** True while the edge is being dragged: widening a revealed rail carries the
   *  pointer well clear of it, which must not read as leaving. */
  const resizing = useRef(false)
  /** Previous reveal state, so the hide direction can be told from the show. */
  const wasRevealed = useRef(false)

  /* Collapsing hands the rail to the absolute flyout, whose translate would
     animate in from no transform at all — the rail appearing at full width
     before sliding away. After a drag fold it is already gone, so that reads
     as it flashing open and shut. This runs on React's commit, before the
     browser paints, which is the only point where suppressing it is reliable;
     the handle cannot do it, since collapsing unmounts the handle. */
  useLayoutEffect(() => {
    const slot = slotRef.current
    if (!props.collapsed || !foldedByDrag.current || !slot) {
      foldedByDrag.current = false
      return
    }
    foldedByDrag.current = false
    const shell = slot.closest<HTMLElement>('.shell')
    slot.classList.add('is-settling')
    // Commit the collapsed layout while it still cannot animate.
    void slot.offsetWidth
    const frame = requestAnimationFrame(() => {
      slot.classList.remove('is-settling')
      shell?.classList.remove('is-resizing')
    })
    return () => cancelAnimationFrame(frame)
  }, [props.collapsed])
  /* A reveal that retracts is its own motion, quicker than a deliberate
     collapse. Removing the revealed class alone cannot express that: the
     resulting state is plain "collapsed", identical to a real collapse. A
     marker set on the same commit distinguishes them, and it has to be a
     layout effect — after paint would be too late, the slow transition would
     already be running. */
  useLayoutEffect(() => {
    const slot = slotRef.current
    const retracting = wasRevealed.current && !edgeRevealed && props.collapsed
    wasRevealed.current = edgeRevealed
    if (!retracting || !slot) return
    slot.classList.add('is-reveal-out')
    const done = window.setTimeout(() => slot.classList.remove('is-reveal-out'), REVEAL_OUT_MS)
    return () => clearTimeout(done)
  }, [edgeRevealed, props.collapsed])

  /* Hiding the reveal only after a grace period lets the pointer travel up to
     the title bar toggle without the flyout flickering away underneath it. */
  const revealHide = useRef<number | undefined>(undefined)
  const cancelRevealHide = () => {
    if (revealHide.current !== undefined) {
      clearTimeout(revealHide.current)
      revealHide.current = undefined
    }
  }
  const scheduleRevealHide = () => {
    // Never restarted. This is called from every mouse move outside the rail,
    // and re-arming each time meant the grace only elapsed once the pointer
    // came to a complete stop — so a rail left behind while the mouse kept
    // moving stayed open for as long as the movement lasted.
    if (revealHide.current !== undefined) return
    revealHide.current = window.setTimeout(() => setEdgeRevealed(false), REVEAL_GRACE_MS)
  }
  useEffect(() => cancelRevealHide, [])

  /* What keeps a revealed rail in place. The slot's own mouse events cannot
     see the title bar above it, and that is exactly where someone aims to pin
     the rail open — so the whole column counts as inside, plus a buffer past
     its edge. Retracting while the user is still travelling toward the toggle
     is what made the reveal feel like it snapped back on its own. */
  useEffect(() => {
    if (!edgeRevealed || !props.collapsed) return
    const onMove = (event: MouseEvent) => {
      if (resizing.current || event.clientX <= props.width + REVEAL_KEEP_BUFFER) cancelRevealHide()
      else scheduleRevealHide()
    }
    // Pointer position decides, and only this listener decides: the slot's own
    // mouseleave used to schedule the hide unconditionally, so travelling up
    // into the title bar armed it — and if the pointer then came to rest, no
    // further move arrived to disarm it and the rail folded away under the
    // toggle the user was about to press.
    window.addEventListener('mousemove', onMove)
    // Leaving the window entirely produces no more moves, so it is its own signal.
    document.addEventListener('mouseleave', scheduleRevealHide)
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', scheduleRevealHide)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the two schedulers are stable module-shape helpers
  }, [edgeRevealed, props.collapsed, props.width])
  const [scope, setScope] = useState('')
  const macOS = isMacOS()
  const inbox = props.mode === 'inbox' && props.inbox !== undefined
  const limits = props.usageSummary?.limits ?? []

  const closeOnNarrowViewport = () => {
    if (globalThis.matchMedia?.('(max-width: 700px)').matches) props.onClose()
  }

  const selectSession = (id: string) => {
    props.onSelectSession(id)
    closeOnNarrowViewport()
  }

  const newSession = (projectPath?: string, chooseProject?: boolean) => {
    props.onNewSession(projectPath, chooseProject)
    closeOnNarrowViewport()
  }

  useEffect(() => {
    if (props.collapsed) return
    // Opening from the temporary reveal must dock in place: the flyout and
    // the grid rail occupy the same pixels, so the column animation is
    // suppressed for a frame — otherwise the rail visibly closed and
    // re-opened on the toggle click.
    const slot = slotRef.current
    if (edgeRevealed && slot) {
      const shell = slot.closest<HTMLElement>('.shell')
      shell?.classList.add('is-resizing')
      requestAnimationFrame(() =>
        requestAnimationFrame(() => shell?.classList.remove('is-resizing')),
      )
    }
    setEdgeRevealed(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reveal state is read, not a trigger
  }, [props.collapsed])

  useEffect(() => {
    if (scope && !props.projects.some((project) => project.path === scope)) setScope('')
  }, [props.projects, scope])

  // Memoised because the sidebar re-renders with every streamed frame: these
  // three passes over every project and session ran 60 times a second while
  // an answer arrived, for a list that had not changed.
  const pinnedSessions = useMemo(
    () =>
      props.projects.flatMap((project) =>
        project.sessions
          .filter((session) => session.pinned)
          .map((session) => ({ projectPath: project.path, session })),
      ),
    [props.projects],
  )
  const orderedProjects = useMemo(
    () =>
      [
        ...props.projects.filter((project) => project.pinned),
        ...props.projects.filter((project) => !project.pinned),
      ].map((project) => ({
        ...project,
        sessions: project.sessions.filter((session) => !session.pinned),
      })),
    [props.projects],
  )

  return (
    <div
      ref={slotRef}
      className={`rail-slot ${props.collapsed ? 'is-collapsed' : ''} ${
        edgeRevealed ? 'is-revealed' : ''
      }`}
      onMouseEnter={cancelRevealHide}
    >
      {props.collapsed ? (
        <div
          className="rail__edge"
          aria-hidden
          onMouseEnter={() => {
            cancelRevealHide()
            setEdgeRevealed(true)
          }}
        />
      ) : null}

      {!props.collapsed ? (
        <button
          type="button"
          className="rail__backdrop"
          aria-label="Close sidebar"
          tabIndex={-1}
          onPointerDown={props.onClose}
        />
      ) : null}

      <nav className="rail" inert={props.collapsed && !edgeRevealed ? true : undefined}>
        {inbox ? (
          <InboxSidebar
            projects={props.projects}
            scope={scope}
            activeProjectPath={props.activeProjectPath}
            activeSessionId={props.activeSessionId}
            actions={props.inbox!}
            onScopeChange={setScope}
            onAddProject={() => {
              props.onAddProject()
              closeOnNarrowViewport()
            }}
            onNewSession={newSession}
            onSelectSession={selectSession}
            onRenameSession={props.onRenameSession}
            onToggleSessionPin={(id) => props.onToggleSessionPin?.(id)}
            onArchiveSession={props.onDeleteSession}
            onArchiveSessions={props.onArchiveProject}
          />
        ) : (
          <>
            <div className="rail__actions">
              <div className="rail__row">
                <button
                  className="navitem"
                  aria-keyshortcuts={shortcutAria(SHORTCUTS.newChat)}
                  onClick={() => {
                    const project =
                      props.projects.find(
                        (candidate) => candidate.path === props.activeProjectPath,
                      ) ?? props.projects[0]
                    if (project) newSession(project.path)
                    else {
                      props.onAddProject()
                      closeOnNarrowViewport()
                    }
                  }}
                >
                  <Plus size={15} aria-hidden />
                  <span>New chat</span>
                  <ShortcutHint>{shortcutLabel(SHORTCUTS.newChat, macOS)}</ShortcutHint>
                </button>
                <button
                  type="button"
                  className="rail__search"
                  onClick={() => props.onOpenSearch()}
                  aria-label="Search chats"
                  title={`Search chats (${shortcutLabel(SHORTCUTS.searchSessions, macOS)})`}
                  aria-keyshortcuts={shortcutAria(SHORTCUTS.searchSessions)}
                >
                  <Search size={14} aria-hidden />
                </button>
              </div>
              <button
                className="navitem rail__new-project"
                onClick={() => {
                  props.onAddProject()
                  closeOnNarrowViewport()
                }}
                aria-keyshortcuts={shortcutAria(SHORTCUTS.newProject)}
              >
                <FolderPen size={15} aria-hidden />
                <span>New project</span>
                <ShortcutHint>{shortcutLabel(SHORTCUTS.newProject, macOS)}</ShortcutHint>
              </button>
            </div>

            <div className="rail__body">
              {pinnedSessions.length > 0 ? (
                <>
                  <p className="section">Pinned</p>
                  <ul className="proj__sessions pinned-sessions">
                    {pinnedSessions.map(({ projectPath, session }) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        active={session.id === props.activeSessionId}
                        standalone
                        onSelect={() => selectSession(session.id)}
                        onRename={(title) => props.onRenameSession(session.id, title)}
                        onDelete={() => props.onDeleteSession(session.id)}
                        onTogglePin={() => props.onToggleSessionPin?.(session.id)}
                        onOpenInExplorer={() => void revealPath(projectPath)}
                        reorderable={false}
                        dragging={false}
                        dropPosition={undefined}
                        onDragStart={() => undefined}
                        onDragOver={() => undefined}
                        onDrop={() => undefined}
                        onDragEnd={() => undefined}
                      />
                    ))}
                  </ul>
                </>
              ) : null}
              <p className="section">Projects</p>
              {orderedProjects.length === 0 ? (
                <p className="rail__hint">Nothing here yet.</p>
              ) : (
                orderedProjects.map((project) => (
                  <ProjectRow
                    {...props}
                    key={project.path}
                    project={project}
                    forceOpen={false}
                    onNewSession={(path) => newSession(path)}
                    onSelectSession={selectSession}
                  />
                ))
              )}
            </div>
          </>
        )}

        <div className="rail__foot">
          <Menu
            drop="up"
            label="Account"
            panelClassName="menu--settings"
            trigger={() => (
              <span className="account">
                <span className="account__avatar">
                  {initial(props.account, props.providerName)}
                </span>
                <span className="account__name">{props.providerName}</span>
              </span>
            )}
          >
            {(close) => (
              <>
                <div className="account-menu__usage">
                  <div className="account-menu__usage-head">
                    <Gauge size={14} aria-hidden />
                    <span>Limits</span>
                  </div>
                  {limits.length > 0 ? (
                    limits.map((limit) => (
                      <div className="account-menu__limit" key={limit.label}>
                        <div className="account-menu__limit-row">
                          <span className="account-menu__limit-label">{limit.label}</span>
                          <span>{Math.round(100 - limit.usedPercent)}% left</span>
                        </div>
                        <div
                          className="account-menu__limit-bar"
                          role="progressbar"
                          aria-label={`${limit.label} left`}
                          aria-valuenow={Math.round(100 - limit.usedPercent)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <span
                            style={{
                              width: `${Math.min(100, Math.max(0, 100 - limit.usedPercent))}%`,
                            }}
                          />
                        </div>
                        {limit.resetsAt ? (
                          <span className="account-menu__limit-reset">
                            Resets {resetLabel(limit.resetsAt)}
                          </span>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    // Honest, not vague: of the wired CLIs only Codex
                    // answers with subscription windows today.
                    <span className="account-menu__usage-note">
                      {props.providerName} reports no limits
                    </span>
                  )}
                </div>
                <MenuItem
                  title="Settings"
                  shortcut={shortcutLabel(SHORTCUTS.settings, macOS)}
                  shortcutAria={shortcutAria(SHORTCUTS.settings)}
                  onClick={() => {
                    props.onOpenSettings()
                    closeOnNarrowViewport()
                    close()
                  }}
                />
              </>
            )}
          </Menu>
        </div>
      </nav>
      {!props.collapsed || edgeRevealed ? (
        <RailResizeHandle
          width={props.width}
          /* A revealed rail is already collapsed, so there is nothing to fold:
             the drag only resizes it, and the new width is what the next
             reveal and the next expand come back at. */
          foldable={!props.collapsed}
          onWidthChange={props.onWidthChange}
          onResizingChange={(active) => {
            resizing.current = active
            if (active) cancelRevealHide()
          }}
          onCollapse={() => {
            foldedByDrag.current = true
            props.onClose()
          }}
        />
      ) : null}
    </div>
  )
}

function RailResizeHandle(props: {
  width: number
  /** False on a revealed rail: it is already collapsed, so the drag only sizes it. */
  foldable: boolean
  onWidthChange: (width: number) => void
  onResizingChange: (active: boolean) => void
  onCollapse: () => void
}) {
  const drag = useRef<
    { startX: number; width: number; current: number; folded: boolean } | undefined
  >(undefined)

  /** Set while a fold or unfold is playing out, so tracking does not cut the
   *  animation off mid-flight on the next mouse move. */
  const settling = useRef<number | undefined>(undefined)
  useEffect(
    () => () => {
      if (settling.current !== undefined) clearTimeout(settling.current)
    },
    [],
  )

  const preview = (target: HTMLElement, width: number) => {
    target.closest<HTMLElement>('.shell')?.style.setProperty('--rail-w', `${width}px`)
  }

  /* The grid-column transition is for collapse and expand; while a pointer is
     dragging it made the rail rubber-band behind the cursor. */
  const setResizing = (target: HTMLElement, active: boolean) => {
    const shell = target.closest<HTMLElement>('.shell')
    if (!shell) return
    if (active) {
      shell.classList.add('is-resizing')
      return
    }
    shell.classList.remove('is-resizing')
    // Re-enabling the transition and changing the width inside one event can
    // collapse into a single style recalculation that starts no animation —
    // which is why unfolding mid-drag used to jump. Reading a layout value
    // commits the transition-less state first, so the change animates.
    void shell.offsetWidth
  }

  const holdTransition = () => {
    if (settling.current !== undefined) clearTimeout(settling.current)
    settling.current = window.setTimeout(() => {
      settling.current = undefined
    }, RAIL_FOLD_MS)
  }

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    if (event.key === 'ArrowLeft' && props.width <= MIN_RAIL_WIDTH) {
      props.onCollapse()
      return
    }
    props.onWidthChange(clampRailWidth(props.width + (event.key === 'ArrowLeft' ? -8 : 8)))
  }

  return (
    <button
      type="button"
      className="rail__resize"
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemin={MIN_RAIL_WIDTH}
      aria-valuemax={MAX_RAIL_WIDTH}
      aria-valuenow={props.width}
      onKeyDown={resizeWithKeyboard}
      onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
        event.currentTarget.setPointerCapture?.(event.pointerId)
        setResizing(event.currentTarget, true)
        props.onResizingChange(true)
        drag.current = {
          startX: event.clientX,
          width: props.width,
          current: props.width,
          folded: false,
        }
      }}
      onPointerMove={(event: PointerEvent<HTMLButtonElement>) => {
        if (!drag.current) return
        const raw = drag.current.width + event.clientX - drag.current.startX
        // Well past the stop the rail folds shut as a preview — the drag stays
        // alive, so pulling back right unfolds it again. Only releasing while
        // folded makes the collapse real. Both the fold and the unfold run
        // with the transition on; ordinary tracking keeps it off.
        const folded = props.foldable && raw <= COLLAPSE_WIDTH
        if (folded !== drag.current.folded) {
          drag.current.folded = folded
          if (!folded) drag.current.current = clampRailWidth(raw)
          setResizing(event.currentTarget, false)
          holdTransition()
          preview(event.currentTarget, folded ? 0 : drag.current.current)
          return
        }
        if (folded) return
        // Straight after a fold or unfold the transition stays on, so the rail
        // eases into the cursor rather than snapping out of a half-played
        // animation. Once it has settled, tracking is 1:1 again.
        if (settling.current === undefined) setResizing(event.currentTarget, true)
        const next = clampRailWidth(raw)
        drag.current.current = next
        preview(event.currentTarget, next)
      }}
      onPointerUp={(event: PointerEvent<HTMLButtonElement>) => {
        if (!drag.current) return
        const target = event.currentTarget
        // Captured now: collapsing unmounts this handle, and a detached button
        // can no longer find the shell — which is how the suppression class
        // used to get stuck on it and kill every later animation.
        const shell = target.closest<HTMLElement>('.shell')
        const { current: width, folded } = drag.current
        drag.current = undefined
        target.releasePointerCapture?.(event.pointerId)
        props.onResizingChange(false)
        if (folded) {
          // Restore the stored width behind the fold so the reveal and the
          // next expand come back at it, with animation suppressed so the
          // column does not slide open on the way into the collapsed layout.
          // The Sidebar clears both classes on its commit — this handle is
          // unmounted by then and could not do it itself.
          if (shell) shell.classList.add('is-resizing')
          preview(target, props.width)
          props.onCollapse()
          return
        }
        setResizing(target, false)
        props.onWidthChange(width)
      }}
    />
  )
}

function clampRailWidth(width: number): number {
  return Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, Math.round(width)))
}

function ProjectRow(props: {
  project: Project
  activeSessionId: string | undefined
  forceOpen: boolean
  onNewSession: (path: string) => void
  onSelectSession: (id: string) => void
  onRenameProject: (path: string, name: string) => void
  onRemoveProject: (path: string) => void
  onTogglePin: (path: string) => void
  onRenameSession: (id: string, title: string) => void
  onToggleSessionPin?: (id: string) => void
  onDeleteSession: (id: string) => void
  onArchiveProject: (sessionIds: string[]) => void
  onReorderSession: (
    projectPath: string,
    sourceId: string,
    targetId: string,
    position: DropPosition,
  ) => void
}) {
  const [open, setOpen] = useState(true)
  const [showAllSessions, setShowAllSessions] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState<'archive' | 'remove'>()
  const [draggedSessionId, setDraggedSessionId] = useState<string>()
  const [dropTarget, setDropTarget] = useState<{
    id: string
    position: DropPosition
  }>()
  const contextMenuTarget = useRef<HTMLButtonElement>(null)
  const expanded = open || props.forceOpen
  const count = props.project.sessions.length
  const hasMoreSessions = count > COLLAPSED_PROJECT_SESSION_COUNT
  const visibleSessions = showAllSessions
    ? props.project.sessions
    : props.project.sessions.slice(0, COLLAPSED_PROJECT_SESSION_COUNT)
  const reorderable = !props.forceOpen

  const endDrag = () => {
    setDraggedSessionId(undefined)
    setDropTarget(undefined)
  }

  const dragOverSession = (event: DragEvent<HTMLLIElement>, targetId: string) => {
    if (!draggedSessionId || draggedSessionId === targetId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const bounds = event.currentTarget.getBoundingClientRect()
    const position = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
    setDropTarget({ id: targetId, position })
  }

  return (
    <section className="proj">
      <div className="proj__head">
        {renaming ? (
          <InlineRename
            value={displayName(props.project)}
            onCommit={(name) => {
              props.onRenameProject(props.project.path, name)
              setRenaming(false)
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <>
            <button
              ref={contextMenuTarget}
              className="proj__toggle"
              onClick={() => {
                if (expanded) setShowAllSessions(false)
                setOpen(!expanded)
              }}
              title={props.project.path}
            >
              <Folder className="proj__mark" size={12} aria-hidden />
              <span className="proj__name">{displayName(props.project)}</span>
            </button>

            <Menu
              drop="down"
              align="right"
              label="Project options"
              panelClassName="menu--sidebar"
              contextMenuTargetRef={contextMenuTarget}
              trigger={() => (
                <span className="dots">
                  <Ellipsis size={16} aria-hidden />
                </span>
              )}
            >
              {(close) => (
                <>
                  <MenuItem
                    title={props.project.pinned ? 'Unpin' : 'Pin to top'}
                    icon={
                      props.project.pinned ? (
                        <PinOff size={14} aria-hidden />
                      ) : (
                        <Pin size={14} aria-hidden />
                      )
                    }
                    onClick={() => {
                      props.onTogglePin(props.project.path)
                      close()
                    }}
                  />
                  {isDesktop ? (
                    <MenuItem
                      title="Open in Explorer"
                      icon={<FolderOpen size={14} aria-hidden />}
                      onClick={() => {
                        void revealPath(props.project.path)
                        close()
                      }}
                    />
                  ) : null}
                  <MenuItem
                    title="Edit name"
                    icon={<Pencil size={14} aria-hidden />}
                    onClick={() => {
                      setRenaming(true)
                      close()
                    }}
                  />
                  <MenuItem
                    title="Archive chats"
                    icon={<Archive size={14} aria-hidden />}
                    onClick={() => {
                      setConfirming('archive')
                      close()
                    }}
                  />
                  <MenuItem
                    title="Remove from sidebar"
                    icon={<PanelLeftClose size={14} aria-hidden />}
                    className="menu__item--danger"
                    onClick={() => {
                      setConfirming('remove')
                      close()
                    }}
                  />
                </>
              )}
            </Menu>

            <button
              className="icon-btn"
              onClick={() => props.onNewSession(props.project.path)}
              title="New chat here"
            >
              <Plus size={13} aria-hidden />
            </button>
          </>
        )}
      </div>

      {confirming ? (
        <SidebarConfirmDialog
          title={confirming === 'archive' ? 'Archive all chats?' : 'Remove project?'}
          body={
            confirming === 'archive'
              ? `This archives every chat in ${displayName(props.project)}. Files on your computer stay untouched.`
              : 'This only removes the project from the sidebar. Its folder and chats stay untouched.'
          }
          action={confirming === 'archive' ? 'Archive chats' : 'Remove project'}
          destructive={confirming === 'remove'}
          onConfirm={() => {
            if (confirming === 'archive') {
              props.onArchiveProject(props.project.sessions.map((session) => session.id))
            } else {
              props.onRemoveProject(props.project.path)
            }
            setConfirming(undefined)
          }}
          onClose={() => setConfirming(undefined)}
        />
      ) : null}

      {/* Height comes from grid-template-rows in CSS, so the animation covers
          the drawer's real height. The old per-row cap was double the actual
          row height, which spent half the duration moving nothing — the main
          reason the sidebar read as sluggish. */}
      <div className="proj__drawer" data-open={expanded && count > 0}>
        <ul className="proj__sessions">
          {visibleSessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              active={session.id === props.activeSessionId}
              onSelect={() => props.onSelectSession(session.id)}
              onRename={(title) => props.onRenameSession(session.id, title)}
              onDelete={() => props.onDeleteSession(session.id)}
              onTogglePin={() => props.onToggleSessionPin?.(session.id)}
              onOpenInExplorer={() => void revealPath(props.project.path)}
              reorderable={reorderable}
              dragging={session.id === draggedSessionId}
              dropPosition={dropTarget?.id === session.id ? dropTarget.position : undefined}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', session.id)
                setDraggedSessionId(session.id)
              }}
              onDragOver={(event) => dragOverSession(event, session.id)}
              onDrop={(event) => {
                event.preventDefault()
                if (
                  draggedSessionId &&
                  dropTarget?.id === session.id &&
                  draggedSessionId !== session.id
                ) {
                  props.onReorderSession(
                    props.project.path,
                    draggedSessionId,
                    session.id,
                    dropTarget.position,
                  )
                }
                endDrag()
              }}
              onDragEnd={endDrag}
            />
          ))}
          {hasMoreSessions ? (
            <li className="proj__sessions-toggle-row">
              <button
                type="button"
                className="proj__sessions-toggle"
                aria-expanded={showAllSessions}
                onClick={() => setShowAllSessions((current) => !current)}
              >
                {showAllSessions ? 'Show less' : 'Show more'}
              </button>
            </li>
          ) : null}
        </ul>
      </div>
    </section>
  )
}

function SessionRow(props: {
  session: Session
  active: boolean
  onSelect: () => void
  onRename: (title: string) => void
  onDelete: () => void
  onTogglePin: () => void
  onOpenInExplorer: () => void
  standalone?: boolean
  reorderable: boolean
  dragging: boolean
  dropPosition: DropPosition | undefined
  onDragStart: (event: DragEvent<HTMLLIElement>) => void
  onDragOver: (event: DragEvent<HTMLLIElement>) => void
  onDrop: (event: DragEvent<HTMLLIElement>) => void
  onDragEnd: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const contextMenuTarget = useRef<HTMLButtonElement>(null)

  if (renaming) {
    return (
      <li>
        <InlineRename
          value={props.session.title}
          onCommit={(title) => {
            props.onRename(title)
            setRenaming(false)
          }}
          onCancel={() => setRenaming(false)}
        />
      </li>
    )
  }

  return (
    <li
      className={`sessrow ${props.active ? 'is-active' : ''} ${props.standalone ? 'is-pinned' : ''} ${
        props.reorderable ? 'is-reorderable' : ''
      } ${props.dragging ? 'is-dragging' : ''}`}
      draggable={props.reorderable}
      data-drop-position={props.dropPosition}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onDragEnd={props.onDragEnd}
    >
      <button
        ref={contextMenuTarget}
        className={`sess ${props.active ? 'is-active' : ''}`}
        onClick={props.onSelect}
        onDoubleClick={() => setRenaming(true)}
        aria-label={sessionLabel(props.session)}
        title={sessionLabel(props.session)}
      >
        <span className="sess__title">{props.session.title}</span>
        <SessionStatus status={props.session.status} />
      </button>

      <span className="sess__actions">
        <button
          type="button"
          className="sess__action"
          onClick={() => setRenaming(true)}
          aria-label={`Rename ${props.session.title}`}
          title="Rename chat"
        >
          <Pencil size={13} aria-hidden />
        </button>
        <button
          type="button"
          className="sess__action"
          onClick={props.onDelete}
          aria-label={`Archive ${props.session.title}`}
          title="Archive chat"
        >
          <Archive size={14} aria-hidden />
        </button>
      </span>

      <div className="sess__context-menu">
        <Menu
          drop="down"
          align="right"
          label={`Options for ${props.session.title}`}
          triggerClassName="sess__context-menu-trigger"
          panelClassName="menu--sidebar"
          contextMenuTargetRef={contextMenuTarget}
          trigger={() => <Ellipsis size={16} aria-hidden />}
        >
          {(close) => (
            <>
              <MenuItem
                title={props.session.pinned ? 'Unpin chat' : 'Pin chat'}
                onClick={() => {
                  props.onTogglePin()
                  close()
                }}
              />
              <MenuItem
                title="Rename chat"
                onClick={() => {
                  setRenaming(true)
                  close()
                }}
              />
              <MenuItem
                title="Archive chat"
                onClick={() => {
                  props.onDelete()
                  close()
                }}
              />
              {isDesktop ? (
                <MenuItem
                  title="Open in Explorer"
                  onClick={() => {
                    props.onOpenInExplorer()
                    close()
                  }}
                />
              ) : null}
            </>
          )}
        </Menu>
      </div>
    </li>
  )
}

function SidebarConfirmDialog(props: {
  title: string
  body: string
  action: string
  destructive: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={props.title}>
      <button className="sheet__scrim" onClick={props.onClose} aria-label="Cancel" />
      <div className="sheet__panel sidebar-confirm">
        <header className="sheet__head">
          <h2 className="sheet__title">{props.title}</h2>
          <button className="icon-btn icon-btn--always" onClick={props.onClose} title="Close">
            <X size={13} aria-hidden />
          </button>
        </header>
        <section className="sheet__section">
          <p>{props.body}</p>
          <div className="sidebar-confirm__actions">
            <button className="ghost" onClick={props.onClose} autoFocus>
              Cancel
            </button>
            <button
              className={`btn${props.destructive ? ' btn--danger' : ''}`}
              onClick={props.onConfirm}
            >
              {props.action}
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

function SessionStatus(props: { status: Session['status'] }) {
  if (props.status === 'starting' || props.status === 'working') {
    return (
      <span className="sess__spinner" aria-hidden>
        {BRAILLE_SPINNER_FRAMES.map((frame) => (
          <span key={frame}>{frame}</span>
        ))}
      </span>
    )
  }

  if (props.status === 'approval' || props.status === 'input' || props.status === 'queued') {
    return <span className="sess__status-dot is-attention" aria-hidden />
  }

  if (props.status === 'failed') {
    return <span className="sess__status-dot is-failed" aria-hidden />
  }

  return null
}

function sessionLabel(session: Session): string {
  const branch = session.worktreeBranch ? `, isolated on ${session.worktreeBranch}` : ''
  switch (session.status) {
    case 'starting':
    case 'working':
      return `${session.title}, working${branch}`
    case 'queued':
      return `${session.title}, queued${branch}`
    case 'approval':
      return `${session.title}, waiting for approval${branch}`
    case 'input':
      return `${session.title}, needs attention${branch}`
    case 'failed':
      return `${session.title}, failed${branch}`
    case 'ready':
      return `${session.title}, ready${branch}`
    default:
      return `${session.title}${branch}`
  }
}

/** Rename in place. Enter commits, Escape reverts, blur commits. */
function InlineRename(props: {
  value: string
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(props.value)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.select()
  }, [])

  const commit = () => {
    const trimmed = draft.trim()
    if (trimmed === '') props.onCancel()
    else props.onCommit(trimmed)
  }

  return (
    <input
      ref={input}
      className="rename"
      value={draft}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') props.onCancel()
      }}
    />
  )
}

function displayName(project: Project): string {
  return project.name ?? basename(project.path)
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** A reset within the week reads as weekday and time; further out, as a date. */
function resetLabel(at: number): string {
  const date = new Date(at)
  const withinWeek = at - Date.now() < 6 * 86_400_000
  return date.toLocaleString(
    undefined,
    withinWeek
      ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric' },
  )
}

function initial(account: Account | undefined, fallback: string): string {
  const source = account?.email ?? fallback
  return source.slice(0, 1).toUpperCase()
}

/**
 * Memoised: the app root re-renders on every streamed frame, and this subtree
 * does not change while an answer arrives. The owner keeps every callback and
 * composite prop stable, so streamed text does not reconcile the session rail.
 */
export const Sidebar = memo(SidebarComponent)
