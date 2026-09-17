import { useArchiveMotion } from './useArchiveMotion.js'
import {
  lazy,
  memo,
  Suspense,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import type {
  Account,
  ProviderId,
  ResultOf,
  ThreadInboxStatus,
  ThreadLifecycle,
} from '@harness/contracts'
import {
  IconArchive as Archive,
  IconChevronUp as ChevronUp,
  IconDots as Ellipsis,
  IconFolderOpen as FolderOpen,
  IconFolderPlus as FolderPen,
  IconGitPullRequest as GitPullRequest,
  IconLayoutSidebarLeftCollapse as PanelLeftClose,
  IconLoader2 as LoaderCircle,
  IconPencil as Pencil,
  IconPinned as Pin,
  IconPinnedOff as PinOff,
  IconPlus as Plus,
  IconSearch as Search,
  IconSettings as Settings,
  IconEdit as SquarePen,
  IconUser as UserRound,
  IconX as X,
} from '@tabler/icons-react'
import {
  canDropProjectFolders,
  droppedProjectFolderPaths,
  isDesktop,
  revealPath,
} from '../bridge.js'
import {
  appHapticsSupported,
  performAppHaptic,
  prepareAppHaptics,
  readAppHaptics,
  ResizeHaptics,
  subscribeAppHaptics,
} from '../haptics.js'
import { sessionSourcePresentation } from '../provider-presentation.js'
import type { ProfileIdentityPreferences } from '../profile-preferences.js'
import { DEFAULT_KEYBINDINGS, shortcutAria, type Keybindings } from '../shortcuts.js'
import { GeneratedAvatar } from './GeneratedAvatar.js'
import { Menu, MenuItem } from './Menu.js'
import type { AccountLimitsState } from './AccountLimits.js'
import { useDialogFocus } from './dialog-focus.js'
import type { InboxActions } from './InboxSidebar.js'
import { SourceIdentity } from './SourceIdentity.js'

type AccountLimitsModule = typeof import('./AccountLimits.js')
type AccountLimitsComponent = AccountLimitsModule['AccountLimits']
type LazyAccountLimitsModule = { default: AccountLimitsComponent }
let accountLimitsPromise: Promise<LazyAccountLimitsModule> | undefined
let resolvedAccountLimits: AccountLimitsComponent | undefined
const loadAccountLimits = (): Promise<LazyAccountLimitsModule> =>
  (accountLimitsPromise ??= import('./AccountLimits.js').then((module) => {
    resolvedAccountLimits = module.AccountLimits
    return { default: module.AccountLimits }
  }))
const AccountLimits = lazy(loadAccountLimits)

const InboxSidebar = lazy(() =>
  import('./InboxSidebar.js').then((module) => ({ default: module.InboxSidebar })),
)

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
type ProjectDropTarget = { path: string; position: DropPosition }
type PinnedSession = { projectPath: string; session: Session }
type ProjectSidebarProjection = { project: Project; pinnedSessions: PinnedSession[] }

/** Narrowest width at which the New chat row and the chat rows stay
 *  roomy — the narrowest rail still looks deliberate, never squeezed. */
const MIN_RAIL_WIDTH = 240
/** Pulling the rail down to half its narrowest width reads as intent to
 *  collapse. A ratio rather than a pixel overshoot, so it keeps meaning the
 *  same thing when MIN_RAIL_WIDTH moves. */
const COLLAPSE_WIDTH = Math.round(MIN_RAIL_WIDTH * 0.5)
/** Mirrors --dur-slow: how long a fold or unfold takes to play out. */
const RAIL_FOLD_MS = 260
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
/** Folding by drag leaves the pointer sitting on the very edge that reveals the
 *  rail, so the release used to flash it straight back out. The reveal is held
 *  off for this long; afterwards a pointer still at the edge reveals it as
 *  usual, which is the behaviour someone parked there would expect. */
const REVEAL_COOLDOWN_MS = 1250
/** Matches the .rail__edge hit strip. */
const REVEAL_EDGE_WIDTH = 6
const MAX_RAIL_WIDTH = 420
const INITIAL_PROJECT_RENDER_COUNT = 30
const DEFERRED_PROJECT_RENDER_COUNT = 20
const DEFERRED_PROJECT_RENDER_TIMEOUT_MS = 100
const COLLAPSED_PROJECT_SESSION_COUNT = 5
const VIRTUALIZED_PROJECT_SESSION_COUNT = 64
const VIRTUAL_SESSION_ROW_HEIGHT = 27
const VIRTUAL_SESSION_VIEWPORT_ROWS = 16
const VIRTUAL_SESSION_OVERSCAN = 6
const VIRTUAL_SESSION_VIEWPORT_HEIGHT = VIRTUAL_SESSION_ROW_HEIGHT * VIRTUAL_SESSION_VIEWPORT_ROWS
const projectMenuTrigger = () => (
  <span className="dots">
    <Ellipsis size={16} aria-hidden />
  </span>
)

function SidebarComponent(props: {
  projects: Project[]
  activeProjectPath: string | undefined
  activeSessionId: string | undefined
  account: Account | undefined
  profileIdentity?: ProfileIdentityPreferences | undefined
  providerName: string
  keybindings?: Keybindings | undefined
  usageStates?: AccountLimitsState[] | undefined
  onRetryUsage?: ((provider: ProviderId) => void) | undefined
  onConsumeReset?:
    | ((
        provider: ProviderId,
        idempotencyKey: string,
        creditId?: string,
      ) => Promise<ResultOf<'usage.consumeReset'>>)
    | undefined
  mode?: 'classic' | 'inbox'
  inbox?: InboxActions | undefined
  collapsed: boolean
  width: number
  onClose: () => void
  onWidthChange: (width: number) => void
  onAddProject: () => void
  onAddDroppedProjects?: ((paths: string[]) => void) | undefined
  onNewSession: (projectPath?: string, chooseProject?: boolean) => void
  onSelectSession: (id: string) => void
  onRenameProject: (path: string, name: string) => void
  onRemoveProject: (path: string) => void
  onTogglePin: (path: string) => void
  onRenameSession: (id: string, title: string) => void
  onToggleSessionPin?: (id: string) => void
  onDeleteSession: (id: string) => void
  onArchiveProject: (sessionIds: string[]) => void
  onReorderProject?: (sourcePath: string, targetPath: string, position: DropPosition) => void
  onReorderSession: (
    projectPath: string,
    sourceId: string,
    targetId: string,
    position: DropPosition,
  ) => void
  onOpenSearch: (projectPath?: string) => void
  pullRequestsActive?: boolean | undefined
  onOpenPullRequests?: (() => void) | undefined
  onOpenSettings: (section?: 'profile') => void
}) {
  const keybindings = props.keybindings ?? DEFAULT_KEYBINDINGS
  const profileDisplayName = props.profileIdentity?.displayName.trim() || 'Local profile'
  const usageLimit = (props.usageStates ?? [])
    .flatMap((state) => {
      const source = state.summary?.limitSource
      const limits = source
        ? source.status === 'ready'
          ? source.limits
          : []
        : (state.summary?.limits ?? [])
      return limits.map((limit) => ({ ...limit, provider: state.provider }))
    })
    .filter((limit) => limit.valueLabel === undefined && Number.isFinite(limit.usedPercent))
    .reduce<{ usedPercent: number; label: string; provider: string } | undefined>(
      (highest, limit) => (!highest || limit.usedPercent > highest.usedPercent ? limit : highest),
      undefined,
    )
  const usageRemaining = usageLimit
    ? Math.min(100, Math.max(0, 100 - usageLimit.usedPercent))
    : undefined
  useEffect(() => {
    void loadAccountLimits()
  }, [])
  const slotRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<HTMLElement>(null)
  const resizeHandleRef = useRef<HTMLButtonElement>(null)
  const actionsRef = useRef(props)
  useLayoutEffect(() => {
    actionsRef.current = props
  })
  /** Kept out of React state on purpose. Revealing used to reconcile every
   *  project and chat row before the transform could even start. */
  const edgeRevealed = useRef(false)
  /** Set by the resize handle when its release is what collapsed the rail. */
  const foldedByDrag = useRef(false)
  /** True while the edge is being dragged: widening a revealed rail carries the
   *  pointer well clear of it, which must not read as leaving. */
  const resizing = useRef(false)
  /** Running while a just-folded rail refuses to reveal again. */
  const coolDown = useRef<number | undefined>(undefined)
  /** Where the pointer was last seen during that wait. */
  const pointerX = useRef(Number.POSITIVE_INFINITY)
  /** Hiding the reveal only after a grace period lets the pointer travel up to
   *  the title bar toggle without the flyout flickering away underneath it. */
  const revealHide = useRef<number | undefined>(undefined)
  /** Keeps the quick retract transition selected until it finishes. */
  const revealOut = useRef<number | undefined>(undefined)

  const cancelRevealHide = useCallback(() => {
    if (revealHide.current === undefined) return
    clearTimeout(revealHide.current)
    revealHide.current = undefined
  }, [])

  const cancelRevealOut = useCallback(() => {
    if (revealOut.current === undefined) return
    clearTimeout(revealOut.current)
    revealOut.current = undefined
  }, [])

  /** Updates only the two DOM contracts that control the compositor layer.
   *  The sidebar contents do not depend on temporary hover state, so they do
   *  not need a React render when the pointer touches the window edge. */
  const setEdgeReveal = useCallback(
    (revealed: boolean, animateExit = true) => {
      const slot = slotRef.current
      if (!slot) return
      const collapsed = slot.classList.contains('is-collapsed')
      if (revealed && !collapsed) return

      cancelRevealHide()
      cancelRevealOut()
      edgeRevealed.current = revealed
      slot.classList.toggle('is-revealed', revealed)
      railRef.current?.toggleAttribute('inert', collapsed && !revealed)
      if (resizeHandleRef.current) {
        resizeHandleRef.current.hidden = collapsed && !revealed
      }

      if (revealed || !animateExit || !collapsed) {
        slot.classList.remove('is-reveal-out')
        return
      }

      slot.classList.add('is-reveal-out')
      revealOut.current = window.setTimeout(() => {
        revealOut.current = undefined
        slot.classList.remove('is-reveal-out')
      }, REVEAL_OUT_MS)
    },
    [cancelRevealHide, cancelRevealOut],
  )

  const endCooldown = useCallback(() => {
    if (coolDown.current !== undefined) clearTimeout(coolDown.current)
    coolDown.current = undefined
  }, [])

  const startCooldown = useCallback(
    (releaseX: number) => {
      pointerX.current = releaseX
      if (coolDown.current !== undefined) clearTimeout(coolDown.current)
      coolDown.current = window.setTimeout(() => {
        coolDown.current = undefined
        // The wait is over: a pointer still parked at the edge gets its reveal.
        if (pointerX.current <= REVEAL_EDGE_WIDTH) setEdgeReveal(true)
      }, REVEAL_COOLDOWN_MS)
    },
    [setEdgeReveal],
  )

  useEffect(
    () => () => {
      cancelRevealHide()
      cancelRevealOut()
      endCooldown()
    },
    [cancelRevealHide, cancelRevealOut, endCooldown],
  )

  /* Collapsing hands the rail to the absolute flyout, whose translate would
     animate in from no transform at all — the rail appearing at full width
     before sliding away. After a drag fold it is already gone, so that reads
     as it flashing open and shut. This runs on React's commit, before the
     browser paints, which is the only point where suppressing it is reliable;
     the handle cannot do it because the collapsed class does not exist yet. */
  useLayoutEffect(() => {
    const slot = slotRef.current
    const shell = slot?.closest<HTMLElement>('.shell')
    if (props.collapsed && shell) {
      delete shell.dataset['railFoldPreview']
      delete shell.dataset['resizing']
      resizing.current = false
    }
    // Expanding the rail by any other means ends the wait: it only exists to
    // stop a just-folded rail from springing back out.
    if (!props.collapsed) endCooldown()
    if (!props.collapsed || !foldedByDrag.current || !slot) {
      foldedByDrag.current = false
      return
    }
    foldedByDrag.current = false
    if (!shell) return
    // The stored width is restored here, not on release: the collapsed layout
    // is already committed at this point, so the column reads 0 whatever
    // --rail-w says. Written from the handler it landed a moment too early,
    // while the collapsed class was still missing, and the column really was
    // that wide for a frame — the jump right and back that survived every
    // earlier attempt at this.
    shell.dataset['resizing'] = ''
    shell.style.setProperty('--rail-w', `${props.width}px`)
    // Commit the collapsed layout while it still cannot animate.
    void shell.offsetWidth
    const frame = requestAnimationFrame(() => {
      delete shell.dataset['resizing']
    })
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- width is read, not a trigger
  }, [endCooldown, props.collapsed])

  const scheduleRevealHide = useCallback(() => {
    // Never restarted. This is called from every mouse move outside the rail,
    // and re-arming each time meant the grace only elapsed once the pointer
    // came to a complete stop — so a rail left behind while the mouse kept
    // moving stayed open for as long as the movement lasted.
    if (!edgeRevealed.current || revealHide.current !== undefined) return
    revealHide.current = window.setTimeout(() => {
      revealHide.current = undefined
      setEdgeReveal(false)
    }, REVEAL_GRACE_MS)
  }, [setEdgeReveal])

  /* What keeps a revealed rail in place. The slot's own mouse events cannot
     see the title bar above it, and that is exactly where someone aims to pin
     the rail open — so the whole column counts as inside, plus a buffer past
     its edge. Retracting while the user is still travelling toward the toggle
     is what made the reveal feel like it snapped back on its own. */
  useEffect(() => {
    if (!props.collapsed) return
    const onMove = (event: MouseEvent) => {
      if (coolDown.current !== undefined) pointerX.current = event.clientX
      if (!edgeRevealed.current) return
      if (resizing.current || event.clientX <= props.width + REVEAL_KEEP_BUFFER) {
        cancelRevealHide()
      } else {
        scheduleRevealHide()
      }
    }
    // Pointer position decides, and only this listener decides: the slot's own
    // mouseleave used to schedule the hide unconditionally, so travelling up
    // into the title bar armed it — and if the pointer then came to rest, no
    // further move arrived to disarm it and the rail folded away under the
    // toggle the user was about to press.
    window.addEventListener('mousemove', onMove)
    // Leaving the window entirely produces no more moves, so it is its own signal.
    const onLeave = () => scheduleRevealHide()
    document.addEventListener('mouseleave', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onLeave)
    }
  }, [cancelRevealHide, props.collapsed, props.width, scheduleRevealHide])
  const [scope, setScope] = useState('')
  const [bodyScrolled, setBodyScrolled] = useState(false)
  const inbox = props.mode === 'inbox' && props.inbox !== undefined

  const closeOnNarrowViewport = useCallback(() => {
    if (globalThis.matchMedia?.('(max-width: 700px)').matches) actionsRef.current.onClose()
  }, [])

  const selectSession = useCallback(
    (id: string) => {
      actionsRef.current.onSelectSession(id)
      closeOnNarrowViewport()
    },
    [closeOnNarrowViewport],
  )

  const newSession = useCallback(
    (projectPath?: string, chooseProject?: boolean) => {
      actionsRef.current.onNewSession(projectPath, chooseProject)
      closeOnNarrowViewport()
    },
    [closeOnNarrowViewport],
  )

  const addProject = useCallback(() => {
    props.onAddProject()
    closeOnNarrowViewport()
  }, [closeOnNarrowViewport, props.onAddProject])

  const openPullRequests = useCallback(() => {
    actionsRef.current.onOpenPullRequests?.()
    closeOnNarrowViewport()
  }, [closeOnNarrowViewport])

  const renameProject = useCallback(
    (path: string, name: string) => actionsRef.current.onRenameProject(path, name),
    [],
  )
  const removeProject = useCallback((path: string) => actionsRef.current.onRemoveProject(path), [])
  const toggleProjectPin = useCallback((path: string) => actionsRef.current.onTogglePin(path), [])
  const renameSession = useCallback(
    (id: string, title: string) => actionsRef.current.onRenameSession(id, title),
    [],
  )
  const toggleSessionPin = useCallback(
    (id: string) => actionsRef.current.onToggleSessionPin?.(id),
    [],
  )
  const animateArchive = useArchiveMotion()
  const deleteSession = useCallback(
    (id: string) => {
      animateArchive([id], (ids) => {
        for (const sessionId of ids) actionsRef.current.onDeleteSession(sessionId)
      })
    },
    [animateArchive],
  )
  const archiveProject = useCallback(
    (sessionIds: string[]) =>
      animateArchive(sessionIds, (ids) => actionsRef.current.onArchiveProject(ids)),
    [animateArchive],
  )
  const reorderSession = useCallback(
    (projectPath: string, sourceId: string, targetId: string, position: DropPosition) =>
      actionsRef.current.onReorderSession(projectPath, sourceId, targetId, position),
    [],
  )

  useEffect(() => {
    if (props.collapsed) return
    // Opening from the temporary reveal must dock in place: the flyout and
    // the grid rail occupy the same pixels, so the column animation is
    // suppressed for a frame — otherwise the rail visibly closed and
    // re-opened on the toggle click.
    const slot = slotRef.current
    const shell = slot?.closest<HTMLElement>('.shell')
    if (edgeRevealed.current && shell) {
      shell.dataset['resizing'] = ''
      requestAnimationFrame(() => requestAnimationFrame(() => delete shell.dataset['resizing']))
    }
    setEdgeReveal(false, false)
  }, [props.collapsed, setEdgeReveal])

  useEffect(() => {
    if (scope && !props.projects.some((project) => project.path === scope)) setScope('')
  }, [props.projects, scope])

  // A status push replaces one project in an otherwise retained tree. Keep
  // every unchanged projection stable so React only reconciles that project.
  const { orderedProjects, pinnedSessions } = useMemo(() => {
    const pinned: PinnedSession[] = []
    const pinnedProjects: Project[] = []
    const projects: Project[] = []
    for (const source of props.projects) {
      const projection = projectSidebarProjection(source)
      pinned.push(...projection.pinnedSessions)
      if (source.pinned) pinnedProjects.push(projection.project)
      else projects.push(projection.project)
    }
    return {
      orderedProjects: [...pinnedProjects, ...projects],
      pinnedSessions: prioritizeSessions(pinned, ({ session }) => session),
    }
  }, [props.projects])
  const [draggedProjectPath, setDraggedProjectPath] = useState<string>()
  const [folderDropActive, setFolderDropActive] = useState(false)
  const folderDragDepth = useRef(0)
  const [projectDropTarget, setProjectDropTarget] = useState<ProjectDropTarget>()
  const draggedProjectPathRef = useRef<string | undefined>(undefined)
  const projectDropTargetRef = useRef<ProjectDropTarget | undefined>(undefined)
  const orderedProjectsRef = useRef(orderedProjects)
  orderedProjectsRef.current = orderedProjects
  const [projectRenderLimit, setProjectRenderLimit] = useState(INITIAL_PROJECT_RENDER_COUNT)
  const { renderedProjects, renderedProjectCount } = useMemo(() => {
    let count = Math.min(projectRenderLimit, orderedProjects.length)
    if (count < orderedProjects.length && props.activeProjectPath) {
      const activeIndex = orderedProjects.findIndex(
        (project) => project.path === props.activeProjectPath,
      )
      if (activeIndex >= count) count = activeIndex + 1
    }
    return {
      renderedProjectCount: count,
      renderedProjects:
        count === orderedProjects.length ? orderedProjects : orderedProjects.slice(0, count),
    }
  }, [orderedProjects, projectRenderLimit, props.activeProjectPath])

  useEffect(() => {
    if (inbox || renderedProjectCount >= orderedProjects.length) return

    // Thirty collapsed rows already cover a normal rail viewport. Mount the
    // remaining dormant rows in short idle batches instead of making a large
    // project catalog consume the first frame. The active project bypasses
    // the limit above, so restoring a deep selection never waits for idle.
    const revealNextProjects = () => {
      setProjectRenderLimit((current) =>
        Math.min(
          orderedProjects.length,
          Math.max(current, renderedProjectCount) + DEFERRED_PROJECT_RENDER_COUNT,
        ),
      )
    }
    if (typeof window.requestIdleCallback === 'function') {
      const idle = window.requestIdleCallback(revealNextProjects, {
        timeout: DEFERRED_PROJECT_RENDER_TIMEOUT_MS,
      })
      return () => window.cancelIdleCallback(idle)
    }

    const timeout = window.setTimeout(revealNextProjects, 0)
    return () => window.clearTimeout(timeout)
  }, [inbox, orderedProjects.length, renderedProjectCount])

  const endProjectDrag = useCallback(() => {
    draggedProjectPathRef.current = undefined
    projectDropTargetRef.current = undefined
    setDraggedProjectPath(undefined)
    setProjectDropTarget(undefined)
  }, [])

  const startProjectDrag = useCallback((event: DragEvent<HTMLElement>, project: Project) => {
    if (event.target !== event.currentTarget || !actionsRef.current.onReorderProject) return
    prepareAppHaptics()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', project.path)
    draggedProjectPathRef.current = project.path
    setDraggedProjectPath(project.path)
  }, [])

  const dragOverProject = useCallback((event: DragEvent<HTMLElement>, project: Project) => {
    const draggedPath = draggedProjectPathRef.current
    if (!draggedPath || draggedPath === project.path) return
    const source = orderedProjectsRef.current.find((candidate) => candidate.path === draggedPath)
    if (source?.pinned !== project.pinned) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const bounds = event.currentTarget.getBoundingClientRect()
    const position: DropPosition =
      event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
    const current = projectDropTargetRef.current
    if (current?.path === project.path && current.position === position) return
    const next = { path: project.path, position }
    projectDropTargetRef.current = next
    setProjectDropTarget(next)
    performAppHaptic('alignment')
  }, [])

  const dropProject = useCallback(
    (event: DragEvent<HTMLElement>, project: Project) => {
      event.preventDefault()
      const draggedPath = draggedProjectPathRef.current
      const target = projectDropTargetRef.current
      if (draggedPath && target?.path === project.path) {
        actionsRef.current.onReorderProject?.(draggedPath, project.path, target.position)
      }
      endProjectDrag()
    },
    [endProjectDrag],
  )

  const folderDropEnabled = canDropProjectFolders && props.onAddDroppedProjects !== undefined
  const hasDroppedFiles = (event: DragEvent<HTMLElement>) =>
    Array.from(event.dataTransfer.types ?? []).includes('Files')

  const showFolderDropTarget = (event: DragEvent<HTMLElement>) => {
    if (!folderDropEnabled || !hasDroppedFiles(event)) return
    event.preventDefault()
    folderDragDepth.current += 1
    if (folderDragDepth.current === 1) setFolderDropActive(true)
  }

  const hideFolderDropTarget = (event: DragEvent<HTMLElement>) => {
    if (!folderDropEnabled || !hasDroppedFiles(event)) return
    folderDragDepth.current = Math.max(0, folderDragDepth.current - 1)
    if (folderDragDepth.current === 0) setFolderDropActive(false)
  }

  const addDroppedProjects = (event: DragEvent<HTMLElement>) => {
    if (!folderDropEnabled || !hasDroppedFiles(event)) return
    event.preventDefault()
    folderDragDepth.current = 0
    setFolderDropActive(false)
    event.dataTransfer.dropEffect = 'copy'
    void droppedProjectFolderPaths(event.dataTransfer.files).then((paths) => {
      if (paths.length > 0) props.onAddDroppedProjects?.(paths)
    })
  }

  return (
    <div
      ref={slotRef}
      className={`rail-slot ${props.collapsed ? 'is-collapsed' : ''}`}
      onMouseEnter={cancelRevealHide}
    >
      {props.collapsed ? (
        <div
          className="rail__edge"
          aria-hidden
          onMouseEnter={() => {
            // A rail just folded by dragging stays folded, even though the
            // pointer is still resting on this strip.
            if (coolDown.current !== undefined) return
            setEdgeReveal(true)
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

      <nav
        ref={railRef}
        className={`rail${folderDropActive ? ' is-folder-drop-target' : ''}`}
        inert={props.collapsed ? true : undefined}
        onDragEnter={showFolderDropTarget}
        onDragOver={(event) => {
          if (!folderDropEnabled || !hasDroppedFiles(event)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={hideFolderDropTarget}
        onDrop={addDroppedProjects}
      >
        {folderDropActive ? (
          <div className="rail__folder-drop" role="status">
            <FolderOpen size={18} aria-hidden />
            <span>Drop folders to add projects</span>
          </div>
        ) : null}
        {inbox ? (
          <Suspense fallback={null}>
            <InboxSidebar
              projects={props.projects}
              scope={scope}
              activeProjectPath={props.activeProjectPath}
              activeSessionId={props.activeSessionId}
              actions={props.inbox!}
              onScopeChange={setScope}
              onAddProject={addProject}
              onNewSession={newSession}
              onSelectSession={selectSession}
              onRenameSession={renameSession}
              onToggleSessionPin={toggleSessionPin}
              onArchiveSession={deleteSession}
              onArchiveSessions={archiveProject}
              pullRequestsActive={props.pullRequestsActive}
              onOpenPullRequests={props.onOpenPullRequests ? openPullRequests : undefined}
            />
          </Suspense>
        ) : (
          <>
            <div className={`rail__actions${bodyScrolled ? ' is-scrolled' : ''}`}>
              <div className="rail__row">
                <button
                  className="navitem rail__new-chat"
                  aria-keyshortcuts={shortcutAria(keybindings.newChat)}
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
                  <SquarePen size={13} aria-hidden />
                  <span>New chat</span>
                </button>
                <button
                  type="button"
                  className="rail__search"
                  onClick={() => props.onOpenSearch()}
                  aria-label="Search chats"
                  title="Search chats"
                  aria-keyshortcuts={shortcutAria(keybindings.searchSessions)}
                >
                  <Search size={13} aria-hidden />
                </button>
              </div>
              <button
                className="navitem rail__new-project"
                onClick={() => {
                  props.onAddProject()
                  closeOnNarrowViewport()
                }}
                aria-keyshortcuts={shortcutAria(keybindings.newProject)}
              >
                <FolderPen size={13} aria-hidden />
                <span>New project</span>
              </button>
              {props.onOpenPullRequests ? (
                <button
                  type="button"
                  className={`navitem rail__pull-requests${props.pullRequestsActive ? ' is-active' : ''}`}
                  aria-current={props.pullRequestsActive ? 'page' : undefined}
                  aria-keyshortcuts={shortcutAria(keybindings.openPullRequests)}
                  onClick={openPullRequests}
                >
                  <GitPullRequest size={13} aria-hidden />
                  <span>Pull requests</span>
                </button>
              ) : null}
            </div>

            <div
              className="rail__body"
              onScroll={(event) => setBodyScrolled(event.currentTarget.scrollTop > 0)}
            >
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
              <div className="section section--row">
                <span>Projects</span>
                <button
                  type="button"
                  className="section__add"
                  aria-label="New project"
                  title="New project"
                  onClick={() => {
                    props.onAddProject()
                    closeOnNarrowViewport()
                  }}
                >
                  <Plus size={12} aria-hidden />
                </button>
              </div>
              {orderedProjects.length === 0 ? (
                <p className="rail__hint">Nothing here yet.</p>
              ) : (
                renderedProjects.map((project) => (
                  <ProjectRow
                    key={project.path}
                    project={project}
                    activeSessionId={
                      project.path === props.activeProjectPath ? props.activeSessionId : undefined
                    }
                    active={project.path === props.activeProjectPath}
                    reorderable={Boolean(props.onReorderProject)}
                    dragging={project.path === draggedProjectPath}
                    dropPosition={
                      projectDropTarget?.path === project.path
                        ? projectDropTarget.position
                        : undefined
                    }
                    onProjectDragStart={startProjectDrag}
                    onProjectDragOver={dragOverProject}
                    onProjectDrop={dropProject}
                    onProjectDragEnd={endProjectDrag}
                    onNewSession={newSession}
                    onSelectSession={selectSession}
                    onRenameProject={renameProject}
                    onRemoveProject={removeProject}
                    onTogglePin={toggleProjectPin}
                    onRenameSession={renameSession}
                    onToggleSessionPin={props.onToggleSessionPin ? toggleSessionPin : undefined}
                    onDeleteSession={deleteSession}
                    onArchiveProject={archiveProject}
                    onReorderSession={reorderSession}
                  />
                ))
              )}
            </div>
          </>
        )}

        <div className="rail__foot">
          <Menu
            drop="up"
            gap={14}
            label="Account"
            panelClassName="menu--compact menu--settings"
            panelRole="dialog"
            panelLabel="Account and plan limits"
            trigger={() => (
              <span className="account">
                <span className="account__avatar">
                  {props.profileIdentity?.avatarDataUrl ? (
                    <img src={props.profileIdentity.avatarDataUrl} alt="" />
                  ) : (
                    <GeneratedAvatar name={profileDisplayName} />
                  )}
                </span>
                <span className="account__name">{profileDisplayName}</span>
                {usageLimit && usageRemaining !== undefined && usageRemaining <= 20 ? (
                  <span
                    className="account__usage"
                    title={`${Math.round(usageRemaining)}% left · ${usageLimit.provider} · ${usageLimit.label}`}
                    aria-label={`${Math.round(usageRemaining)}% of usage limit left`}
                  >
                    {Math.round(usageRemaining)}%
                  </span>
                ) : null}
                <ChevronUp className="account__chevron" size={13} aria-hidden />
              </span>
            )}
          >
            {(close) => {
              const RenderedAccountLimits = resolvedAccountLimits ?? AccountLimits
              return (
                <>
                  {props.usageStates ? (
                    <Suspense fallback={null}>
                      <RenderedAccountLimits
                        states={props.usageStates}
                        onRetry={props.onRetryUsage ?? noop}
                        onConsumeReset={props.onConsumeReset}
                      />
                    </Suspense>
                  ) : null}
                  <div className="account-menu__actions">
                    <button
                      type="button"
                      className="menu__item"
                      onClick={() => {
                        props.onOpenSettings('profile')
                        closeOnNarrowViewport()
                        close()
                      }}
                    >
                      <DialogAction icon={<UserRound size={14} aria-hidden />} title="Profile" />
                    </button>
                    <button
                      type="button"
                      className="menu__item"
                      aria-keyshortcuts={shortcutAria(keybindings.settings)}
                      onClick={() => {
                        props.onOpenSettings()
                        closeOnNarrowViewport()
                        close()
                      }}
                    >
                      <DialogAction icon={<Settings size={14} aria-hidden />} title="Settings" />
                    </button>
                  </div>
                </>
              )
            }}
          </Menu>
        </div>
      </nav>
      <RailResizeHandle
        buttonRef={resizeHandleRef}
        hidden={props.collapsed}
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
        onCollapse={(releaseX) => {
          foldedByDrag.current = true
          startCooldown(releaseX)
          props.onClose()
        }}
      />
    </div>
  )
}

function RailResizeHandle(props: {
  buttonRef: RefObject<HTMLButtonElement | null>
  hidden: boolean
  width: number
  /** False on a revealed rail: it is already collapsed, so the drag only sizes it. */
  foldable: boolean
  onWidthChange: (width: number) => void
  onResizingChange: (active: boolean) => void
  onCollapse: (releaseX: number) => void
}) {
  const hapticsPreference = useSyncExternalStore(
    subscribeAppHaptics,
    readAppHaptics,
    readAppHaptics,
  )
  const hapticsEnabled = appHapticsSupported() && hapticsPreference
  const drag = useRef<
    | {
        startX: number
        width: number
        current: number
        folded: boolean
        haptics: ResizeHaptics | undefined
      }
    | undefined
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

  const previewFold = (target: HTMLElement, folded: boolean) => {
    const shell = target.closest<HTMLElement>('.shell')
    if (!shell) return
    if (folded) shell.dataset['railFoldPreview'] = ''
    else delete shell.dataset['railFoldPreview']
  }

  /* The grid-column transition is for collapse and expand; while a pointer is
     dragging it made the rail rubber-band behind the cursor. */
  const setResizing = (target: HTMLElement, active: boolean) => {
    const shell = target.closest<HTMLElement>('.shell')
    if (!shell) return
    if (active) {
      shell.dataset['resizing'] = ''
      return
    }
    delete shell.dataset['resizing']
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

  const cancelResize = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current
    if (!current) return
    const target = event.currentTarget
    drag.current = undefined
    if (target.hasPointerCapture?.(event.pointerId)) {
      target.releasePointerCapture?.(event.pointerId)
    }
    previewFold(target, false)
    // Restore the last real width before handing input back to the titlebar or
    // the rest of the window.
    preview(target, current.current)
    setResizing(target, false)
    props.onResizingChange(false)
    props.onWidthChange(current.current)
  }

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    if (event.key === 'ArrowLeft' && props.width <= MIN_RAIL_WIDTH) {
      props.onCollapse(Number.POSITIVE_INFINITY)
      return
    }
    props.onWidthChange(clampRailWidth(props.width + (event.key === 'ArrowLeft' ? -8 : 8)))
  }

  return (
    <button
      ref={props.buttonRef}
      type="button"
      hidden={props.hidden}
      className="rail__resize"
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemin={MIN_RAIL_WIDTH}
      aria-valuemax={MAX_RAIL_WIDTH}
      aria-valuenow={props.width}
      onKeyDown={resizeWithKeyboard}
      onPointerEnter={() => {
        if (hapticsEnabled) prepareAppHaptics()
      }}
      onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
        if (hapticsEnabled) prepareAppHaptics()
        previewFold(event.currentTarget, false)
        event.currentTarget.setPointerCapture?.(event.pointerId)
        setResizing(event.currentTarget, true)
        props.onResizingChange(true)
        drag.current = {
          startX: event.clientX,
          width: props.width,
          current: props.width,
          folded: false,
          haptics: hapticsEnabled
            ? new ResizeHaptics({
                startValue: props.width,
                startTime: event.timeStamp,
                minValue: MIN_RAIL_WIDTH,
                maxValue: MAX_RAIL_WIDTH,
              })
            : undefined,
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
        const next = clampRailWidth(raw)
        const tracking = !folded && settling.current === undefined && next !== drag.current.current
        const feedback = drag.current.haptics?.sample({
          rawValue: raw,
          value: next,
          tracking,
          time: event.timeStamp,
        })
        const foldChanged = folded !== drag.current.folded
        if (foldChanged) performAppHaptic('generic')
        else if (feedback) performAppHaptic(feedback)
        if (foldChanged) {
          drag.current.folded = folded
          if (!folded) {
            drag.current.current = next
          }
          setResizing(event.currentTarget, false)
          holdTransition()
          previewFold(event.currentTarget, folded)
          if (!folded) preview(event.currentTarget, drag.current.current)
          return
        }
        if (folded) return
        // Straight after a fold or unfold the transition stays on, so the rail
        // eases into the cursor rather than snapping out of a half-played
        // animation. Once it has settled, tracking is 1:1 again.
        if (settling.current === undefined) setResizing(event.currentTarget, true)
        drag.current.current = next
        preview(event.currentTarget, next)
      }}
      onPointerUp={(event: PointerEvent<HTMLButtonElement>) => {
        if (!drag.current) return
        const target = event.currentTarget
        const { current: width, folded } = drag.current
        drag.current = undefined
        target.releasePointerCapture?.(event.pointerId)
        props.onResizingChange(false)
        if (folded) {
          // The rail stays at the folded width here. Restoring the stored one
          // is the Sidebar's job on the commit that adds the collapsed class,
          // where the column reads 0 regardless; doing it now would widen the
          // column for real, because that class does not exist yet.
          // Suppression stays on and is cleared there too: this handle is
          // unmounted by then and could not do it itself.
          setResizing(target, true)
          props.onCollapse(event.clientX)
          return
        }
        setResizing(target, false)
        props.onWidthChange(width)
      }}
      onPointerCancel={cancelResize}
      onLostPointerCapture={cancelResize}
    />
  )
}

function clampRailWidth(width: number): number {
  return Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, Math.round(width)))
}

const ProjectRow = memo(function ProjectRow(props: {
  project: Project
  activeSessionId: string | undefined
  active: boolean
  reorderable: boolean
  dragging: boolean
  dropPosition: DropPosition | undefined
  onProjectDragStart: (event: DragEvent<HTMLElement>, project: Project) => void
  onProjectDragOver: (event: DragEvent<HTMLElement>, project: Project) => void
  onProjectDrop: (event: DragEvent<HTMLElement>, project: Project) => void
  onProjectDragEnd: () => void
  onNewSession: (path: string) => void
  onSelectSession: (id: string) => void
  onRenameProject: (path: string, name: string) => void
  onRemoveProject: (path: string) => void
  onTogglePin: (path: string) => void
  onRenameSession: (id: string, title: string) => void
  onToggleSessionPin: ((id: string) => void) | undefined
  onDeleteSession: (id: string) => void
  onArchiveProject: (sessionIds: string[]) => void
  onReorderSession: (
    projectPath: string,
    sourceId: string,
    targetId: string,
    position: DropPosition,
  ) => void
}) {
  const count = props.project.sessions.length
  const [open, setOpen] = useState(props.active)
  const [sessionsMounted, setSessionsMounted] = useState(props.active)
  const [showAllSessions, setShowAllSessions] = useState(false)
  const [actionsReady, setActionsReady] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState<'archive' | 'remove'>()
  const contextMenuTarget = useRef<HTMLButtonElement>(null)
  const previousCount = useRef(count)
  const openRef = useRef(props.active)
  const sessionUnmountTimer = useRef<number | undefined>(undefined)
  const expanded = open

  const cancelSessionUnmount = useCallback(() => {
    if (sessionUnmountTimer.current === undefined) return
    window.clearTimeout(sessionUnmountTimer.current)
    sessionUnmountTimer.current = undefined
  }, [])

  const finishSessionUnmount = useCallback(() => {
    cancelSessionUnmount()
    setSessionsMounted(false)
  }, [cancelSessionUnmount])

  const setProjectOpen = useCallback(
    (next: boolean) => {
      if (next === openRef.current) return
      openRef.current = next
      cancelSessionUnmount()
      if (next) {
        setSessionsMounted(true)
        setOpen(true)
        return
      }
      setOpen(false)
      sessionUnmountTimer.current = window.setTimeout(finishSessionUnmount, RAIL_FOLD_MS)
    },
    [cancelSessionUnmount, finishSessionUnmount],
  )

  useEffect(() => {
    if (previousCount.current === 0 && count > 0) setProjectOpen(true)
    previousCount.current = count
  }, [count, setProjectOpen])

  // Reveal the active project without closing projects the user already opened.
  // Run before paint so a delayed mount effect cannot undo a manual toggle.
  useLayoutEffect(() => {
    if (props.active) setProjectOpen(true)
  }, [props.active, setProjectOpen])

  useEffect(() => cancelSessionUnmount, [cancelSessionUnmount])

  return (
    <section
      className={`proj${props.dragging ? ' is-dragging' : ''}`}
      data-open={expanded}
      data-drop-position={props.dropPosition}
      draggable={props.reorderable}
      onDragStart={(event) => props.onProjectDragStart(event, props.project)}
      onDragOver={(event) => props.onProjectDragOver(event, props.project)}
      onDrop={(event) => props.onProjectDrop(event, props.project)}
      onDragEnd={props.onProjectDragEnd}
    >
      <div
        className="proj__head"
        onMouseEnter={() => setActionsReady(true)}
        onFocusCapture={() => setActionsReady(true)}
        onContextMenuCapture={() => setActionsReady(true)}
      >
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
                if (count === 0) {
                  setProjectOpen(!expanded)
                  return
                }
                if (expanded) setShowAllSessions(false)
                setProjectOpen(!expanded)
              }}
              aria-expanded={expanded}
              title={props.project.path}
            >
              <span className="proj__mark" aria-hidden />
              <span className="proj__name">{displayName(props.project)}</span>
            </button>

            <Menu
              drop="down"
              align="right"
              label="Project options"
              panelClassName="menu--sidebar"
              contextMenuTargetRef={contextMenuTarget}
              {...(actionsReady
                ? { trigger: projectMenuTrigger }
                : { contextMenuOnly: true as const })}
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
              {actionsReady ? <SquarePen size={15} aria-hidden /> : null}
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
      <div
        className="proj__drawer"
        data-open={expanded}
        aria-hidden={!expanded}
        onTransitionEnd={(event) => {
          if (
            event.target === event.currentTarget &&
            event.propertyName === 'grid-template-rows' &&
            !expanded
          ) {
            finishSessionUnmount()
          }
        }}
      >
        {sessionsMounted ? (
          <ProjectSessions
            project={props.project}
            activeSessionId={props.activeSessionId}
            showAll={showAllSessions}
            onShowAllChange={setShowAllSessions}
            onSelectSession={props.onSelectSession}
            onRenameSession={props.onRenameSession}
            onDeleteSession={props.onDeleteSession}
            onToggleSessionPin={props.onToggleSessionPin}
            onReorderSession={props.onReorderSession}
          />
        ) : null}
      </div>
    </section>
  )
})

const ProjectSessions = memo(function ProjectSessions(props: {
  project: Project
  activeSessionId: string | undefined
  showAll: boolean
  onShowAllChange: (showAll: boolean) => void
  onSelectSession: (id: string) => void
  onRenameSession: (id: string, title: string) => void
  onToggleSessionPin: ((id: string) => void) | undefined
  onDeleteSession: (id: string) => void
  onReorderSession: (
    projectPath: string,
    sourceId: string,
    targetId: string,
    position: DropPosition,
  ) => void
}) {
  const count = props.project.sessions.length
  const [draggedSessionId, setDraggedSessionId] = useState<string>()
  const [dropTarget, setDropTarget] = useState<{
    id: string
    position: DropPosition
  }>()
  const draggedSessionIdRef = useRef<string | undefined>(undefined)
  const dropTargetRef = useRef<{ id: string; position: DropPosition } | undefined>(undefined)
  const virtualSessionList = useRef<HTMLUListElement>(null)
  const virtualized = props.showAll && count > VIRTUALIZED_PROJECT_SESSION_COUNT
  const [virtualRange, setVirtualRange] = useState(() =>
    virtualSessionRange(0, props.project.sessions.length),
  )
  const virtualRangeRef = useRef(virtualRange)
  const updateVirtualRange = useCallback(
    (scrollTop: number) => {
      const next = virtualSessionRange(scrollTop, count)
      const current = virtualRangeRef.current
      if (current.start === next.start && current.end === next.end) return
      virtualRangeRef.current = next
      setVirtualRange(next)
    },
    [count],
  )
  const visibleStart = virtualized ? virtualRange.start : 0
  const visibleSessions = props.showAll
    ? virtualized
      ? props.project.sessions.slice(virtualRange.start, virtualRange.end)
      : props.project.sessions
    : props.project.sessions.slice(0, COLLAPSED_PROJECT_SESSION_COUNT)
  const virtualHeight = (count + 1) * VIRTUAL_SESSION_ROW_HEIGHT
  const virtualListStyle = virtualized
    ? ({
        '--virtual-session-height': `${virtualHeight}px`,
        height: Math.min(virtualHeight, VIRTUAL_SESSION_VIEWPORT_HEIGHT),
      } as CSSProperties)
    : undefined

  useLayoutEffect(() => {
    if (!virtualized) return
    const list = virtualSessionList.current
    if (!list) return
    const activeIndex = props.activeSessionId
      ? props.project.sessions.findIndex((session) => session.id === props.activeSessionId)
      : -1
    const target = Math.max(
      0,
      Math.min(
        activeIndex * VIRTUAL_SESSION_ROW_HEIGHT - VIRTUAL_SESSION_VIEWPORT_HEIGHT / 2,
        virtualHeight - VIRTUAL_SESSION_VIEWPORT_HEIGHT,
      ),
    )
    list.scrollTop = activeIndex >= 0 ? target : 0
    updateVirtualRange(list.scrollTop)
  }, [props.activeSessionId, updateVirtualRange, virtualHeight, virtualized])

  const endDrag = useCallback(() => {
    draggedSessionIdRef.current = undefined
    setDraggedSessionId(undefined)
    setDropTarget(undefined)
    dropTargetRef.current = undefined
  }, [])

  const startSessionDrag = useCallback((event: DragEvent<HTMLLIElement>, sessionId: string) => {
    prepareAppHaptics()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', sessionId)
    draggedSessionIdRef.current = sessionId
    setDraggedSessionId(sessionId)
  }, [])

  const dragOverSession = useCallback((event: DragEvent<HTMLLIElement>, targetId: string) => {
    const draggedSessionId = draggedSessionIdRef.current
    if (!draggedSessionId || draggedSessionId === targetId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const bounds = event.currentTarget.getBoundingClientRect()
    const position: DropPosition =
      event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
    const current = dropTargetRef.current
    if (current?.id === targetId && current.position === position) return
    const next = { id: targetId, position }
    dropTargetRef.current = next
    setDropTarget(next)
    performAppHaptic('alignment')
  }, [])

  const dropSession = useCallback(
    (event: DragEvent<HTMLLIElement>, targetId: string) => {
      event.preventDefault()
      const draggedSessionId = draggedSessionIdRef.current
      const target = dropTargetRef.current
      if (draggedSessionId && target?.id === targetId && draggedSessionId !== targetId) {
        props.onReorderSession(props.project.path, draggedSessionId, targetId, target.position)
      }
      endDrag()
    },
    [endDrag, props.onReorderSession, props.project.path],
  )

  return (
    <ul
      ref={virtualSessionList}
      className={`proj__sessions${virtualized ? ' proj__sessions--virtual' : ''}`}
      style={virtualListStyle}
      tabIndex={virtualized ? 0 : undefined}
      aria-label={virtualized ? `${displayName(props.project)} chats` : undefined}
      onScroll={
        virtualized ? (event) => updateVirtualRange(event.currentTarget.scrollTop) : undefined
      }
    >
      {count === 0 ? <li className="rail__hint">No chats</li> : null}
      {visibleSessions.map((session, visibleIndex) => {
        const sessionIndex = visibleStart + visibleIndex
        return (
          <ProjectSessionRow
            key={session.id}
            session={session}
            projectPath={props.project.path}
            active={session.id === props.activeSessionId}
            onSelectSession={props.onSelectSession}
            onRenameSession={props.onRenameSession}
            onDeleteSession={props.onDeleteSession}
            onToggleSessionPin={props.onToggleSessionPin}
            reorderable
            dragging={session.id === draggedSessionId}
            dropPosition={dropTarget?.id === session.id ? dropTarget.position : undefined}
            onDragStart={startSessionDrag}
            onDragOver={dragOverSession}
            onDrop={dropSession}
            onDragEnd={endDrag}
            virtualTop={virtualized ? sessionIndex * VIRTUAL_SESSION_ROW_HEIGHT : undefined}
            virtualPosition={virtualized ? sessionIndex + 1 : undefined}
            virtualSetSize={virtualized ? count : undefined}
          />
        )
      })}
      {count > COLLAPSED_PROJECT_SESSION_COUNT ? (
        <li
          className="proj__sessions-toggle-row"
          style={
            virtualized
              ? { transform: `translateY(${count * VIRTUAL_SESSION_ROW_HEIGHT}px)` }
              : undefined
          }
        >
          <button
            type="button"
            className="proj__sessions-toggle"
            aria-expanded={props.showAll}
            onClick={() => props.onShowAllChange(!props.showAll)}
          >
            {props.showAll ? 'Show less' : 'Show more'}
          </button>
        </li>
      ) : null}
    </ul>
  )
})

const ProjectSessionRow = memo(function ProjectSessionRow(props: {
  session: Session
  projectPath: string
  active: boolean
  onSelectSession: (id: string) => void
  onRenameSession: (id: string, title: string) => void
  onDeleteSession: (id: string) => void
  onToggleSessionPin: ((id: string) => void) | undefined
  reorderable: boolean
  dragging: boolean
  dropPosition: DropPosition | undefined
  onDragStart: (event: DragEvent<HTMLLIElement>, sessionId: string) => void
  onDragOver: (event: DragEvent<HTMLLIElement>, targetId: string) => void
  onDrop: (event: DragEvent<HTMLLIElement>, targetId: string) => void
  onDragEnd: () => void
  virtualTop: number | undefined
  virtualPosition: number | undefined
  virtualSetSize: number | undefined
}) {
  const { session } = props
  return (
    <SessionRow
      session={session}
      active={props.active}
      onSelect={() => props.onSelectSession(session.id)}
      onRename={(title) => props.onRenameSession(session.id, title)}
      onDelete={() => props.onDeleteSession(session.id)}
      onTogglePin={() => props.onToggleSessionPin?.(session.id)}
      onOpenInExplorer={() => void revealPath(props.projectPath)}
      reorderable={props.reorderable}
      dragging={props.dragging}
      dropPosition={props.dropPosition}
      onDragStart={(event) => props.onDragStart(event, session.id)}
      onDragOver={(event) => props.onDragOver(event, session.id)}
      onDrop={(event) => props.onDrop(event, session.id)}
      onDragEnd={props.onDragEnd}
      virtualTop={props.virtualTop}
      virtualPosition={props.virtualPosition}
      virtualSetSize={props.virtualSetSize}
    />
  )
})

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
  virtualTop?: number | undefined
  virtualPosition?: number | undefined
  virtualSetSize?: number | undefined
}) {
  const [renaming, setRenaming] = useState(false)
  const contextMenuTarget = useRef<HTMLButtonElement>(null)

  if (renaming) {
    return (
      <li
        className={`sessrow is-renaming${props.active ? ' is-active' : ''}${props.standalone ? ' is-pinned' : ''}`}
        style={virtualSessionStyle(props.virtualTop)}
        aria-posinset={props.virtualPosition}
        aria-setsize={props.virtualSetSize}
      >
        <InlineRename
          value={props.session.title}
          className="rename--chat rename--session"
          ariaLabel={`Rename ${props.session.title}`}
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
      data-archive-session-id={props.session.id}
      draggable={props.reorderable}
      data-drop-position={props.dropPosition}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onDragEnd={props.onDragEnd}
      style={virtualSessionStyle(props.virtualTop)}
      aria-posinset={props.virtualPosition}
      aria-setsize={props.virtualSetSize}
    >
      <button
        ref={contextMenuTarget}
        className={`sess ${props.active ? 'is-active' : ''}`}
        onClick={props.onSelect}
        onDoubleClick={() => setRenaming(true)}
        aria-label={sessionLabel(props.session)}
        title={sessionLabel(props.session)}
      >
        {props.session.unread ? <span className="sess__unread-dot" aria-hidden /> : null}
        <span className="sess__title">{props.session.title}</span>
        <SourceIdentity
          className="sess__source"
          presentation={sessionSourcePresentation(props.session.provider, props.session.agent)}
          density="compact"
        />
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

      <Menu
        drop="down"
        align="right"
        label={`Options for ${props.session.title}`}
        panelClassName="menu--sidebar"
        contextMenuTargetRef={contextMenuTarget}
        contextMenuOnly
      >
        {(close) => (
          <>
            <MenuItem
              title={props.session.pinned ? 'Unpin chat' : 'Pin chat'}
              icon={
                props.session.pinned ? (
                  <PinOff size={14} aria-hidden />
                ) : (
                  <Pin size={14} aria-hidden />
                )
              }
              onClick={() => {
                props.onTogglePin()
                close()
              }}
            />
            <MenuItem
              title="Rename chat"
              icon={<Pencil size={14} aria-hidden />}
              onClick={() => {
                setRenaming(true)
                close()
              }}
            />
            <MenuItem
              title="Archive chat"
              icon={<Archive size={14} aria-hidden />}
              onClick={() => {
                props.onDelete()
                close()
              }}
            />
            {isDesktop ? (
              <MenuItem
                title="Open in Explorer"
                icon={<FolderOpen size={14} aria-hidden />}
                onClick={() => {
                  props.onOpenInExplorer()
                  close()
                }}
              />
            ) : null}
          </>
        )}
      </Menu>
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
  const dialog = useDialogFocus<HTMLDivElement>(props.onClose)

  return createPortal(
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-label={props.title}
      onKeyDown={dialog.onKeyDown}
    >
      <button className="sheet__scrim" onClick={props.onClose} aria-label="Cancel" />
      <div className="sheet__panel sidebar-confirm" ref={dialog.panel} tabIndex={-1}>
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
    </div>,
    document.body,
  )
}

function SessionStatus(props: { status: Session['status'] }) {
  if (props.status === 'starting' || props.status === 'working') {
    return <LoaderCircle className="sess__spinner" size={14} aria-hidden />
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
  const source = sessionSourcePresentation(session.provider, session.agent).label
  const unread = session.unread ? ', unread' : ''
  const branch = session.worktreeBranch ? `, isolated on ${session.worktreeBranch}` : ''
  switch (session.status) {
    case 'starting':
    case 'working':
      return `${session.title}, ${source}, working${unread}${branch}`
    case 'queued':
      return `${session.title}, ${source}, queued${unread}${branch}`
    case 'approval':
      return `${session.title}, ${source}, waiting for approval${unread}${branch}`
    case 'input':
      return `${session.title}, ${source}, needs attention${unread}${branch}`
    case 'failed':
      return `${session.title}, ${source}, failed${unread}${branch}`
    case 'ready':
      return `${session.title}, ${source}, ready${unread}${branch}`
    default:
      return `${session.title}, ${source}${unread}${branch}`
  }
}

function virtualSessionRange(scrollTop: number, count: number) {
  const firstVisible = Math.floor(scrollTop / VIRTUAL_SESSION_ROW_HEIGHT)
  const start = Math.max(0, firstVisible - VIRTUAL_SESSION_OVERSCAN)
  const end = Math.min(
    count,
    firstVisible + VIRTUAL_SESSION_VIEWPORT_ROWS + VIRTUAL_SESSION_OVERSCAN,
  )
  return { start, end }
}

function virtualSessionStyle(top: number | undefined): CSSProperties | undefined {
  return top === undefined ? undefined : { transform: `translateY(${top}px)` }
}

const projectSidebarProjections = new WeakMap<Project, ProjectSidebarProjection>()

function projectSidebarProjection(source: Project): ProjectSidebarProjection {
  const cached = projectSidebarProjections.get(source)
  if (cached) return cached

  const pinnedSessions: PinnedSession[] = []
  const unpinnedSessions: Session[] = []
  for (const session of source.sessions) {
    if (session.pinned) pinnedSessions.push({ projectPath: source.path, session })
    else unpinnedSessions.push(session)
  }
  const sessions = prioritizeSessions(unpinnedSessions, (session) => session)
  const sessionsUnchanged =
    pinnedSessions.length === 0 &&
    sessions.length === source.sessions.length &&
    sessions.every((session, index) => session === source.sessions[index])
  const project = sessionsUnchanged ? source : { ...source, sessions }
  const projection = { project, pinnedSessions }
  projectSidebarProjections.set(source, projection)
  return projection
}

function prioritizeSessions<T>(sessions: T[], getSession: (value: T) => Session): T[] {
  const active: T[] = []
  const unread: T[] = []
  const rest: T[] = []
  for (const value of sessions) {
    const session = getSession(value)
    if (isActiveStatus(session.status)) {
      active.push(value)
    } else if (session.unread) {
      unread.push(value)
    } else {
      rest.push(value)
    }
  }
  const ordered = [...active, ...unread, ...rest]
  return ordered.every((value, index) => value === sessions[index]) ? sessions : ordered
}

function isActiveStatus(status: Session['status']): boolean {
  return (
    status === 'starting' ||
    status === 'working' ||
    status === 'queued' ||
    status === 'approval' ||
    status === 'input'
  )
}

/** Rename in place. Enter commits, Escape reverts, blur commits. */
function InlineRename(props: {
  value: string
  className?: string
  ariaLabel?: string
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
      className={`rename${props.className ? ` ${props.className}` : ''}`}
      value={draft}
      aria-label={props.ariaLabel}
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

function DialogAction(props: { icon: ReactNode; title: string }) {
  return (
    <span className="menu__name">
      <span className="menu__label">
        {props.icon}
        <span>{props.title}</span>
      </span>
    </span>
  )
}

function noop() {}

/**
 * Memoised: the app root re-renders on every streamed frame, and this subtree
 * does not change while an answer arrives. The owner keeps every callback and
 * composite prop stable, so streamed text does not reconcile the session rail.
 */
export const Sidebar = memo(SidebarComponent)
