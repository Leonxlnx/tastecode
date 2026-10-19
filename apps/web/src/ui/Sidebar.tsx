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
import type {
  Account,
  ProviderId,
  ResultOf,
  ThreadInboxStatus,
  ThreadLifecycle,
} from '@harness/contracts'
import {
  IconArchive as Archive,
  IconArrowBackUp as Restore,
  IconChevronDown as ChevronDown,
  IconClock as Clock,
  IconFolder as Folder,
  IconFolders as Folders,
  IconTrash as Trash,
  IconDots as Ellipsis,
  IconFolderOpen as FolderOpen,
  IconFolderPlus as FolderPen,
  IconGitPullRequest as GitPullRequest,
  IconLayoutSidebarLeftCollapse as PanelLeftClose,
  IconLoader2 as LoaderCircle,
  IconMessage as MessageSquare,
  IconPencil as Pencil,
  IconPinned as Pin,
  IconPinnedOff as PinOff,
  IconSearch as Search,
  IconSettings as Settings,
  IconEdit as SquarePen,
  IconUser as UserRound,
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
import {
  providerDisplayName,
  providerMark,
  sessionSourcePresentation,
} from '../provider-presentation.js'
import { avatarSeedName, type ProfileIdentityPreferences } from '../profile-preferences.js'
import {
  chatList,
  moveChat,
  readStoredChatOrder,
  writeStoredChatOrder,
  type ChatEntry,
} from '../sidebar-order.js'
import {
  DEFAULT_KEYBINDINGS,
  isComposingKey,
  isConfirmEnter,
  shortcutAria,
  type Keybindings,
} from '../shortcuts.js'
import { GeneratedAvatar } from './GeneratedAvatar.js'
import { AppUpdateNotice } from './AppUpdateNotice.js'
import { Menu, MenuItem } from './Menu.js'
import type { AccountLimitsState } from './AccountLimits.js'
import type { InboxActions } from './InboxSidebar.js'
import { ProviderIcon } from './ProviderIcon.js'
import { activeIndicatorRef } from './active-indicator.js'
import { compactRelativeTime, readSessionClock, subscribeSessionClock } from './session-clock.js'
import { formatWakeTime, snoozePresets } from './snooze-presets.js'
import '../styles/account-card.css'
import '../styles/sidebar-list.css'
import { InboxRailSkeleton, SidebarListSkeleton } from './SurfaceSkeletons.js'

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

function AccountLimitsLoading(props: { states: AccountLimitsState[] }) {
  const panel = useRef<HTMLElement>(null)
  const visible = props.states.some(({ summary }) =>
    summary?.limitSource
      ? summary.limitSource.status !== 'unavailable'
      : !summary || summary.limits.length > 0,
  )
  useLayoutEffect(() => panel.current?.focus(), [])
  if (!visible) return null
  return (
    <section
      ref={panel}
      className="account-menu__usage"
      aria-label="Plan limits"
      aria-busy
      tabIndex={0}
    >
      <p className="account-menu__usage-note">Checking plan limits…</p>
    </section>
  )
}

const InboxSidebar = lazy(() =>
  import('./InboxSidebar.js').then((module) => ({ default: module.InboxSidebar })),
)

const SidebarConfirmDialog = lazy(() =>
  import('./SidebarConfirmDialog.js').then((module) => ({
    default: module.SidebarConfirmDialog,
  })),
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
  connectionId?: string | undefined
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
/** Matches the account menu's own limit bars, which turn red at the same point. */
const USAGE_LOW_PERCENT = 15
/** A 28px chat row plus the list's 2px row gap. */
const CHAT_ROW_PITCH = 30
/** Past this many active chats only the rows near the viewport mount. */
const VIRTUAL_CHAT_COUNT = 80
const VIRTUAL_CHAT_FIRST_ROWS = 40
const CHAT_ROW_OVERSCAN = 8
const ARCHIVED_PAGE_SIZE = 10
const projectMenuTrigger = () => (
  <span className="dots">
    <Ellipsis size={16} aria-hidden />
  </span>
)

function SidebarComponent(props: {
  projects: Project[]
  projectsLoading?: boolean | undefined
  activeProjectPath: string | undefined
  activeSessionId: string | undefined
  account: Account | undefined
  profileIdentity?: ProfileIdentityPreferences | undefined
  providerName: string
  keybindings?: Keybindings | undefined
  usageStates?: AccountLimitsState[] | undefined
  /** The account popup shows plan limits; returns the release for when it closes. */
  onShowUsage?: (() => () => void) | undefined
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
  /** Present only when this build can send feedback. */
  onSendFeedback?: (() => void) | undefined
}) {
  const keybindings = props.keybindings ?? DEFAULT_KEYBINDINGS
  const profileDisplayName = props.profileIdentity?.displayName.trim() || 'Local profile'
  const usageLimit = useMemo(() => tightestUsageLimit(props.usageStates), [props.usageStates])
  const usageRemaining = usageLimit
    ? Math.round(Math.min(100, Math.max(0, 100 - usageLimit.usedPercent)))
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

  // One flat list. A status push replaces one project in an otherwise retained
  // array and the rows are memoised by session, so only the chat that changed
  // re-renders, and nothing moves because its status did.
  const [chatOrder, setChatOrder] = useState(readStoredChatOrder)
  const chatOrderRef = useRef(chatOrder)
  chatOrderRef.current = chatOrder
  const chats = useMemo(
    () => chatList(props.projects, chatOrder, scope),
    [props.projects, chatOrder, scope],
  )
  const projectNames = useMemo(
    () => new Map(props.projects.map((project) => [project.path, displayName(project)])),
    [props.projects],
  )
  const waitingProjects = useMemo(() => {
    const paths = new Set<string>()
    for (const project of props.projects) {
      if (project.sessions.some(needsYou)) paths.add(project.path)
    }
    return paths
  }, [props.projects])
  const scopeProject = scope ? props.projects.find((project) => project.path === scope) : undefined
  // A project name in front of every title only helps while the list mixes projects.
  const rowProjectNames = props.projects.length > 1 ? projectNames : undefined
  const bodyRef = useRef<HTMLDivElement>(null)
  const [folderDropActive, setFolderDropActive] = useState(false)
  const folderDragDepth = useRef(0)

  const [draggedChatId, setDraggedChatId] = useState<string>()
  const [chatDropTarget, setChatDropTarget] = useState<ChatDropTarget>()
  const draggedChatIdRef = useRef<string | undefined>(undefined)
  const chatDropTargetRef = useRef<ChatDropTarget | undefined>(undefined)

  const endChatDrag = useCallback(() => {
    draggedChatIdRef.current = undefined
    chatDropTargetRef.current = undefined
    setDraggedChatId(undefined)
    setChatDropTarget(undefined)
  }, [])

  const startChatDrag = useCallback((event: DragEvent<HTMLLIElement>, id: string) => {
    prepareAppHaptics()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
    draggedChatIdRef.current = id
    setDraggedChatId(id)
  }, [])

  const dragOverChat = useCallback((event: DragEvent<HTMLLIElement>, targetId: string) => {
    const dragged = draggedChatIdRef.current
    if (!dragged || dragged === targetId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const bounds = event.currentTarget.getBoundingClientRect()
    const position: DropPosition =
      event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
    const current = chatDropTargetRef.current
    if (current?.id === targetId && current.position === position) return
    const next = { id: targetId, position }
    chatDropTargetRef.current = next
    setChatDropTarget(next)
    performAppHaptic('alignment')
  }, [])

  const dropChat = useCallback(
    (event: DragEvent<HTMLLIElement>, targetId: string) => {
      event.preventDefault()
      const dragged = draggedChatIdRef.current
      const target = chatDropTargetRef.current
      if (dragged && target?.id === targetId) {
        // Resolved against the whole list, so a drop while one project is
        // shown keeps every other project's chats where they were.
        const shown = chatList(actionsRef.current.projects, chatOrderRef.current, '').active.map(
          (entry) => entry.session.id,
        )
        const next = moveChat(shown, dragged, targetId, target.position)
        setChatOrder(next)
        writeStoredChatOrder(next)
      }
      endChatDrag()
    },
    [endChatDrag],
  )

  const archiveChat = useCallback(
    (id: string) =>
      animateArchive([id], (ids) => {
        for (const sessionId of ids) actionsRef.current.inbox?.onSettle(sessionId)
      }),
    [animateArchive],
  )
  const snoozeChat = useCallback(
    (id: string, wakeAt: number) => actionsRef.current.inbox?.onSnooze(id, wakeAt),
    [],
  )
  const restoreChat = useCallback((session: Session) => {
    const lifecycle = actionsRef.current.inbox
    if (session.lifecycle.state === 'snoozed') lifecycle?.onUnsnooze(session.id)
    else lifecycle?.onUnsettle(session.id)
  }, [])
  const revealProject = useCallback((path: string) => void revealPath(path), [])
  const lifecycleActions = props.inbox !== undefined
  const pinActions = props.onToggleSessionPin !== undefined
  const rowActions = useMemo<ChatRowActions>(
    () => ({
      onSelect: selectSession,
      onRename: renameSession,
      onDelete: deleteSession,
      onTogglePin: pinActions ? toggleSessionPin : undefined,
      onArchive: lifecycleActions ? archiveChat : undefined,
      onSnooze: lifecycleActions ? snoozeChat : undefined,
      onRestore: lifecycleActions ? restoreChat : undefined,
      onOpenInExplorer: revealProject,
    }),
    [
      archiveChat,
      deleteSession,
      lifecycleActions,
      pinActions,
      renameSession,
      restoreChat,
      revealProject,
      selectSession,
      snoozeChat,
      toggleSessionPin,
    ],
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
          <Suspense
            fallback={<InboxRailSkeleton pullRequests={Boolean(props.onOpenPullRequests)} />}
          >
            <InboxSidebar
              projects={props.projects}
              loading={props.projectsLoading}
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
                      scopeProject ??
                      props.projects.find(
                        (candidate) => candidate.path === props.activeProjectPath,
                      ) ??
                      props.projects[0]
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
              ref={bodyRef}
              className="rail__body"
              onScroll={(event) => setBodyScrolled(event.currentTarget.scrollTop > 0)}
            >
              {chats.pinned.length > 0 ? (
                <>
                  <p className="section">Pinned</p>
                  <ul className="chatlist chatlist--pinned">
                    {chats.pinned.map(({ projectPath, session }) => (
                      <ChatRow
                        key={session.id}
                        session={session}
                        projectPath={projectPath}
                        projectName={rowProjectNames?.get(projectPath)}
                        active={session.id === props.activeSessionId}
                        place="pinned"
                        {...rowActions}
                      />
                    ))}
                  </ul>
                </>
              ) : null}
              {props.projects.length === 0 ? (
                props.projectsLoading ? (
                  <SidebarListSkeleton />
                ) : (
                  <p className="rail__hint">Nothing here yet.</p>
                )
              ) : (
                <>
                  <ChatFilter
                    projects={chats.projects}
                    scope={scope}
                    scopeProject={scopeProject}
                    waitingProjects={waitingProjects}
                    onScopeChange={setScope}
                    onRenameProject={renameProject}
                    onRemoveProject={removeProject}
                    onTogglePin={toggleProjectPin}
                    onArchiveProject={archiveProject}
                  />
                  <ChatRows
                    entries={chats.active}
                    bodyRef={bodyRef}
                    activeSessionId={props.activeSessionId}
                    projectNames={scope ? undefined : rowProjectNames}
                    draggedChatId={draggedChatId}
                    dropTarget={chatDropTarget}
                    onDragStart={startChatDrag}
                    onDragOver={dragOverChat}
                    onDrop={dropChat}
                    onDragEnd={endChatDrag}
                    actions={rowActions}
                  />
                  {chats.archived.length > 0 ? (
                    <ArchivedChats
                      entries={chats.archived}
                      activeSessionId={props.activeSessionId}
                      projectNames={scope ? undefined : rowProjectNames}
                      actions={rowActions}
                    />
                  ) : null}
                </>
              )}
            </div>
          </>
        )}

        <div className="rail__foot">
          <div className="account-card">
            <Menu
              drop="up"
              gap={8}
              label="Account"
              triggerClassName="account-card__trigger"
              panelClassName="menu--compact menu--settings menu--account"
              panelRole="dialog"
              panelLabel="Account and plan limits"
              trigger={() => (
                <span className="account">
                  <span className="account__avatar">
                    {props.profileIdentity?.avatarDataUrl ? (
                      <img src={props.profileIdentity.avatarDataUrl} alt="" />
                    ) : (
                      <GeneratedAvatar name={avatarSeedName(props.profileIdentity)} />
                    )}
                  </span>
                  <span className="account__identity">
                    <span className="account__name">{profileDisplayName}</span>
                    {usageLimit && usageRemaining !== undefined ? (
                      <span
                        className="account__usage"
                        title={[
                          providerDisplayName(usageLimit.provider),
                          usageLimit.label,
                          `${usageRemaining}% left`,
                          ...(usageLimit.unknown.length > 0
                            ? [unknownLimitsLabel(usageLimit.unknown)]
                            : []),
                        ].join(' · ')}
                      >
                        <ProviderIcon
                          className="account__usage-mark"
                          mark={providerMark(usageLimit.provider)}
                          size={12}
                        />
                        <span
                          className="account__meter"
                          data-low={usageRemaining <= USAGE_LOW_PERCENT ? '' : undefined}
                          aria-hidden
                        >
                          <span style={{ transform: `scaleX(${usageRemaining / 100})` }} />
                        </span>
                        <span className="account__usage-value">{usageRemaining}% left</span>
                        {usageLimit.unknown.length > 0 ? (
                          <span className="account__usage-unknown" aria-hidden />
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                </span>
              )}
            >
              {(close) => {
                const RenderedAccountLimits = resolvedAccountLimits ?? AccountLimits
                return (
                  <>
                    {props.usageStates ? (
                      <Suspense fallback={<AccountLimitsLoading states={props.usageStates} />}>
                        <RenderedAccountLimits
                          states={props.usageStates}
                          onShow={props.onShowUsage}
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
                        <DialogAction
                          icon={<UserRound size={14} aria-hidden />}
                          title="Edit profile"
                        />
                      </button>
                      {props.onSendFeedback ? (
                        <button
                          type="button"
                          className="menu__item"
                          onClick={() => {
                            props.onSendFeedback?.()
                            closeOnNarrowViewport()
                            close()
                          }}
                        >
                          <DialogAction
                            icon={<MessageSquare size={14} aria-hidden />}
                            title="Send feedback"
                          />
                        </button>
                      ) : null}
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
            <button
              type="button"
              className="account-card__settings"
              aria-label="Settings"
              title="Settings"
              aria-keyshortcuts={shortcutAria(keybindings.settings)}
              onClick={() => {
                props.onOpenSettings()
                closeOnNarrowViewport()
              }}
            >
              <Settings size={15} aria-hidden />
            </button>
          </div>
          {isDesktop ? <AppUpdateNotice /> : null}
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

type ChatDropTarget = { id: string; position: DropPosition }
type ChatPlace = 'pinned' | 'active' | 'archived'
type ChatRowActions = {
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onTogglePin: ((id: string) => void) | undefined
  onArchive: ((id: string) => void) | undefined
  onSnooze: ((id: string, wakeAt: number) => void) | undefined
  onRestore: ((session: Session) => void) | undefined
  onOpenInExplorer: (path: string) => void
}

/** A chat blocked on the user, or a failure nobody has looked at yet. */
function needsYou(session: Session): boolean {
  return (
    session.status === 'approval' ||
    session.status === 'input' ||
    (session.status === 'failed' && session.unread)
  )
}

function isLive(status: Session['status']): boolean {
  return (
    status === 'starting' ||
    status === 'working' ||
    status === 'queued' ||
    status === 'approval' ||
    status === 'input'
  )
}

/**
 * The list's one control: which project's chats it shows. With one project
 * chosen, that project's own options sit beside it, so a project can still be
 * renamed, pinned, opened or removed without a project tree.
 */
function ChatFilter(props: {
  projects: Project[]
  scope: string
  scopeProject: Project | undefined
  waitingProjects: ReadonlySet<string>
  onScopeChange: (path: string) => void
  onRenameProject: (path: string, name: string) => void
  onRemoveProject: (path: string) => void
  onTogglePin: (path: string) => void
  onArchiveProject: (sessionIds: string[]) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState<'archive' | 'remove'>()
  const project = props.scopeProject
  // A filter must not hide that another project needs the user.
  let waitingElsewhere = false
  if (project) {
    for (const path of props.waitingProjects) {
      if (path !== project.path) waitingElsewhere = true
    }
  }

  return (
    <div className="chatfilter">
      {renaming && project ? (
        <InlineRename
          value={displayName(project)}
          ariaLabel={`Rename ${displayName(project)}`}
          onCommit={(name) => {
            props.onRenameProject(project.path, name)
            setRenaming(false)
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <Menu
          drop="down"
          label="Show chats from"
          panelClassName="menu--sidebar menu--chatfilter"
          triggerClassName="chatfilter__trigger"
          trigger={() => (
            <>
              <span className="chatfilter__label" title={project?.path}>
                {project ? displayName(project) : 'All projects'}
              </span>
              {waitingElsewhere ? (
                <span
                  className="sess__status-dot is-attention"
                  title="A chat in another project needs you"
                />
              ) : null}
              <ChevronDown size={12} aria-hidden />
            </>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                title="All projects"
                icon={<Folders size={14} aria-hidden />}
                active={props.scope === ''}
                checked={props.scope === ''}
                onClick={() => {
                  props.onScopeChange('')
                  close()
                }}
              />
              {props.projects.map((candidate) => (
                <MenuItem
                  key={candidate.path}
                  title={displayName(candidate)}
                  icon={
                    props.waitingProjects.has(candidate.path) ? (
                      <span className="chatfilter__waiting" aria-hidden>
                        <span className="sess__status-dot is-attention" />
                      </span>
                    ) : (
                      <Folder size={14} aria-hidden />
                    )
                  }
                  active={props.scope === candidate.path}
                  checked={props.scope === candidate.path}
                  onClick={() => {
                    props.onScopeChange(candidate.path)
                    close()
                  }}
                />
              ))}
            </>
          )}
        </Menu>
      )}

      {project && !renaming ? (
        <Menu
          drop="down"
          align="right"
          label="Project options"
          panelClassName="menu--sidebar"
          trigger={projectMenuTrigger}
        >
          {(close) => (
            <>
              <MenuItem
                title={project.pinned ? 'Unpin' : 'Pin to top'}
                icon={
                  project.pinned ? <PinOff size={14} aria-hidden /> : <Pin size={14} aria-hidden />
                }
                onClick={() => {
                  props.onTogglePin(project.path)
                  close()
                }}
              />
              {isDesktop ? (
                <MenuItem
                  title="Open in Explorer"
                  icon={<FolderOpen size={14} aria-hidden />}
                  onClick={() => {
                    void revealPath(project.path)
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
                title="Delete chats"
                icon={<Trash size={14} aria-hidden />}
                className="menu__item--danger"
                onClick={() => {
                  setConfirming('archive')
                  close()
                }}
              />
              <MenuItem
                title="Remove from sidebar"
                icon={<PanelLeftClose size={14} aria-hidden />}
                onClick={() => {
                  setConfirming('remove')
                  close()
                }}
              />
            </>
          )}
        </Menu>
      ) : null}

      {confirming && project ? (
        <Suspense fallback={null}>
          <SidebarConfirmDialog
            {...(confirming === 'archive' ? deleteChatsCopy(project) : removeProjectCopy(project))}
            path={project.path}
            onConfirm={() => {
              if (confirming === 'archive') {
                props.onArchiveProject(project.sessions.map((session) => session.id))
              } else {
                props.onRemoveProject(project.path)
              }
              setConfirming(undefined)
            }}
            onClose={() => setConfirming(undefined)}
          />
        </Suspense>
      ) : null}
    </div>
  )
}

/**
 * The active chats. Up to VIRTUAL_CHAT_COUNT rows render as a plain list; past
 * that only the rows near the rail's viewport mount, positioned on a fixed
 * pitch inside a list as tall as all of them, so the rail scrolls once and a
 * thousand chats cost what forty do.
 */
function ChatRows(props: {
  entries: ChatEntry[]
  bodyRef: RefObject<HTMLDivElement | null>
  activeSessionId: string | undefined
  projectNames: ReadonlyMap<string, string> | undefined
  draggedChatId: string | undefined
  dropTarget: ChatDropTarget | undefined
  onDragStart: (event: DragEvent<HTMLLIElement>, id: string) => void
  onDragOver: (event: DragEvent<HTMLLIElement>, targetId: string) => void
  onDrop: (event: DragEvent<HTMLLIElement>, targetId: string) => void
  onDragEnd: () => void
  actions: ChatRowActions
}) {
  const list = useRef<HTMLUListElement>(null)
  const count = props.entries.length
  const virtual = count > VIRTUAL_CHAT_COUNT
  const [range, setRange] = useState({ start: 0, end: VIRTUAL_CHAT_FIRST_ROWS })
  const rangeRef = useRef(range)

  const listTop = useCallback((body: HTMLElement, ul: HTMLElement) => {
    return ul.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop
  }, [])

  const measure = useCallback(() => {
    const body = props.bodyRef.current
    const ul = list.current
    if (!body || !ul) return
    const top = body.scrollTop - listTop(body, ul)
    const start = Math.max(0, Math.floor(top / CHAT_ROW_PITCH) - CHAT_ROW_OVERSCAN)
    const end = Math.max(
      start,
      Math.min(count, Math.ceil((top + body.clientHeight) / CHAT_ROW_PITCH) + CHAT_ROW_OVERSCAN),
    )
    const current = rangeRef.current
    if (current.start === start && current.end === end) return
    rangeRef.current = { start, end }
    setRange({ start, end })
  }, [count, listTop, props.bodyRef])

  useLayoutEffect(() => {
    const body = props.bodyRef.current
    if (!virtual || !body) return
    measure()
    let frame = 0
    const schedule = () => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    body.addEventListener('scroll', schedule, { passive: true })
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : undefined
    resize?.observe(body)
    return () => {
      body.removeEventListener('scroll', schedule)
      resize?.disconnect()
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [measure, props.bodyRef, virtual])

  // Opening a chat that is far down the list (search, a shortcut, a restore
  // on launch) brings its row into view once; scrolling stays the user's.
  const shownActive = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    if (!virtual || shownActive.current === props.activeSessionId) return
    shownActive.current = props.activeSessionId
    const body = props.bodyRef.current
    const ul = list.current
    const index = props.activeSessionId
      ? props.entries.findIndex((entry) => entry.session.id === props.activeSessionId)
      : -1
    if (!body || !ul || index < 0) return
    const rowTop = listTop(body, ul) + index * CHAT_ROW_PITCH
    if (rowTop >= body.scrollTop && rowTop + CHAT_ROW_PITCH <= body.scrollTop + body.clientHeight) {
      return
    }
    body.scrollTop = Math.max(0, rowTop - body.clientHeight / 2)
    measure()
  }, [listTop, measure, props.activeSessionId, props.bodyRef, props.entries, virtual])

  if (count === 0) return <p className="rail__hint chatlist__empty">No chats</p>

  const start = virtual ? Math.min(range.start, count) : 0
  const visible = virtual ? props.entries.slice(start, Math.min(range.end, count)) : props.entries
  return (
    <ul
      ref={list}
      className={`chatlist${virtual ? ' chatlist--virtual' : ''}`}
      style={virtual ? { height: count * CHAT_ROW_PITCH } : undefined}
      aria-label="Chats"
    >
      {visible.map(({ projectPath, session }, offset) => {
        const index = start + offset
        return (
          <ChatRow
            key={session.id}
            session={session}
            projectPath={projectPath}
            projectName={props.projectNames?.get(projectPath)}
            active={session.id === props.activeSessionId}
            place="active"
            reorderable
            dragging={session.id === props.draggedChatId}
            dropPosition={
              props.dropTarget?.id === session.id ? props.dropTarget.position : undefined
            }
            onDragStart={props.onDragStart}
            onDragOver={props.onDragOver}
            onDrop={props.onDrop}
            onDragEnd={props.onDragEnd}
            virtualTop={virtual ? index * CHAT_ROW_PITCH : undefined}
            virtualPosition={virtual ? index + 1 : undefined}
            virtualSetSize={virtual ? count : undefined}
            {...props.actions}
          />
        )
      })}
    </ul>
  )
}

/** Archived and snoozed chats, folded at the end with a count, ten at a time. */
function ArchivedChats(props: {
  entries: ChatEntry[]
  activeSessionId: string | undefined
  projectNames: ReadonlyMap<string, string> | undefined
  actions: ChatRowActions
}) {
  const [open, setOpen] = useState(false)
  const [limit, setLimit] = useState(ARCHIVED_PAGE_SIZE)
  // An archived chat that is open stays reachable in the list.
  const holdsActive =
    props.activeSessionId !== undefined &&
    props.entries.some((entry) => entry.session.id === props.activeSessionId)
  const expanded = open || holdsActive
  return (
    <div className="archived">
      <button
        type="button"
        className="section archived__toggle"
        aria-expanded={expanded}
        onClick={() => {
          setOpen(!expanded)
          setLimit(ARCHIVED_PAGE_SIZE)
        }}
      >
        <span>Archived</span>
        <span className="archived__count">{props.entries.length}</span>
      </button>
      {expanded ? (
        <ul className="chatlist" aria-label="Archived chats">
          {props.entries.slice(0, limit).map(({ projectPath, session }) => (
            <ChatRow
              key={session.id}
              session={session}
              projectPath={projectPath}
              projectName={props.projectNames?.get(projectPath)}
              active={session.id === props.activeSessionId}
              place="archived"
              {...props.actions}
            />
          ))}
          {props.entries.length > limit ? (
            <li className="proj__sessions-toggle-row">
              <button
                type="button"
                className="proj__sessions-toggle"
                onClick={() => setLimit((current) => current + ARCHIVED_PAGE_SIZE)}
              >
                Show more
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * One chat on one line: its state, or its provider while nothing is going on;
 * the project's name while the list mixes projects; the title; the time. The
 * state sits at the start of the row, so the hover actions that take the
 * time's place can never cover it.
 */
const ChatRow = memo(function ChatRow(
  props: ChatRowActions & {
    session: Session
    projectPath: string
    projectName: string | undefined
    active: boolean
    place: ChatPlace
    reorderable?: boolean
    dragging?: boolean
    dropPosition?: DropPosition | undefined
    onDragStart?: (event: DragEvent<HTMLLIElement>, id: string) => void
    onDragOver?: (event: DragEvent<HTMLLIElement>, targetId: string) => void
    onDrop?: (event: DragEvent<HTMLLIElement>, targetId: string) => void
    onDragEnd?: () => void
    virtualTop?: number | undefined
    virtualPosition?: number | undefined
    virtualSetSize?: number | undefined
  },
) {
  const { session } = props
  const [renaming, setRenaming] = useState(false)
  const contextMenuTarget = useRef<HTMLButtonElement>(null)
  const finishRename = useRenameFocusReturn(renaming, setRenaming, contextMenuTarget)
  const archived = props.place === 'archived'
  const lifecycle = session.lifecycle
  const canArchive = !archived && !isLive(session.status) && props.onArchive !== undefined
  const canRestore = archived && props.onRestore !== undefined
  const label = [
    sessionLabel(session),
    ...(props.projectName ? [`in ${props.projectName}`] : []),
    ...(lifecycle.state === 'snoozed'
      ? [`snoozed until ${formatWakeTime(lifecycle.wakeAt, Date.now())}`]
      : lifecycle.state === 'settled'
        ? ['archived']
        : []),
  ].join(', ')
  const className = [
    'sessrow',
    props.active ? 'is-active' : '',
    props.place === 'pinned' ? 'is-pinned' : '',
    props.reorderable ? 'is-reorderable' : '',
    props.dragging ? 'is-dragging' : '',
    session.unread ? 'is-unread' : '',
    canArchive || canRestore ? 'has-actions' : '',
  ]
    .filter(Boolean)
    .join(' ')

  if (renaming) {
    return (
      <li
        className={`sessrow is-renaming${props.active ? ' is-active' : ''}`}
        style={virtualSessionStyle(props.virtualTop)}
        aria-posinset={props.virtualPosition}
        aria-setsize={props.virtualSetSize}
      >
        {props.active ? <ActiveIndicator /> : null}
        <InlineRename
          value={session.title}
          className="rename--chat rename--session"
          ariaLabel={`Rename ${session.title}`}
          onCommit={(title, fromKeyboard) => {
            props.onRename(session.id, title)
            finishRename(fromKeyboard)
          }}
          onCancel={finishRename}
        />
      </li>
    )
  }

  return (
    <li
      className={className}
      data-archive-session-id={session.id}
      draggable={props.reorderable}
      data-drop-position={props.dropPosition}
      onDragStart={
        props.onDragStart ? (event) => props.onDragStart?.(event, session.id) : undefined
      }
      onDragOver={props.onDragOver ? (event) => props.onDragOver?.(event, session.id) : undefined}
      onDrop={props.onDrop ? (event) => props.onDrop?.(event, session.id) : undefined}
      onDragEnd={props.onDragEnd}
      style={virtualSessionStyle(props.virtualTop)}
      aria-posinset={props.virtualPosition}
      aria-setsize={props.virtualSetSize}
    >
      {props.active ? <ActiveIndicator /> : null}
      <button
        ref={contextMenuTarget}
        className={`sess${props.active ? ' is-active' : ''}`}
        onClick={() => props.onSelect(session.id)}
        onDoubleClick={() => setRenaming(true)}
        aria-label={label}
        title={label}
      >
        <span className="sess__provider" aria-hidden>
          <ChatMark session={session} />
        </span>
        {props.projectName ? <span className="sess__project">{props.projectName}</span> : null}
        <span className="sess__title">{session.title}</span>
        <span className="sess__meta">
          {lifecycle.state === 'snoozed' ? (
            <Clock size={12} className="sess__snoozed" aria-hidden />
          ) : (
            <SessionTime at={session.statusSince ?? session.createdAt} />
          )}
        </span>
      </button>

      {canArchive ? (
        <span className="sess__actions">
          {props.onSnooze ? (
            <SnoozeAction
              title={session.title}
              onSnooze={(wakeAt) => props.onSnooze?.(session.id, wakeAt)}
            />
          ) : null}
          <button
            type="button"
            className="sess__action"
            onClick={() => props.onArchive?.(session.id)}
            aria-label={`Archive ${session.title}`}
            title="Archive chat"
          >
            <Archive size={14} aria-hidden />
          </button>
        </span>
      ) : canRestore ? (
        <span className="sess__actions">
          <button
            type="button"
            className="sess__action"
            onClick={() => props.onRestore?.(session)}
            aria-label={`Restore ${session.title}`}
            title="Restore chat"
          >
            <Restore size={14} aria-hidden />
          </button>
        </span>
      ) : null}

      <Menu
        drop="down"
        align="right"
        label={`Options for ${session.title}`}
        panelClassName="menu--sidebar"
        contextMenuTargetRef={contextMenuTarget}
        contextMenuOnly
      >
        {(close) => (
          <>
            {props.onTogglePin ? (
              <MenuItem
                title={session.pinned ? 'Unpin chat' : 'Pin chat'}
                icon={
                  session.pinned ? <PinOff size={14} aria-hidden /> : <Pin size={14} aria-hidden />
                }
                onClick={() => {
                  props.onTogglePin?.(session.id)
                  close()
                }}
              />
            ) : null}
            <MenuItem
              title="Rename chat"
              icon={<Pencil size={14} aria-hidden />}
              onClick={() => {
                setRenaming(true)
                close()
              }}
            />
            {canArchive ? (
              <MenuItem
                title="Archive chat"
                icon={<Archive size={14} aria-hidden />}
                onClick={() => {
                  props.onArchive?.(session.id)
                  close()
                }}
              />
            ) : null}
            {canRestore ? (
              <MenuItem
                title="Restore chat"
                icon={<Restore size={14} aria-hidden />}
                onClick={() => {
                  props.onRestore?.(session)
                  close()
                }}
              />
            ) : null}
            {isDesktop ? (
              <MenuItem
                title="Open in Explorer"
                icon={<FolderOpen size={14} aria-hidden />}
                onClick={() => {
                  props.onOpenInExplorer(props.projectPath)
                  close()
                }}
              />
            ) : null}
            <MenuItem
              title="Delete chat"
              icon={<Trash size={14} aria-hidden />}
              className="menu__item--danger"
              onClick={() => {
                props.onDelete(session.id)
                close()
              }}
            />
          </>
        )}
      </Menu>
    </li>
  )
})

function SnoozeAction(props: { title: string; onSnooze: (wakeAt: number) => void }) {
  return (
    <Menu
      drop="down"
      align="right"
      label={`Snooze ${props.title}`}
      panelClassName="menu--sidebar"
      triggerClassName="sess__action"
      trigger={() => <Clock size={14} aria-hidden />}
    >
      {(close) => (
        <>
          {snoozePresets(Date.now()).map((preset) => (
            <MenuItem
              key={preset.label}
              title={preset.label}
              icon={<Clock size={14} aria-hidden />}
              onClick={() => {
                props.onSnooze(preset.at)
                close()
              }}
            />
          ))}
        </>
      )}
    </Menu>
  )
}

type ConfirmCopy = { title: string; body: string; action: string; destructive: boolean }

function chatCount(count: number): string {
  return `${count} chat${count === 1 ? '' : 's'}`
}

/** Removing only forgets the sidebar entry, so it is not styled as destructive.
 *  It does stop live turns, which is the one consequence worth naming. */
function removeProjectCopy(project: Project): ConfirmCopy {
  const chats = project.sessions.length
  const live = project.sessions.filter((session) =>
    ['starting', 'working', 'queued', 'approval', 'input'].includes(session.status),
  ).length
  const kept =
    chats === 0
      ? 'The folder stays where it is.'
      : `The folder and its ${chatCount(chats)} stay where they are. Add the folder again to bring them back.`
  return {
    title: `Remove ${displayName(project)} from the sidebar?`,
    body:
      live === 0
        ? kept
        : `${kept} ${live === 1 ? 'The running chat' : `${live} running chats`} will stop.`,
    action: 'Remove',
    destructive: false,
  }
}

function deleteChatsCopy(project: Project): ConfirmCopy {
  const chats = project.sessions.length
  return {
    title:
      chats === 0
        ? `Delete all chats in ${displayName(project)}?`
        : `Delete ${chatCount(chats)} in ${displayName(project)}?`,
    body: 'Their restore points go with them once the Undo window closes. Files in the folder stay untouched.',
    action: chats === 0 ? 'Delete chats' : `Delete ${chatCount(chats)}`,
    destructive: true,
  }
}

/** The one active-chat pill. Only the active row renders it, and it slides in
 *  from wherever the previous active row's pill stood. */
function ActiveIndicator() {
  return <span className="sessrow__indicator" ref={activeIndicatorRef} aria-hidden />
}

/** The row's mark: the live state while there is one, else the provider. A
 *  chat that works or waits says so where every row starts, so the state
 *  never competes with the time or the hover actions for one slot. */
function ChatMark(props: { session: Session }) {
  const { status } = props.session
  if (status === 'starting' || status === 'working') {
    // The rotation sits on an HTML box, which the compositor can turn on its
    // own; a rotating <svg> is repainted on the main thread every frame.
    return (
      <span className="sess__spinner">
        <LoaderCircle size={14} />
      </span>
    )
  }
  if (status === 'approval' || status === 'input' || status === 'queued') {
    return <span className="sess__status-dot is-attention" />
  }
  if (status === 'failed') return <span className="sess__status-dot is-failed" />
  return (
    <ProviderIcon
      mark={sessionSourcePresentation(props.session.provider, props.session.agent).mark}
      size={12}
    />
  )
}

function SessionTime(props: { at: number }) {
  const now = useSyncExternalStore(subscribeSessionClock, readSessionClock, readSessionClock)
  if (!(props.at > 0)) return null
  return (
    <span className="sess__time" aria-hidden>
      {compactRelativeTime(props.at, now)}
    </span>
  )
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

function virtualSessionStyle(top: number | undefined): CSSProperties | undefined {
  return top === undefined ? undefined : { transform: `translateY(${top}px)` }
}

/** Rename in place. Enter commits, Escape reverts, blur commits. */
/**
 * Ends an inline rename. The input replaced the row's button, so a rename
 * finished with Enter or Escape would leave focus on the document body; put it
 * back on the row. A rename that ends on blur leaves focus where the user went.
 */
function useRenameFocusReturn(
  renaming: boolean,
  setRenaming: (renaming: boolean) => void,
  row: RefObject<HTMLButtonElement | null>,
) {
  const returnFocus = useRef(false)
  useEffect(() => {
    if (renaming || !returnFocus.current) return
    returnFocus.current = false
    row.current?.focus()
  }, [renaming, row])
  return useCallback(
    (fromKeyboard: boolean) => {
      returnFocus.current = fromKeyboard
      setRenaming(false)
    },
    [setRenaming],
  )
}

function InlineRename(props: {
  value: string
  className?: string
  ariaLabel?: string
  onCommit: (value: string, fromKeyboard: boolean) => void
  onCancel: (fromKeyboard: boolean) => void
}) {
  const [draft, setDraft] = useState(props.value)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.select()
  }, [])

  const commit = (fromKeyboard: boolean) => {
    const trimmed = draft.trim()
    if (trimmed === '') props.onCancel(fromKeyboard)
    else props.onCommit(trimmed, fromKeyboard)
  }

  return (
    <input
      ref={input}
      className={`rename${props.className ? ` ${props.className}` : ''}`}
      value={draft}
      aria-label={props.ariaLabel}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commit(false)}
      onKeyDown={(e) => {
        if (isComposingKey(e)) return
        // Without preventDefault the Enter keypress that follows lands on the
        // row button focus just returned to, and clicks it.
        if (isConfirmEnter(e)) {
          e.preventDefault()
          commit(true)
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          props.onCancel(true)
        }
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

type CardUsageLimit = {
  provider: ProviderId
  label: string
  usedPercent: number
  /** Providers whose limits could not be read; any of them could be tighter. */
  unknown: ProviderId[]
}

/**
 * The card's one usage figure: the tightest percentage limit any provider
 * reports, shown with that provider's mark so it says what it measures. A
 * provider whose limits are unknown could be the tighter one, so the figure
 * then carries a muted marker that names it instead of disappearing.
 */
function tightestUsageLimit(
  states: readonly AccountLimitsState[] | undefined,
): CardUsageLimit | undefined {
  let tightest: Omit<CardUsageLimit, 'unknown'> | undefined
  const unknown: ProviderId[] = []
  for (const state of states ?? []) {
    if (limitsUnknown(state)) {
      unknown.push(state.provider)
      continue
    }
    const source = state.summary?.limitSource
    const limits = source
      ? source.status === 'ready'
        ? source.limits
        : []
      : (state.summary?.limits ?? [])
    for (const limit of limits) {
      if (limit.valueLabel !== undefined || !Number.isFinite(limit.usedPercent)) continue
      if (tightest && limit.usedPercent <= tightest.usedPercent) continue
      tightest = { provider: state.provider, label: limit.label, usedPercent: limit.usedPercent }
    }
  }
  return tightest ? { ...tightest, unknown } : undefined
}

/**
 * A read that failed with nothing on record, or a source not read yet. A
 * first read still running is not counted, so the marker does not flash.
 */
function limitsUnknown(state: AccountLimitsState): boolean {
  if (state.status === 'error' && !state.summary) return true
  const source = state.summary?.limitSource
  return source?.status === 'unavailable' && source.reason === 'failed'
}

function unknownLimitsLabel(providers: readonly ProviderId[]): string {
  const names = providers.map(providerDisplayName)
  const listed =
    names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '')
  return `${listed} limits unknown`
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
