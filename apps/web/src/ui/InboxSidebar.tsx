import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import '../styles/inbox-sidebar.css'
import {
  IconBell as Bell,
  IconChecks as CheckCheck,
  IconChevronRight as ChevronRight,
  IconClock as Clock3,
  IconCopy as Copy,
  IconDots as Ellipsis,
  IconFolderPlus as FolderPlus,
  IconGitBranch as GitBranch,
  IconGitPullRequest as GitPullRequest,
  IconPencil as Pencil,
  IconPinned as Pin,
  IconPinnedOff as PinOff,
  IconSearch as Search,
  IconEdit as SquarePen,
  IconFilter2 as Filter,
  IconFolder as Folder,
  IconPhoto as Photo,
  IconPhotoOff as PhotoOff,
  IconPhotoPlus as PhotoPlus,
  IconTrash as Trash2,
  IconX as X,
} from '@tabler/icons-react'
import { writeClipboardText } from '../bridge.js'
import { sessionSourcePresentation } from '../provider-presentation.js'
import { findSession, takeProjectSessionChanges } from '../project-store.js'
import {
  classifyInboxEntries,
  newestFirst,
  projectMetadata,
  settledAt,
  wakeAt,
  type InboxEntry as Entry,
  type InboxEntryGroups,
  type ProjectMetadata,
} from '../inbox-order.js'
import { isComposingKey, isConfirmEnter } from '../shortcuts.js'
import { Menu, MenuItem } from './Menu.js'
import type { Project, Session } from './Sidebar.js'
import { InboxCardsSkeleton } from './SurfaceSkeletons.js'
import { SourceIdentity } from './SourceIdentity.js'
import { ThreadTile, threadTileMark } from './ThreadTile.js'
import { THREAD_IMAGE_ACCEPT } from '../thread-image.js'

const PAGE_SIZE = 25
const INITIAL_ACTIVE_LIMIT = 12
const INITIAL_SETTLED_LIMIT = 10
const ACTIVE_PAGE_IDLE_TIMEOUT_MS = 500
const ACTIVE_PAGE_FALLBACK_DELAY_MS = 100
const NARROW_VIEWPORT_QUERY = '(max-width: 700px)'
/** How long after a lifecycle change a newly mounted row counts as arriving. */
const ARRIVAL_WINDOW_MS = 700
const InboxSecondNowContext = createContext(Date.now())
const InboxMinuteNowContext = createContext(Date.now())
const InboxDayNowContext = createContext(Date.now())

function useRetainedClockValue(now: number, bucket: number): number {
  const retained = useRef({ bucket, now })
  if (retained.current.bucket !== bucket) retained.current = { bucket, now }
  return retained.current.now
}

function useRetainedNumberArray(values: number[]): readonly number[] {
  const retained = useRef<readonly number[]>(values)
  if (
    retained.current.length !== values.length ||
    values.some((value, index) => retained.current[index] !== value)
  ) {
    retained.current = values
  }
  return retained.current
}

function scheduleIdle(callback: () => void): () => void {
  if (globalThis.requestIdleCallback) {
    const handle = globalThis.requestIdleCallback(callback, {
      timeout: ACTIVE_PAGE_IDLE_TIMEOUT_MS,
    })
    return () => globalThis.cancelIdleCallback?.(handle)
  }
  const handle = window.setTimeout(callback, ACTIVE_PAGE_FALLBACK_DELAY_MS)
  return () => window.clearTimeout(handle)
}

function InboxClock(props: {
  hasRunningThread: boolean
  relativeTimes: readonly number[]
  hasSnoozedThread: boolean
  children: ReactNode
}) {
  const [now, setNow] = useState(Date.now)
  const [documentVisible, setDocumentVisible] = useState(
    () => document.visibilityState !== 'hidden',
  )

  useEffect(() => {
    const onVisibilityChange = () => {
      const visible = document.visibilityState !== 'hidden'
      setDocumentVisible(visible)
      if (visible) setNow(Date.now())
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])
  useEffect(() => {
    if (!documentVisible) return
    const delay = inboxClockDelay(
      props.hasRunningThread,
      props.relativeTimes,
      props.hasSnoozedThread,
      now,
    )
    if (delay === undefined) return
    const timer = window.setTimeout(() => setNow(Date.now()), delay)
    return () => window.clearTimeout(timer)
  }, [documentVisible, now, props.hasRunningThread, props.hasSnoozedThread, props.relativeTimes])

  const minuteNow = useRetainedClockValue(now, Math.floor(now / 60_000))
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  const dayNow = useRetainedClockValue(now, day.getTime())

  return (
    <InboxSecondNowContext.Provider value={now}>
      <InboxMinuteNowContext.Provider value={minuteNow}>
        <InboxDayNowContext.Provider value={dayNow}>{props.children}</InboxDayNowContext.Provider>
      </InboxMinuteNowContext.Provider>
    </InboxSecondNowContext.Provider>
  )
}

export type InboxActions = {
  onSettle: (id: string) => void
  onSettleMany?: ((ids: string[]) => void) | undefined
  onUnsettle: (id: string) => void
  onUnsettleMany?: ((ids: string[]) => void) | undefined
  onSnooze: (id: string, wakeAt: number) => void
  onSnoozeMany?: ((ids: string[], wakeAt: number) => void) | undefined
  onUnsnooze: (id: string) => void
  onUnsnoozeMany?: ((ids: string[]) => void) | undefined
  onKeepActive: (id: string, keepActive: boolean) => void
}

function InboxSidebarComponent(props: {
  projects: Project[]
  /** The project list has not arrived yet, so an empty one is not the answer. */
  loading?: boolean | undefined
  scope: string
  activeProjectPath: string | undefined
  activeSessionId: string | undefined
  actions: InboxActions
  onScopeChange: (path: string) => void
  onAddProject: () => void
  onNewSession: (preferredPath?: string, chooseProject?: boolean) => void
  onSelectSession: (id: string) => void
  onRenameSession: (id: string, title: string) => void
  onToggleSessionPin?: (id: string) => void
  /** Sets a thread's picture from a picked file, or removes it. Absent hides the actions. */
  onSetSessionImage?: ((id: string, file: File | undefined) => void) | undefined
  onArchiveSession: (id: string) => void
  onArchiveSessions?: ((ids: string[]) => void) | undefined
  pullRequestsActive?: boolean | undefined
  onOpenPullRequests?: (() => void) | undefined
}) {
  const [query, setQuery] = useState('')
  const [snoozedOpen, setSnoozedOpen] = useState(false)
  const [settledOpen, setSettledOpen] = useState(true)
  const [activeLimit, setActiveLimit] = useState(INITIAL_ACTIVE_LIMIT)
  const [snoozedLimit, setSnoozedLimit] = useState(PAGE_SIZE)
  const [settledLimit, setSettledLimit] = useState(INITIAL_SETTLED_LIMIT)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [selectionAnchor, setSelectionAnchor] = useState<string>()
  const [eagerRowActions, setEagerRowActions] = useState(
    () => globalThis.matchMedia?.(NARROW_VIEWPORT_QUERY).matches ?? false,
  )
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const searchInput = useRef<HTMLInputElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const imageTarget = useRef<string | undefined>(undefined)

  useEffect(() => {
    const media = globalThis.matchMedia?.(NARROW_VIEWPORT_QUERY)
    if (!media) return
    const onChange = (event: MediaQueryListEvent) => setEagerRowActions(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  // Memoised because the parent still commits during streaming. The lifecycle
  // list only needs to be rebuilt when its actual inputs change.
  const classifyEntries = useMemo(createInboxEntryClassifier, [])
  const { active, snoozed, settled, ordered } = useMemo(
    () => classifyEntries(props.projects, props.scope, normalizedQuery),
    [classifyEntries, props.projects, props.scope, normalizedQuery],
  )

  const selectedEntry = useMemo(() => {
    const selected = findSession(props.projects, props.activeSessionId)
    if (!selected || (props.scope && selected.project.path !== props.scope)) return undefined
    if (normalizedQuery && !selected.session.title.toLocaleLowerCase().includes(normalizedQuery)) {
      return undefined
    }
    return { project: projectMetadata(selected.project), session: selected.session }
  }, [normalizedQuery, props.activeSessionId, props.projects, props.scope])
  const selectedActive =
    selectedEntry?.session.lifecycle.state === 'active' ? selectedEntry : undefined
  const selectedSnoozed =
    selectedEntry?.session.lifecycle.state === 'snoozed' ? selectedEntry : undefined
  const selectedSettled =
    selectedEntry?.session.lifecycle.state === 'settled' ? selectedEntry : undefined
  const visibleActive = withSelected(active.slice(0, activeLimit), selectedActive)
  const visibleSnoozed = withSelected(snoozed.slice(0, snoozedLimit), selectedSnoozed)
  const visibleSettled = withSelected(settled.slice(0, settledLimit), selectedSettled)
  const snoozedExpanded = Boolean(normalizedQuery) || snoozedOpen || selectedSnoozed !== undefined
  const settledExpanded = Boolean(normalizedQuery) || settledOpen || selectedSettled !== undefined
  const hasMatches = ordered.length > 0
  const hasRunningThread = visibleActive.some((entry) =>
    ['starting', 'working'].includes(entry.session.status),
  )
  const nextRelativeTimes: number[] = []
  // Every row that is not running shows how long ago its state changed.
  for (const { session } of visibleActive) {
    if (session.status !== 'starting' && session.status !== 'working') {
      nextRelativeTimes.push(session.statusSince ?? session.createdAt)
    }
  }
  if (settledExpanded) {
    for (const { session } of visibleSettled) {
      if (session.lifecycle.state === 'settled') {
        nextRelativeTimes.push(session.lifecycle.settledAt)
      }
      if (session.status === 'idle') {
        nextRelativeTimes.push(session.statusSince ?? session.createdAt)
      }
    }
  }
  const relativeTimes = useRetainedNumberArray(nextRelativeTimes)
  const activePageDeferred =
    activeLimit === INITIAL_ACTIVE_LIMIT && active.length > INITIAL_ACTIVE_LIMIT

  useEffect(() => {
    setActiveLimit(INITIAL_ACTIVE_LIMIT)
    setSnoozedLimit(PAGE_SIZE)
    setSettledLimit(INITIAL_SETTLED_LIMIT)
  }, [normalizedQuery, props.scope])
  useEffect(() => {
    if (!activePageDeferred) return
    return scheduleIdle(() => setActiveLimit((limit) => Math.max(limit, PAGE_SIZE)))
  }, [activePageDeferred])
  useEffect(() => {
    if (selectedIds.size === 0) return
    setSelectedIds((current) =>
      retainInboxSelection(props.projects, current, props.scope, normalizedQuery),
    )
  }, [normalizedQuery, props.projects, props.scope, selectedIds.size])

  const selectedEntries = useMemo(
    () =>
      selectedIds.size > 1
        ? resolveInboxSelection(props.projects, selectedIds, props.scope, normalizedQuery)
        : [],
    [normalizedQuery, props.projects, props.scope, selectedIds],
  )
  const visibleOrdered = [
    ...visibleActive,
    ...(snoozedExpanded ? visibleSnoozed : []),
    ...(settledExpanded ? visibleSettled : []),
  ]
  const orderedRef = useRef(visibleOrdered)
  const selectedIdsRef = useRef(selectedIds)
  const selectionAnchorRef = useRef(selectionAnchor)
  orderedRef.current = visibleOrdered
  selectedIdsRef.current = selectedIds
  selectionAnchorRef.current = selectionAnchor

  const registerRow = useCallback((id: string, node: HTMLButtonElement | null) => {
    if (node) rowRefs.current.set(id, node)
    else rowRefs.current.delete(id)
  }, [])

  const focusResult = useCallback((id: string, direction: -1 | 1) => {
    const ordered = orderedRef.current
    const index = ordered.findIndex((entry) => entry.session.id === id)
    if (index < 0 || ordered.length === 0) return
    for (let offset = 1; offset <= ordered.length; offset += 1) {
      const next = ordered[(index + direction * offset + ordered.length) % ordered.length]
      const node = next ? rowRefs.current.get(next.session.id) : undefined
      if (node) {
        node.focus()
        return
      }
    }
  }, [])

  const focusBoundary = useCallback((direction: -1 | 1) => {
    const ordered = orderedRef.current
    for (let offset = 0; offset < ordered.length; offset += 1) {
      const index = direction === 1 ? offset : ordered.length - 1 - offset
      const entry = ordered[index]
      const node = entry ? rowRefs.current.get(entry.session.id) : undefined
      if (node) {
        node.focus()
        return
      }
    }
  }, [])

  const chooseEntry = useCallback(
    (event: ReactMouseEvent, id: string) => {
      const ordered = orderedRef.current
      const selectionAnchor = selectionAnchorRef.current
      if (event.shiftKey && selectionAnchor) {
        const from = ordered.findIndex((entry) => entry.session.id === selectionAnchor)
        const to = ordered.findIndex((entry) => entry.session.id === id)
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from]
          setSelectedIds(new Set(ordered.slice(start, end + 1).map((entry) => entry.session.id)))
          return
        }
      }
      if (event.metaKey || event.ctrlKey) {
        setSelectedIds((current) => {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
        setSelectionAnchor(id)
        return
      }
      setSelectedIds(new Set())
      setSelectionAnchor(id)
      props.onSelectSession(id)
    },
    [props.onSelectSession],
  )

  const prepareContextMenu = useCallback((id: string) => {
    if (selectedIdsRef.current.has(id)) return
    setSelectedIds(new Set([id]))
    setSelectionAnchor(id)
  }, [])

  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])
  const archiveSessions = useCallback(
    (ids: string[]) => {
      if (props.onArchiveSessions) props.onArchiveSessions(ids)
      else ids.forEach(props.onArchiveSession)
    },
    [props.onArchiveSession, props.onArchiveSessions],
  )
  const unsnooze = useCallback((id: string) => props.actions.onUnsnooze(id), [props.actions])
  const unsettle = useCallback((id: string) => props.actions.onUnsettle(id), [props.actions])
  // Rebuilt only when the active group changes, never on a streamed delta.
  const finding = useMemo(() => activeFinding(active), [active])
  const openFirst = useCallback(
    (id: string) => {
      setSelectedIds(new Set())
      setSelectionAnchor(id)
      props.onSelectSession(id)
      rowRefs.current.get(id)?.focus()
    },
    [props.onSelectSession],
  )
  const setSessionImage = props.onSetSessionImage
  const chooseImage = useMemo(
    () =>
      setSessionImage
        ? (id: string) => {
            imageTarget.current = id
            imageInput.current?.click()
          }
        : undefined,
    [setSessionImage],
  )
  const removeImage = useMemo(
    () => (setSessionImage ? (id: string) => setSessionImage(id, undefined) : undefined),
    [setSessionImage],
  )
  const preferredProject =
    props.scope ||
    props.activeProjectPath ||
    (props.projects.length === 1 ? props.projects[0]?.path : '')

  return (
    <InboxClock
      hasRunningThread={hasRunningThread}
      relativeTimes={relativeTimes}
      hasSnoozedThread={snoozedExpanded && visibleSnoozed.length > 0}
    >
      <div className="inbox-toolbar">
        <h1 className="visually-hidden">Threads</h1>
        <div className="inbox-toolbar__primary">
          <label className="inbox-search">
            <Search size={16} stroke={1.5} aria-hidden />
            <input
              ref={searchInput}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (isComposingKey(event)) return
                if (event.key === 'Escape' && query) {
                  event.preventDefault()
                  setQuery('')
                  return
                }
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                event.preventDefault()
                focusBoundary(event.key === 'ArrowDown' ? 1 : -1)
              }}
              placeholder="Search"
              aria-label="Search threads"
              spellCheck={false}
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear thread search"
                onClick={() => {
                  setQuery('')
                  searchInput.current?.focus()
                }}
              >
                <X size={12} aria-hidden />
              </button>
            ) : null}
          </label>
          <ProjectFilter
            projects={props.projects}
            scope={props.scope}
            onScopeChange={props.onScopeChange}
          />
          <button
            className="inbox-toolbar__icon"
            type="button"
            aria-label="Add project"
            title="Add project"
            onClick={props.onAddProject}
          >
            <FolderPlus size={16} stroke={1.5} aria-hidden />
          </button>
          <button
            className="inbox-toolbar__icon"
            type="button"
            aria-label="New thread"
            title="New thread"
            onClick={() => {
              if (props.projects.length === 0) props.onAddProject()
              else props.onNewSession(preferredProject || undefined, props.projects.length > 1)
            }}
          >
            <SquarePen size={16} stroke={1.5} aria-hidden />
          </button>
        </div>
        {props.onOpenPullRequests ? (
          <button
            type="button"
            className={`inbox-toolbar__pulls${props.pullRequestsActive ? ' is-active' : ''}`}
            aria-current={props.pullRequestsActive ? 'page' : undefined}
            onClick={props.onOpenPullRequests}
          >
            <GitPullRequest size={16} stroke={1.5} aria-hidden />
            <span>Pull requests</span>
          </button>
        ) : null}
      </div>
      {setSessionImage ? (
        <input
          ref={imageInput}
          className="inbox__image-input"
          type="file"
          accept={THREAD_IMAGE_ACCEPT}
          tabIndex={-1}
          aria-hidden
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            const id = imageTarget.current
            event.currentTarget.value = ''
            imageTarget.current = undefined
            if (file && id) setSessionImage(id, file)
          }}
        />
      ) : null}

      <div className="rail__body inbox__body">
        {props.loading && props.projects.length === 0 ? (
          <InboxCardsSkeleton />
        ) : (
          <div className="inbox">
            {selectedIds.size > 1 ? (
              <p className="inbox__selection-count">{selectedIds.size} threads selected</p>
            ) : null}

            {!normalizedQuery || active.length > 0 ? (
              <>
                <ActiveHeading count={active.length} finding={finding} onOpen={openFirst} />
                {active.length > 0 ? (
                  <ul className="inbox__list" aria-label="Active threads">
                    {visibleActive.map((entry) => {
                      const selected = selectedIds.has(entry.session.id)
                      return (
                        <ActiveRow
                          {...entry}
                          key={entry.session.id}
                          current={entry.session.id === props.activeSessionId}
                          selected={selected}
                          eagerActions={eagerRowActions}
                          menuEntries={
                            selected && selectedIds.size > 1 ? selectedEntries : undefined
                          }
                          actions={props.actions}
                          onChoose={chooseEntry}
                          onContextMenu={prepareContextMenu}
                          onRegister={registerRow}
                          onNavigate={focusResult}
                          onRename={props.onRenameSession}
                          onTogglePin={props.onToggleSessionPin}
                          onChooseImage={chooseImage}
                          onRemoveImage={removeImage}
                          onArchive={props.onArchiveSession}
                          onArchiveMany={archiveSessions}
                          onClearSelection={clearSelection}
                        />
                      )
                    })}
                    {active.length > activeLimit && !activePageDeferred ? (
                      <li>
                        <button
                          className="inbox__more"
                          type="button"
                          onClick={() => setActiveLimit((limit) => limit + PAGE_SIZE)}
                        >
                          Show {PAGE_SIZE} more
                        </button>
                      </li>
                    ) : null}
                  </ul>
                ) : (
                  <p className="inbox__empty">No active threads in this project.</p>
                )}
              </>
            ) : null}

            <Shelf
              title="Snoozed"
              count={snoozed.length}
              open={snoozedExpanded}
              onToggle={() => setSnoozedOpen((open) => !open)}
            >
              {snoozedExpanded ? (
                <>
                  {visibleSnoozed.map((entry) => {
                    const selected = selectedIds.has(entry.session.id)
                    return (
                      <ShelfRow
                        {...entry}
                        key={entry.session.id}
                        current={entry.session.id === props.activeSessionId}
                        selected={selected}
                        eagerActions={eagerRowActions}
                        menuEntries={selected && selectedIds.size > 1 ? selectedEntries : undefined}
                        action="Wake now"
                        actions={props.actions}
                        onChoose={chooseEntry}
                        onContextMenu={prepareContextMenu}
                        onRegister={registerRow}
                        onNavigate={focusResult}
                        onRename={props.onRenameSession}
                        onTogglePin={props.onToggleSessionPin}
                        onChooseImage={chooseImage}
                        onRemoveImage={removeImage}
                        onArchive={props.onArchiveSession}
                        onArchiveMany={archiveSessions}
                        onAction={unsnooze}
                        onClearSelection={clearSelection}
                      />
                    )
                  })}
                  {snoozed.length > snoozedLimit ? (
                    <li>
                      <button
                        className="inbox__more"
                        type="button"
                        onClick={() => setSnoozedLimit((limit) => limit + PAGE_SIZE)}
                      >
                        Show {PAGE_SIZE} more
                      </button>
                    </li>
                  ) : null}
                </>
              ) : null}
            </Shelf>

            <Shelf
              title="Settled"
              count={settled.length}
              open={settledExpanded}
              onToggle={() => setSettledOpen((open) => !open)}
            >
              {settledExpanded ? (
                <>
                  {visibleSettled.map((entry) => {
                    const selected = selectedIds.has(entry.session.id)
                    return (
                      <ShelfRow
                        {...entry}
                        key={entry.session.id}
                        current={entry.session.id === props.activeSessionId}
                        selected={selected}
                        eagerActions={eagerRowActions}
                        menuEntries={selected && selectedIds.size > 1 ? selectedEntries : undefined}
                        action="Un-settle"
                        actions={props.actions}
                        onChoose={chooseEntry}
                        onContextMenu={prepareContextMenu}
                        onRegister={registerRow}
                        onNavigate={focusResult}
                        onRename={props.onRenameSession}
                        onTogglePin={props.onToggleSessionPin}
                        onChooseImage={chooseImage}
                        onRemoveImage={removeImage}
                        onArchive={props.onArchiveSession}
                        onArchiveMany={archiveSessions}
                        onAction={unsettle}
                        onClearSelection={clearSelection}
                      />
                    )
                  })}
                  {settled.length > settledLimit ? (
                    <li>
                      <button
                        className="inbox__more"
                        type="button"
                        onClick={() => setSettledLimit((limit) => limit + PAGE_SIZE)}
                      >
                        Show {PAGE_SIZE} more
                      </button>
                    </li>
                  ) : null}
                </>
              ) : null}
            </Shelf>

            {normalizedQuery && !hasMatches ? (
              <p className="inbox__empty inbox__empty--search">
                No threads match “{query.trim()}”.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </InboxClock>
  )
}

type ActiveFinding = {
  failed: number
  firstFailed: string | undefined
  waiting: number
  firstWaiting: string | undefined
  working: number
}

/** What the active group needs from the person, counted from its rows. */
export function activeFinding(entries: readonly Entry[]): ActiveFinding {
  const finding: ActiveFinding = {
    failed: 0,
    firstFailed: undefined,
    waiting: 0,
    firstWaiting: undefined,
    working: 0,
  }
  for (const { session } of entries) {
    if (session.status === 'failed') {
      finding.failed += 1
      finding.firstFailed ??= session.id
    } else if (session.status === 'input' || session.status === 'approval') {
      finding.waiting += 1
      finding.firstWaiting ??= session.id
    } else if (session.status === 'starting' || session.status === 'working') {
      finding.working += 1
    }
  }
  return finding
}

/**
 * The active group's heading: its name and count, and on the right how many
 * threads wait on the person (failed or asking), which opens the first of them.
 */
function ActiveHeading(props: {
  count: number
  finding: ActiveFinding
  onOpen: (id: string) => void
}) {
  const { failed, firstFailed, waiting, firstWaiting } = props.finding
  const needYou = failed + waiting
  const first = firstFailed ?? firstWaiting
  return (
    <div className="inbox__heading">
      <p>
        Active <span className="inbox__heading-count">{props.count}</span>
      </p>
      {first ? (
        <button
          type="button"
          className="inbox__need-you"
          title="Open the first thread that needs you"
          onClick={() => props.onOpen(first)}
        >
          {needYou} {needYou === 1 ? 'needs' : 'need'} you
        </button>
      ) : null}
    </div>
  )
}

function ProjectFilter(props: {
  projects: Project[]
  scope: string
  onScopeChange: (path: string) => void
}) {
  const current = props.scope
    ? props.projects.find((project) => project.path === props.scope)
    : undefined
  const label = current ? `Filter by project: ${projectName(current)}` : 'Filter by project'
  return (
    <Menu
      drop="down"
      align="right"
      label={label}
      triggerTitle={label}
      triggerClassName={`inbox-toolbar__icon${current ? ' is-filtered' : ''}`}
      panelClassName="menu--sidebar"
      trigger={() => <Filter size={16} stroke={1.5} aria-hidden />}
    >
      {(close) => (
        <>
          <MenuItem
            title="All projects"
            icon={<Folder size={13} aria-hidden />}
            active={!current}
            checked={!current}
            onClick={() => {
              props.onScopeChange('')
              close()
            }}
          />
          {props.projects.map((project) => (
            <MenuItem
              key={project.path}
              title={projectName(project)}
              icon={<Folder size={13} aria-hidden />}
              active={project.path === props.scope}
              checked={project.path === props.scope}
              onClick={() => {
                props.onScopeChange(project.path)
                close()
              }}
            />
          ))}
        </>
      )}
    </Menu>
  )
}

/** Skip unrelated shell commits when every inbox input keeps its identity. */
export const InboxSidebar = memo(InboxSidebarComponent)

const ActiveRow = memo(function ActiveRow(
  props: Entry & {
    current: boolean
    selected: boolean
    eagerActions: boolean
    menuEntries: Entry[] | undefined
    actions: InboxActions
    onChoose: (event: ReactMouseEvent, id: string) => void
    onContextMenu: (id: string) => void
    onRegister: (id: string, node: HTMLButtonElement | null) => void
    onNavigate: (id: string, direction: -1 | 1) => void
    onRename: (id: string, title: string) => void
    onTogglePin: ((id: string) => void) | undefined
    onChooseImage: ((id: string) => void) | undefined
    onRemoveImage: ((id: string) => void) | undefined
    onArchive: (id: string) => void
    onArchiveMany: (ids: string[]) => void
    onClearSelection: () => void
  },
) {
  const [renaming, setRenaming] = useState(false)
  const [actionsRequested, setActionsRequested] = useState(false)
  const [arriving] = useState(() => justArrived(props.session, Date.now()))
  const contextMenuTarget = useRef<HTMLButtonElement>(null)
  const lifecycle =
    props.session.lifecycle.state === 'active'
      ? props.session.lifecycle
      : { state: 'active' as const, keepActive: false }
  const eligible = canHide(props.session)
  const actionsReady = props.eagerActions || actionsRequested

  if (renaming) {
    return (
      <li className="inbox-card is-renaming">
        <Rename
          value={props.session.title}
          onCancel={() => setRenaming(false)}
          onCommit={(title) => {
            props.onRename(props.session.id, title)
            setRenaming(false)
          }}
        />
      </li>
    )
  }

  const setTarget = (node: HTMLButtonElement | null) => {
    contextMenuTarget.current = node
    props.onRegister(props.session.id, node)
  }
  const initialNow = Date.now()
  const name = projectName(props.project)
  const mark = threadTileMark(props.session.status)
  const woke = lifecycle.wokeAt !== undefined && props.session.status !== 'idle'
  const emphasis = props.session.unread || (mark !== 'none' && mark !== 'done' && mark !== 'queued')

  return (
    <li
      className={`inbox-card${props.current ? ' is-selected' : ''}${props.selected ? ' is-multi-selected' : ''}${emphasis ? ' is-emphasized' : ''}${arriving ? ' is-arriving' : ''}`}
      data-thread-id={props.session.id}
      onPointerEnter={() => setActionsRequested(true)}
      onFocusCapture={() => setActionsRequested(true)}
    >
      <button
        ref={setTarget}
        className="inbox-card__main"
        type="button"
        onClick={(event) => props.onChoose(event, props.session.id)}
        onContextMenu={() => props.onContextMenu(props.session.id)}
        onDoubleClick={() => setRenaming(true)}
        onKeyDown={(event) =>
          navigateRows(event, (direction) => props.onNavigate(props.session.id, direction))
        }
        aria-label={rowLabel(props.project, props.session, initialNow)}
        title={threadSummary(props.project, props.session, initialNow)}
      >
        <ThreadTile image={props.session.image} name={name} mark={mark} />
        <span className="inbox-card__line">
          <RowMarks session={props.session} />
          <span className="inbox-card__title">{props.session.title}</span>
        </span>
        <span className="inbox-card__meta">
          <StateWord session={props.session} woke={woke} />
          <span className="inbox-card__project">{name}</span>
          {props.session.worktreeBranch ? (
            <span className="inbox-card__branch">
              <GitBranch size={12} aria-hidden />
              <span>{props.session.worktreeBranch}</span>
            </span>
          ) : null}
          <RowSource session={props.session} />
          <span className="inbox-card__state">
            <ActiveRowClock
              project={props.project}
              session={props.session}
              target={contextMenuTarget}
              initialNow={initialNow}
            />
          </span>
        </span>
      </button>

      <span className="inbox-card__quick">
        {eligible && actionsReady ? (
          <button
            className="inbox-card__action"
            type="button"
            aria-label={`Settle ${props.session.title}`}
            onClick={() => props.actions.onSettle(props.session.id)}
          >
            Settle
          </button>
        ) : null}
        <ThreadMenu
          entry={{ project: props.project, session: props.session }}
          entries={props.menuEntries ?? [{ project: props.project, session: props.session }]}
          actions={props.actions}
          contextMenuTarget={contextMenuTarget}
          triggerReady={actionsReady}
          onRename={() => setRenaming(true)}
          onTogglePin={() => props.onTogglePin?.(props.session.id)}
          onChooseImage={props.onChooseImage}
          onRemoveImage={props.onRemoveImage}
          onArchive={() => props.onArchive(props.session.id)}
          onArchiveMany={props.onArchiveMany}
          onClearSelection={props.onClearSelection}
        />
      </span>
    </li>
  )
})

/** What sits before the title: the pin and an unread reply's dot. */
function RowMarks(props: { session: Session }) {
  return (
    <>
      {props.session.pinned ? <Pin className="inbox-card__pin" size={12} aria-hidden /> : null}
      {props.session.unread && props.session.status !== 'ready' ? (
        <span className="inbox-card__unread" aria-hidden />
      ) : null}
    </>
  )
}

/**
 * The state in words, first on the row's second line, in the same semantic
 * colours as the classic sidebar's status dot: green for done, red for
 * failed, amber for what waits on the person. Working stays in ink and queued
 * in grey; the ring around the tile tells them apart.
 */
function StateWord(props: { session: Session; woke: boolean }) {
  const word = stateWord(props.session, props.woke)
  if (!word) return null
  return <span className={`inbox-state is-${word.tone}`}>{word.label}</span>
}

function stateWord(
  session: Session,
  woke: boolean,
): { label: string; tone: 'working' | 'attention' | 'failed' | 'done' | 'quiet' } | undefined {
  switch (session.status) {
    case 'starting':
    case 'working':
      return { label: 'Working', tone: 'working' }
    case 'input':
      return { label: 'Needs input', tone: 'attention' }
    case 'approval':
      return { label: 'Approval', tone: 'attention' }
    case 'failed':
      return { label: 'Failed', tone: 'failed' }
    case 'queued':
      return { label: 'Queued', tone: 'quiet' }
    case 'ready':
      return { label: 'Done', tone: 'done' }
    default:
      return woke ? { label: 'Woke', tone: 'attention' } : undefined
  }
}

/** The provider's mark, quiet at the end of the second line; its name stays for assistive tech. */
function RowSource(props: { session: Session }) {
  return (
    <SourceIdentity
      className="inbox-card__source"
      presentation={sessionSourcePresentation(props.session.provider, props.session.agent)}
      density="compact"
      label="hidden"
    />
  )
}

function ActiveRowClock(props: {
  project: ProjectMetadata
  session: Session
  target: RefObject<HTMLButtonElement | null>
  initialNow: number
}) {
  const running = props.session.status === 'starting' || props.session.status === 'working'
  return running ? <SecondActiveRowClock {...props} /> : <MinuteActiveRowClock {...props} />
}

function SecondActiveRowClock(props: {
  project: ProjectMetadata
  session: Session
  target: RefObject<HTMLButtonElement | null>
}) {
  const now = useContext(InboxSecondNowContext)
  return <ClockedActiveRow {...props} now={now} />
}

function MinuteActiveRowClock(props: {
  project: ProjectMetadata
  session: Session
  target: RefObject<HTMLButtonElement | null>
}) {
  const now = useContext(InboxMinuteNowContext)
  return <ClockedActiveRow {...props} now={now} />
}

function ClockedActiveRow(props: {
  project: ProjectMetadata
  session: Session
  target: RefObject<HTMLButtonElement | null>
  now: number
}) {
  useLayoutEffect(() => {
    const target = props.target.current
    if (!target) return
    target.setAttribute('aria-label', rowLabel(props.project, props.session, props.now))
    target.title = threadSummary(props.project, props.session, props.now)
  }, [props.now, props.project, props.session, props.target])
  return <RowTime session={props.session} now={props.now} />
}

function Shelf(props: {
  title: string
  count: number
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  if (props.count === 0) return null
  return (
    <section className="inbox-shelf">
      <button
        className="inbox-shelf__toggle"
        type="button"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <ChevronRight size={11} aria-hidden />
        <span>{props.title}</span>
        <span>{props.count}</span>
      </button>
      {props.open ? <ul className="inbox-shelf__list">{props.children}</ul> : null}
    </section>
  )
}

const ShelfRow = memo(function ShelfRow(
  props: Entry & {
    current: boolean
    selected: boolean
    eagerActions: boolean
    menuEntries: Entry[] | undefined
    action: string
    actions: InboxActions
    onChoose: (event: ReactMouseEvent, id: string) => void
    onContextMenu: (id: string) => void
    onRegister: (id: string, node: HTMLButtonElement | null) => void
    onNavigate: (id: string, direction: -1 | 1) => void
    onRename: (id: string, title: string) => void
    onTogglePin: ((id: string) => void) | undefined
    onChooseImage: ((id: string) => void) | undefined
    onRemoveImage: ((id: string) => void) | undefined
    onArchive: (id: string) => void
    onArchiveMany: (ids: string[]) => void
    onAction: (id: string) => void
    onClearSelection: () => void
  },
) {
  const [renaming, setRenaming] = useState(false)
  const [actionsRequested, setActionsRequested] = useState(false)
  const [arriving] = useState(() => justArrived(props.session, Date.now()))
  const contextMenuTarget = useRef<HTMLButtonElement>(null)
  const setTarget = (node: HTMLButtonElement | null) => {
    contextMenuTarget.current = node
    props.onRegister(props.session.id, node)
  }
  const initialNow = Date.now()
  const actionsReady = props.eagerActions || actionsRequested

  const name = projectName(props.project)
  const mark = threadTileMark(props.session.status)

  return (
    <li
      className={`inbox-shelf__row${props.current ? ' is-selected' : ''}${props.selected ? ' is-multi-selected' : ''}${props.session.unread ? ' is-emphasized' : ''}${arriving ? ' is-arriving' : ''}`}
      data-thread-id={props.session.id}
      onPointerEnter={() => setActionsRequested(true)}
      onFocusCapture={() => setActionsRequested(true)}
    >
      {renaming ? (
        <Rename
          value={props.session.title}
          onCancel={() => setRenaming(false)}
          onCommit={(title) => {
            props.onRename(props.session.id, title)
            setRenaming(false)
          }}
        />
      ) : (
        <button
          ref={setTarget}
          className="inbox-shelf__main"
          type="button"
          onClick={(event) => props.onChoose(event, props.session.id)}
          onContextMenu={() => props.onContextMenu(props.session.id)}
          onDoubleClick={() => setRenaming(true)}
          onKeyDown={(event) =>
            navigateRows(event, (direction) => props.onNavigate(props.session.id, direction))
          }
          aria-label={shelfRowLabel(props.project, props.session, initialNow)}
          title={threadSummary(props.project, props.session, initialNow)}
        >
          <ThreadTile image={props.session.image} name={name} mark={mark} />
          <span className="inbox-card__line">
            <RowMarks session={props.session} />
            <span className="inbox-shelf__title">{props.session.title}</span>
          </span>
          <span className="inbox-card__meta">
            <ShelfRowClock
              project={props.project}
              session={props.session}
              target={contextMenuTarget}
            />
            <span className="inbox-card__project">{name}</span>
            <RowSource session={props.session} />
          </span>
        </button>
      )}
      {!renaming ? (
        <span className="inbox-card__quick">
          <button
            className="inbox-card__action"
            type="button"
            aria-label={`${props.action} ${props.session.title}`}
            onClick={() => props.onAction(props.session.id)}
          >
            {props.action}
          </button>
          <ThreadMenu
            entry={{ project: props.project, session: props.session }}
            entries={props.menuEntries ?? [{ project: props.project, session: props.session }]}
            actions={props.actions}
            contextMenuTarget={contextMenuTarget}
            triggerReady={actionsReady}
            onRename={() => setRenaming(true)}
            onTogglePin={() => props.onTogglePin?.(props.session.id)}
            onChooseImage={props.onChooseImage}
            onRemoveImage={props.onRemoveImage}
            onArchive={() => props.onArchive(props.session.id)}
            onArchiveMany={props.onArchiveMany}
            onClearSelection={props.onClearSelection}
          />
        </span>
      ) : null}
    </li>
  )
})

function ShelfRowClock(props: {
  project: ProjectMetadata
  session: Session
  target: RefObject<HTMLButtonElement | null>
}) {
  return props.session.lifecycle.state === 'snoozed' ? (
    <DayShelfRowClock {...props} />
  ) : (
    <MinuteShelfRowClock {...props} />
  )
}

function DayShelfRowClock(props: {
  project: ProjectMetadata
  session: Session
  target: RefObject<HTMLButtonElement | null>
}) {
  const now = useContext(InboxDayNowContext)
  return <ClockedShelfRow {...props} now={now} />
}

function MinuteShelfRowClock(props: {
  project: ProjectMetadata
  session: Session
  target: RefObject<HTMLButtonElement | null>
}) {
  const now = useContext(InboxMinuteNowContext)
  return <ClockedShelfRow {...props} now={now} />
}

function ClockedShelfRow(props: {
  project: ProjectMetadata
  session: Session
  target: RefObject<HTMLButtonElement | null>
  now: number
}) {
  useLayoutEffect(() => {
    const target = props.target.current
    if (!target) return
    target.setAttribute('aria-label', shelfRowLabel(props.project, props.session, props.now))
    target.title = threadSummary(props.project, props.session, props.now)
  }, [props.now, props.project, props.session, props.target])
  const detail = shelfDetail(props.session, props.now)
  return (
    <span className="inbox-state is-quiet">
      {props.session.lifecycle.state === 'snoozed' ? detail : `Settled ${detail}`}
    </span>
  )
}

function ThreadMenu(props: {
  entry: Entry
  entries: Entry[]
  actions: InboxActions
  contextMenuTarget: RefObject<HTMLButtonElement | null>
  triggerReady: boolean
  onRename: () => void
  onTogglePin: () => void
  onChooseImage: ((id: string) => void) | undefined
  onRemoveImage: ((id: string) => void) | undefined
  onArchive: (id?: string) => void
  onArchiveMany: (ids: string[]) => void
  onClearSelection: () => void
}) {
  const multiple = props.entries.length > 1
  const lifecycle =
    props.entry.session.lifecycle.state === 'active' ? props.entry.session.lifecycle : undefined

  const finish = (close: () => void, action: () => void) => {
    action()
    props.onClearSelection()
    close()
  }

  return (
    <Menu
      drop="down"
      align="right"
      label={`Thread options for ${props.entry.session.title}`}
      triggerClassName="inbox-card__menu"
      panelClassName="menu--sidebar"
      contextMenuTargetRef={props.contextMenuTarget}
      {...(props.triggerReady
        ? { trigger: threadMenuTrigger }
        : { contextMenuOnly: true as const })}
    >
      {(close) => {
        const active: Entry[] = []
        const snoozed: Entry[] = []
        const settled: Entry[] = []
        for (const entry of props.entries) {
          if (entry.session.lifecycle.state === 'active') {
            if (canHide(entry.session)) active.push(entry)
          } else if (entry.session.lifecycle.state === 'snoozed') {
            snoozed.push(entry)
          } else {
            settled.push(entry)
          }
        }
        return (
          <>
            {multiple ? (
              <div className="inbox-menu__selection">{props.entries.length} selected</div>
            ) : null}
            {active.length > 0 ? (
              <>
                <MenuItem
                  title={multiple ? `Settle ${threadCount(active.length)}` : 'Settle'}
                  icon={<CheckCheck size={13} aria-hidden />}
                  onClick={() =>
                    finish(close, () => {
                      const ids = active.map((entry) => entry.session.id)
                      if (multiple && props.actions.onSettleMany) props.actions.onSettleMany(ids)
                      else ids.forEach((id) => props.actions.onSettle(id))
                    })
                  }
                />
                {snoozePresets(Date.now()).map((preset) => (
                  <MenuItem
                    key={preset.label}
                    title={
                      multiple ? `${preset.label} · ${threadCount(active.length)}` : preset.label
                    }
                    icon={<Clock3 size={13} aria-hidden />}
                    onClick={() =>
                      finish(close, () => {
                        const ids = active.map((entry) => entry.session.id)
                        if (multiple && props.actions.onSnoozeMany) {
                          props.actions.onSnoozeMany(ids, preset.at)
                        } else {
                          ids.forEach((id) => props.actions.onSnooze(id, preset.at))
                        }
                      })
                    }
                  />
                ))}
              </>
            ) : null}
            {snoozed.length > 0 ? (
              <MenuItem
                title={multiple ? `Wake ${threadCount(snoozed.length)}` : 'Wake now'}
                icon={<Bell size={13} aria-hidden />}
                onClick={() =>
                  finish(close, () => {
                    const ids = snoozed.map((entry) => entry.session.id)
                    if (multiple && props.actions.onUnsnoozeMany) props.actions.onUnsnoozeMany(ids)
                    else ids.forEach((id) => props.actions.onUnsnooze(id))
                  })
                }
              />
            ) : null}
            {settled.length > 0 ? (
              <MenuItem
                title={multiple ? `Un-settle ${threadCount(settled.length)}` : 'Un-settle'}
                icon={<CheckCheck size={13} aria-hidden />}
                onClick={() =>
                  finish(close, () => {
                    const ids = settled.map((entry) => entry.session.id)
                    if (multiple && props.actions.onUnsettleMany) props.actions.onUnsettleMany(ids)
                    else ids.forEach((id) => props.actions.onUnsettle(id))
                  })
                }
              />
            ) : null}
            {!multiple ? (
              <>
                {lifecycle && canHide(props.entry.session) ? (
                  <MenuItem
                    title={lifecycle.keepActive ? 'Allow auto-settle' : 'Keep active'}
                    icon={
                      lifecycle.keepActive ? (
                        <Clock3 size={13} aria-hidden />
                      ) : (
                        <Pin size={13} aria-hidden />
                      )
                    }
                    onClick={() =>
                      finish(close, () =>
                        props.actions.onKeepActive(props.entry.session.id, !lifecycle.keepActive),
                      )
                    }
                  />
                ) : null}
                <div className="menu__rule" />
                <MenuItem
                  title="Rename"
                  icon={<Pencil size={13} aria-hidden />}
                  onClick={() => finish(close, props.onRename)}
                />
                <MenuItem
                  title={props.entry.session.pinned ? 'Unpin thread' : 'Pin thread'}
                  icon={
                    props.entry.session.pinned ? (
                      <PinOff size={13} aria-hidden />
                    ) : (
                      <Pin size={13} aria-hidden />
                    )
                  }
                  onClick={() => finish(close, props.onTogglePin)}
                />
                {props.onChooseImage ? (
                  <MenuItem
                    title={props.entry.session.image ? 'Replace image' : 'Add thread image'}
                    icon={
                      props.entry.session.image ? (
                        <Photo size={13} aria-hidden />
                      ) : (
                        <PhotoPlus size={13} aria-hidden />
                      )
                    }
                    onClick={() =>
                      finish(close, () => props.onChooseImage?.(props.entry.session.id))
                    }
                  />
                ) : null}
                {props.onRemoveImage && props.entry.session.image ? (
                  <MenuItem
                    title="Remove image"
                    icon={<PhotoOff size={13} aria-hidden />}
                    onClick={() =>
                      finish(close, () => props.onRemoveImage?.(props.entry.session.id))
                    }
                  />
                ) : null}
                <MenuItem
                  title="Copy project path"
                  icon={<Copy size={13} aria-hidden />}
                  onClick={() => finish(close, () => void copyText(props.entry.project.path))}
                />
                {props.entry.session.worktreeBranch ? (
                  <MenuItem
                    title="Copy branch"
                    icon={<GitBranch size={13} aria-hidden />}
                    onClick={() =>
                      finish(close, () => void copyText(props.entry.session.worktreeBranch ?? ''))
                    }
                  />
                ) : null}
              </>
            ) : null}
            <div className="menu__rule" />
            <MenuItem
              title={multiple ? `Delete ${props.entries.length} threads` : 'Delete thread'}
              icon={<Trash2 size={13} aria-hidden />}
              className="menu__item--danger"
              onClick={() =>
                finish(close, () => {
                  if (multiple) {
                    props.onArchiveMany(props.entries.map((entry) => entry.session.id))
                  } else {
                    props.onArchive()
                  }
                })
              }
            />
          </>
        )
      }}
    </Menu>
  )
}

const threadMenuTrigger = () => <Ellipsis size={16} aria-hidden />

function Rename(props: { value: string; onCommit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(props.value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.select(), [])
  const commit = () => {
    const next = value.trim()
    if (next) props.onCommit(next)
    else props.onCancel()
  }
  return (
    <input
      ref={ref}
      className="rename rename--chat"
      value={value}
      aria-label={`Rename ${props.value}`}
      onChange={(event) => setValue(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (isComposingKey(event)) return
        if (isConfirmEnter(event)) commit()
        if (event.key === 'Escape') props.onCancel()
      }}
    />
  )
}

/**
 * The time at the end of the title line: how long a running thread has worked,
 * otherwise how long ago its state last changed.
 */
function RowTime(props: { session: Session; now: number }) {
  const since = props.session.statusSince ?? props.session.createdAt
  const running = props.session.status === 'starting' || props.session.status === 'working'
  return (
    <span className="inbox-time">
      {running ? elapsedTime(since, props.now) : relativeTime(since, props.now).replace(' ago', '')}
    </span>
  )
}

type StatusPresentation = {
  label: string
  tone: 'quiet' | 'working' | 'attention' | 'queued' | 'failed' | 'done' | 'woke'
}

function statusPresentation(session: Session, now: number): StatusPresentation {
  const woke = session.lifecycle.state === 'active' && session.lifecycle.wokeAt !== undefined
  if (session.status === 'approval') return { label: 'Approval', tone: 'attention' }
  if (session.status === 'input') return { label: 'Needs input', tone: 'attention' }
  if (session.status === 'failed') return { label: 'Failed', tone: 'failed' }
  if (session.status === 'ready') return { label: 'Done', tone: 'done' }
  if (session.status === 'queued') return { label: 'Queued', tone: 'queued' }
  if (session.status === 'starting' || session.status === 'working') {
    return {
      label: `Working · ${elapsedTime(session.statusSince ?? session.createdAt, now)}`,
      tone: 'working',
    }
  }
  if (woke) return { label: 'Woke', tone: 'woke' }
  return { label: relativeTime(session.statusSince ?? session.createdAt, now), tone: 'quiet' }
}

/** True when a row mounts because its thread just moved group, not because the list loaded. */
function justArrived(session: Session, now: number): boolean {
  const { lifecycle } = session
  const movedAt =
    lifecycle.state === 'settled'
      ? lifecycle.settledAt
      : lifecycle.state === 'snoozed'
        ? lifecycle.snoozedAt
        : lifecycle.wokeAt
  return movedAt !== undefined && now - movedAt >= 0 && now - movedAt < ARRIVAL_WINDOW_MS
}

function canHide(session: Session): boolean {
  return !['starting', 'working', 'queued', 'approval', 'input'].includes(session.status)
}

function threadCount(count: number): string {
  return `${count} ${count === 1 ? 'thread' : 'threads'}`
}

function navigateRows(
  event: KeyboardEvent<HTMLButtonElement>,
  navigate: (direction: -1 | 1) => void,
) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  navigate(event.key === 'ArrowDown' ? 1 : -1)
}

export function retainInboxSelection(
  projects: Project[],
  current: Set<string>,
  scope: string,
  normalizedQuery: string,
): Set<string> {
  let next: Set<string> | undefined
  for (const id of current) {
    const selected = findSession(projects, id)
    const retained =
      selected !== undefined &&
      (!scope || selected.project.path === scope) &&
      (!normalizedQuery || selected.session.title.toLocaleLowerCase().includes(normalizedQuery))
    if (retained) continue
    next ??= new Set(current)
    next.delete(id)
  }
  return next ?? current
}

export function resolveInboxSelection(
  projects: Project[],
  selectedIds: ReadonlySet<string>,
  scope: string,
  normalizedQuery: string,
): Entry[] {
  const selectedEntries: Entry[] = []
  for (const id of selectedIds) {
    const selected = findSession(projects, id)
    if (!selected || (scope && selected.project.path !== scope)) continue
    if (normalizedQuery && !selected.session.title.toLocaleLowerCase().includes(normalizedQuery)) {
      continue
    }
    selectedEntries.push({ project: projectMetadata(selected.project), session: selected.session })
  }
  return selectedEntries
}

type InboxGroup = 'active' | 'snoozed' | 'settled'
type SessionChange = { project: Project; session: Session }

/**
 * Retains globally sorted inbox groups when immutable project updates replace
 * only a few chat rows. This is the normal many-thread status-push path.
 */
export function createInboxEntryClassifier(): typeof classifyInboxEntries {
  let previousProjects: Project[] | undefined
  let previousScope = ''
  let previousQuery = ''
  let previousResult: InboxEntryGroups | undefined
  let entriesById = new Map<string, Entry>()
  let sourceOrder = new Map<string, number>()

  const rebuild = (projects: Project[], scope: string, query: string): InboxEntryGroups => {
    const result = classifyInboxEntries(projects, scope, query)
    previousProjects = projects
    previousScope = scope
    previousQuery = query
    previousResult = result
    entriesById = new Map(result.ordered.map((entry) => [entry.session.id, entry]))
    sourceOrder = new Map()
    let order = 0
    for (const project of projects) {
      for (const session of project.sessions) sourceOrder.set(session.id, order++)
    }
    return result
  }

  return (projects, scope, query) => {
    if (
      !previousProjects ||
      !previousResult ||
      scope !== previousScope ||
      query !== previousQuery
    ) {
      return rebuild(projects, scope, query)
    }
    if (projects === previousProjects) return previousResult
    if (projects.length !== previousProjects.length) return rebuild(projects, scope, query)

    const changes: SessionChange[] = []
    const exactChanges = takeProjectSessionChanges(previousProjects, projects)
    if (exactChanges) {
      for (const { projectIndex, sessionIndex } of exactChanges) {
        const project = projects[projectIndex]
        const previousProject = previousProjects[projectIndex]
        const session = project?.sessions[sessionIndex]
        const previousSession = previousProject?.sessions[sessionIndex]
        if (
          !project ||
          !previousProject ||
          !session ||
          !previousSession ||
          project.path !== previousProject.path ||
          project.name !== previousProject.name ||
          project.pinned !== previousProject.pinned ||
          project.sessions.length !== previousProject.sessions.length ||
          session.id !== previousSession.id
        ) {
          return rebuild(projects, scope, query)
        }
        if (session !== previousSession && (!scope || project.path === scope)) {
          changes.push({ project, session })
        }
      }
    } else {
      for (let projectIndex = 0; projectIndex < projects.length; projectIndex += 1) {
        const project = projects[projectIndex]!
        const previousProject = previousProjects[projectIndex]!
        if (project === previousProject) continue
        if (
          project.path !== previousProject.path ||
          project.name !== previousProject.name ||
          project.pinned !== previousProject.pinned ||
          project.sessions.length !== previousProject.sessions.length
        ) {
          return rebuild(projects, scope, query)
        }
        for (let sessionIndex = 0; sessionIndex < project.sessions.length; sessionIndex += 1) {
          const session = project.sessions[sessionIndex]!
          const previousSession = previousProject.sessions[sessionIndex]!
          if (session.id !== previousSession.id) return rebuild(projects, scope, query)
          if (session !== previousSession && (!scope || project.path === scope)) {
            changes.push({ project, session })
            if (changes.length > 32) return rebuild(projects, scope, query)
          }
        }
      }
    }

    previousProjects = projects
    if (changes.length === 0) return previousResult

    let active = previousResult.active
    let snoozed = previousResult.snoozed
    let settled = previousResult.settled
    const writable = (group: InboxGroup): Entry[] => {
      if (group === 'active') {
        if (active === previousResult!.active) active = [...active]
        return active
      }
      if (group === 'snoozed') {
        if (snoozed === previousResult!.snoozed) snoozed = [...snoozed]
        return snoozed
      }
      if (settled === previousResult!.settled) settled = [...settled]
      return settled
    }

    for (const { project, session } of changes) {
      const previousEntry = entriesById.get(session.id)
      const group = inboxGroup(session)
      const included = !query || session.title.toLocaleLowerCase().includes(query)
      if (previousEntry) {
        const previousGroup = inboxGroup(previousEntry.session)
        const entries = writable(previousGroup)
        const index = findInboxEntryIndex(entries, previousEntry, previousGroup, sourceOrder)
        if (
          index >= 0 &&
          included &&
          group === previousGroup &&
          compareInboxEntries({ project, session }, previousEntry, previousGroup, sourceOrder) === 0
        ) {
          const entry = { project: projectMetadata(project), session }
          entries[index] = entry
          entriesById.set(session.id, entry)
          continue
        }
        if (index >= 0) entries.splice(index, 1)
        entriesById.delete(session.id)
      }
      if (!included) continue
      const entry = { project: projectMetadata(project), session }
      insertInboxEntry(writable(group), entry, group, sourceOrder)
      entriesById.set(session.id, entry)
    }

    previousResult = {
      active,
      snoozed,
      settled,
      ordered: [...active, ...snoozed, ...settled],
    }
    return previousResult
  }
}

function findInboxEntryIndex(
  entries: readonly Entry[],
  target: Entry,
  group: InboxGroup,
  sourceOrder: ReadonlyMap<string, number>,
): number {
  let low = 0
  let high = entries.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const compared = compareInboxEntries(target, entries[middle]!, group, sourceOrder)
    if (compared < 0) high = middle - 1
    else if (compared > 0) low = middle + 1
    else return middle
  }
  return -1
}

function inboxGroup(session: Session): InboxGroup {
  return session.lifecycle.state
}

function insertInboxEntry(
  entries: Entry[],
  entry: Entry,
  group: InboxGroup,
  sourceOrder: ReadonlyMap<string, number>,
): void {
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const compared = compareInboxEntries(entry, entries[middle]!, group, sourceOrder)
    if (compared < 0) high = middle
    else low = middle + 1
  }
  entries.splice(low, 0, entry)
}

function compareInboxEntries(
  left: Entry,
  right: Entry,
  group: InboxGroup,
  sourceOrder: ReadonlyMap<string, number>,
): number {
  const compared =
    group === 'active'
      ? newestFirst(left, right)
      : group === 'snoozed'
        ? wakeAt(left.session) - wakeAt(right.session)
        : settledAt(right.session) - settledAt(left.session)
  return (
    compared ||
    (sourceOrder.get(left.session.id) ?? Number.MAX_SAFE_INTEGER) -
      (sourceOrder.get(right.session.id) ?? Number.MAX_SAFE_INTEGER)
  )
}

export function inboxClockDelay(
  hasRunningThread: boolean,
  relativeTimes: readonly number[],
  hasSnoozedThread: boolean,
  now: number,
): number | undefined {
  if (hasRunningThread) return 1_000
  let nextChangeAt = Number.POSITIVE_INFINITY
  for (const timestamp of relativeTimes) {
    if (Number.isFinite(timestamp)) {
      nextChangeAt = Math.min(nextChangeAt, nextRelativeTimeChangeAt(timestamp, now))
    }
  }
  if (hasSnoozedThread) {
    const nextDay = new Date(now)
    nextDay.setHours(24, 0, 0, 0)
    nextChangeAt = Math.min(nextChangeAt, nextDay.getTime())
  }
  return Number.isFinite(nextChangeAt) ? Math.max(1_000, nextChangeAt - now) : undefined
}

function nextRelativeTimeChangeAt(timestamp: number, now: number): number {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1_000))
  if (seconds < 60) return timestamp + 59_500

  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return timestamp + ((minutes + 1) * 60 - 30) * 1_000 - 500

  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    const nextMinutes = (hours + 1) * 60 - 30
    return timestamp + (nextMinutes * 60 - 30) * 1_000 - 500
  }

  const days = Math.round(hours / 24)
  const nextHours = (days + 1) * 24 - 12
  const nextMinutes = nextHours * 60 - 30
  return timestamp + (nextMinutes * 60 - 30) * 1_000 - 500
}

function withSelected(entries: Entry[], selected: Entry | undefined): Entry[] {
  return selected && !entries.some((entry) => entry.session.id === selected.session.id)
    ? [...entries, selected]
    : entries
}

function snoozePresets(now: number): Array<{ label: string; at: number }> {
  return [
    { label: 'In one hour', at: now + 60 * 60 * 1_000 },
    { label: 'This evening', at: thisEvening(now) },
    { label: 'Tomorrow morning', at: tomorrowMorning(now) },
    { label: 'Next week', at: nextWeek(now) },
  ]
}

function thisEvening(now: number): number {
  const next = new Date(now)
  next.setHours(18, 0, 0, 0)
  if (next.getTime() <= now) next.setDate(next.getDate() + 1)
  return next.getTime()
}

function tomorrowMorning(now: number): number {
  const next = new Date(now)
  next.setDate(next.getDate() + 1)
  next.setHours(9, 0, 0, 0)
  return next.getTime()
}

function nextWeek(now: number): number {
  const next = new Date(now)
  const daysUntilMonday = (8 - next.getDay()) % 7 || 7
  next.setDate(next.getDate() + daysUntilMonday)
  next.setHours(9, 0, 0, 0)
  return next.getTime()
}

function formatWakeTime(at: number, now: number): string {
  const target = new Date(at)
  const today = new Date(now)
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const time = target.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (sameDay(target, today)) return `Today · ${time}`
  if (sameDay(target, tomorrow)) return `Tomorrow · ${time}`
  return target.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function elapsedTime(from: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - from) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1_000))
  if (seconds < 60) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function providerName(session: Session): string {
  return sessionSourcePresentation(session.provider, session.agent).label
}

function projectName(project: ProjectMetadata): string {
  return project.name ?? project.path.split(/[\\/]/).filter(Boolean).at(-1) ?? project.path
}

type StaticThreadPresentation = {
  project: ProjectMetadata
  rowLabelPrefix: string
  summaryPrefix: string[]
  created: string
}

const staticThreadPresentations = new WeakMap<Session, StaticThreadPresentation>()

function staticThreadPresentation(
  project: ProjectMetadata,
  session: Session,
): StaticThreadPresentation {
  const cached = staticThreadPresentations.get(session)
  if (cached?.project.path === project.path && cached.project.name === project.name) return cached
  const projectLabel = projectName(project)
  const provider = providerName(session)
  const presentation = {
    project: projectMetadata(project),
    rowLabelPrefix: `${session.title}, ${projectLabel}, ${provider}, ${session.worktreeBranch ?? 'Default checkout'}`,
    summaryPrefix: [
      session.title,
      `Project: ${projectLabel}`,
      `Environment: ${project.path}`,
      `Branch: ${session.worktreeBranch ?? 'default checkout'}`,
      `Provider: ${provider}`,
    ],
    created: `Created: ${new Date(session.createdAt).toLocaleString()}`,
  }
  staticThreadPresentations.set(session, presentation)
  return presentation
}

function rowLabel(project: ProjectMetadata, session: Session, now: number): string {
  const presentation = staticThreadPresentation(project, session)
  return `${presentation.rowLabelPrefix}, ${statusPresentation(session, now).label}`
}

function shelfDetail(session: Session, now: number): string {
  return session.lifecycle.state === 'snoozed'
    ? formatWakeTime(wakeAt(session), now)
    : relativeTime(settledAt(session), now)
}

function shelfRowLabel(project: ProjectMetadata, session: Session, now: number): string {
  const presentation = staticThreadPresentation(project, session)
  const when =
    session.lifecycle.state === 'snoozed'
      ? `back ${shelfDetail(session, now)}`
      : `finished ${shelfDetail(session, now)}`
  return `${presentation.rowLabelPrefix}, ${when}`
}

function threadSummary(project: ProjectMetadata, session: Session, now: number): string {
  const lifecycle =
    session.lifecycle.state === 'active'
      ? 'Active'
      : session.lifecycle.state === 'snoozed'
        ? `Snoozed until ${formatWakeTime(session.lifecycle.wakeAt, now)}`
        : `Settled ${relativeTime(session.lifecycle.settledAt, now)}`
  const presentation = staticThreadPresentation(project, session)
  return [
    ...presentation.summaryPrefix,
    `Status: ${statusPresentation(session, now).label}`,
    `Lifecycle: ${lifecycle}`,
    presentation.created,
  ].join('\n')
}

async function copyText(value: string): Promise<void> {
  try {
    await writeClipboardText(value)
  } catch {
    // Clipboard permission errors leave the menu action as a no-op.
  }
}
