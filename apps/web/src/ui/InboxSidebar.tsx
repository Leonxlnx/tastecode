import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import '../styles/inbox-sidebar.css'
import type { SearchSnippetPart, SessionSearchResult } from '@harness/contracts'
import {
  IconArrowBackUp as Undo,
  IconEdit as SquarePen,
  IconFolderPlus as FolderPlus,
  IconPlus as Plus,
  IconSearch as Search,
  IconX as X,
} from '@tabler/icons-react'
import { isMacOS, writeClipboardText } from '../bridge.js'
import { performAppHaptic, prepareAppHaptics } from '../haptics.js'
import { findSession, takeProjectSessionChanges } from '../project-store.js'
import { DEFAULT_KEYBINDINGS, shortcutLabel, type Keybindings } from '../shortcuts.js'
import { canHide, type Entry } from './inbox-entry.js'
import { useListMotion } from './inbox-sidebar-motion.js'
import { InboxClock, useRetainedNumberArray } from './InboxSidebarClock.js'
import { CustomSnoozeDialog, ProjectScopeMenu, type ThreadCommands } from './InboxSidebarMenus.js'
import {
  activityAt,
  SearchResultRow,
  searchResultId,
  ThreadCard,
  ThreadRow,
  wakeAt,
} from './InboxSidebarRows.js'
import { projectName } from './ProjectMark.js'
import type { Project, Session } from './Sidebar.js'

export type { Entry } from './inbox-entry.js'
export { inboxClockDelay } from './inbox-sidebar-time.js'

type InboxEntryGroups = { active: Entry[]; snoozed: Entry[]; settled: Entry[]; ordered: Entry[] }
const PAGE_SIZE = 25
const INITIAL_ACTIVE_LIMIT = 12
const INITIAL_SHELF_LIMIT = 10
const MAX_SEARCH_RESULTS = 100
const MESSAGE_SEARCH_MIN_LENGTH = 2
const MESSAGE_SEARCH_DEBOUNCE_MS = 200
const UNDO_WINDOW_MS = 5_000
const JUMP_HINT_DELAY_MS = 200
const ACTIVE_PAGE_IDLE_TIMEOUT_MS = 500
const ACTIVE_PAGE_FALLBACK_DELAY_MS = 100
const NARROW_VIEWPORT_QUERY = '(max-width: 700px)'

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

/** Server-side message search. Titles match locally; this adds threads whose text matches. */
export type InboxMessageSearch = (
  query: string,
  projectPath: string | undefined,
) => Promise<SessionSearchResult[]>

type MessageMatch = { turnId: string; snippet: SearchSnippetPart[] }
type ThreadSection = 'pinned' | 'active' | 'snoozed' | 'settled'
type DropSection = 'pinned' | 'active' | 'settled'
type ThreadDrag = { id: string; from: ThreadSection; hideable: boolean }
const THREAD_DRAG_TYPE = 'application/x-tastecode-thread'
type UndoVerb = 'Settled' | 'Snoozed' | 'Unpinned'
type UndoNotice = { key: number; verb: UndoVerb; ids: string[]; revert: () => void }

type InboxSidebarProps = {
  projects: Project[]
  scope: string
  activeProjectPath: string | undefined
  activeSessionId: string | undefined
  actions: InboxActions
  keybindings?: Keybindings | undefined
  onScopeChange: (path: string) => void
  onAddProject: () => void
  onNewSession: (preferredPath?: string, chooseProject?: boolean) => void
  onSelectSession: (id: string) => void
  onRenameSession: (id: string, title: string) => void
  onToggleSessionPin?: ((id: string) => void) | undefined
  onArchiveSession: (id: string) => void
  onArchiveSessions?: ((ids: string[]) => void) | undefined
  onSearchMessages?: InboxMessageSearch | undefined
  onOpenSearchResult?: ((threadId: string, turnId: string) => void) | undefined
  /** Visible thread order for ⌘1–9 and chat cycling; undefined once the list unmounts. */
  onOrderChange?: ((ids: readonly string[] | undefined) => void) | undefined
  /** The rail's utility row, rendered here so it loads with this module's styles. */
  footer?: ReactNode
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

/**
 * The thread sidebar: every chat across projects in one list, pinned and
 * active work as cards, snoozed and settled work as quiet rows below.
 */
function InboxSidebarComponent(props: InboxSidebarProps) {
  const [query, setQuery] = useState('')
  const [activeLimit, setActiveLimit] = useState(INITIAL_ACTIVE_LIMIT)
  const [snoozedLimit, setSnoozedLimit] = useState(INITIAL_SHELF_LIMIT)
  const [settledLimit, setSettledLimit] = useState(INITIAL_SHELF_LIMIT)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [selectionAnchor, setSelectionAnchor] = useState<string>()
  const [eagerRowActions, setEagerRowActions] = useState(
    () => globalThis.matchMedia?.(NARROW_VIEWPORT_QUERY).matches ?? false,
  )
  const [customSnoozeIds, setCustomSnoozeIds] = useState<string[]>()
  const [undoNotice, setUndoNotice] = useState<UndoNotice>()
  const [drag, setDrag] = useState<ThreadDrag>()
  const [dropTarget, setDropTarget] = useState<DropSection>()
  const rowRefs = useRef(new Map<string, HTMLElement>())
  const listRef = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const keybindings = props.keybindings ?? DEFAULT_KEYBINDINGS
  const macOS = isMacOS()

  useEffect(() => {
    const media = globalThis.matchMedia?.(NARROW_VIEWPORT_QUERY)
    if (!media) return
    const onChange = (event: MediaQueryListEvent) => setEagerRowActions(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  // Memoised because the parent still commits during streaming. The lifecycle
  // list only needs to be rebuilt when its actual inputs change.
  const classifyEntries = useMemo(createInboxEntryClassifier, [])
  const {
    active: activeEntries,
    snoozed,
    settled,
  } = useMemo(
    () => classifyEntries(props.projects, props.scope, ''),
    [classifyEntries, props.projects, props.scope],
  )
  const { pinned, active } = useMemo(() => splitPinned(activeEntries), [activeEntries])

  const selectedEntry = useMemo(() => {
    const selected = findSession(props.projects, props.activeSessionId)
    if (!selected || (props.scope && selected.project.path !== props.scope)) return undefined
    return selected
  }, [props.activeSessionId, props.projects, props.scope])
  const selectedState = selectedEntry?.session.lifecycle.state
  const selectedPinned = selectedEntry?.session.pinned === true
  const visibleActive = withSelected(
    active.slice(0, activeLimit),
    selectedState === 'active' && !selectedPinned ? selectedEntry : undefined,
  )
  const visibleSnoozed = withSelected(
    snoozed.slice(0, snoozedLimit),
    selectedState === 'snoozed' ? selectedEntry : undefined,
  )
  const visibleSettled = withSelected(
    settled.slice(0, settledLimit),
    selectedState === 'settled' ? selectedEntry : undefined,
  )
  const activePageDeferred =
    activeLimit === INITIAL_ACTIVE_LIMIT && active.length > INITIAL_ACTIVE_LIMIT

  useEffect(() => {
    setActiveLimit(INITIAL_ACTIVE_LIMIT)
    setSnoozedLimit(INITIAL_SHELF_LIMIT)
    setSettledLimit(INITIAL_SHELF_LIMIT)
    setSelectedIds((current) => (current.size === 0 ? current : new Set()))
  }, [props.scope])
  useEffect(() => {
    if (!activePageDeferred) return
    return scheduleIdle(() => setActiveLimit((limit) => Math.max(limit, PAGE_SIZE)))
  }, [activePageDeferred])
  useEffect(() => {
    if (selectedIds.size === 0) return
    setSelectedIds((current) => retainInboxSelection(props.projects, current, props.scope, ''))
  }, [props.projects, props.scope, selectedIds.size])

  // Rows in the order they render; keyboard, range selection, and ⌘1–9 all walk it.
  const visibleOrder = useMemo(
    () => [...pinned, ...visibleActive, ...visibleSnoozed, ...visibleSettled],
    [pinned, visibleActive, visibleSnoozed, visibleSettled],
  )
  const orderKey = useMemo(
    () =>
      [pinned, visibleActive, visibleSnoozed, visibleSettled]
        .map((group) => group.map((entry) => entry.session.id).join(','))
        .join('|'),
    [pinned, visibleActive, visibleSnoozed, visibleSettled],
  )
  const orderedIds = useMemo(() => orderKey.split(/[,|]/).filter(Boolean), [orderKey])
  useEffect(() => props.onOrderChange?.(orderedIds), [orderedIds, props.onOrderChange])
  useEffect(() => {
    const notify = props.onOrderChange
    return () => notify?.(undefined)
  }, [props.onOrderChange])
  useListMotion(listRef, orderKey)

  const selectedEntries = useMemo(
    () =>
      selectedIds.size > 1
        ? resolveInboxSelection(props.projects, selectedIds, props.scope, '')
        : [],
    [props.projects, props.scope, selectedIds],
  )

  // --- search -------------------------------------------------------------
  const deferredQuery = useDeferredValue(query)
  const normalizedQuery = deferredQuery.trim().toLocaleLowerCase()
  const searching = normalizedQuery.length > 0
  const messageSearch = useMessageSearch(props.onSearchMessages, normalizedQuery, props.scope)
  const searchResults = useMemo(() => {
    if (!searching) return []
    const results: Entry[] = []
    for (const group of [pinned, active, snoozed, settled]) {
      for (const entry of group) {
        if (results.length >= MAX_SEARCH_RESULTS) return results
        if (
          entry.session.title.toLocaleLowerCase().includes(normalizedQuery) ||
          projectName(entry.project).toLocaleLowerCase().includes(normalizedQuery) ||
          messageSearch.matches.has(entry.session.id)
        ) {
          results.push(entry)
        }
      }
    }
    return results
  }, [active, messageSearch.matches, normalizedQuery, pinned, searching, settled, snoozed])
  const [highlight, setHighlight] = useState(0)
  useEffect(() => setHighlight(0), [normalizedQuery])
  const highlighted = Math.min(highlight, Math.max(0, searchResults.length - 1))
  useLayoutEffect(() => {
    if (!searching) return
    document.getElementById(searchResultId(highlighted))?.scrollIntoView?.({ block: 'nearest' })
  }, [highlighted, searching])

  // --- clock --------------------------------------------------------------
  const hasRunningThread = [...pinned, ...visibleActive].some(({ session }) =>
    ['starting', 'working'].includes(session.status),
  )
  const nextRelativeTimes: number[] = []
  for (const { session } of [...pinned, ...visibleActive]) {
    const woke = session.lifecycle.state === 'active' && session.lifecycle.wokeAt !== undefined
    if (session.status === 'idle' && !session.unread && !woke) {
      nextRelativeTimes.push(activityAt(session))
    }
  }
  for (const { session } of visibleSettled) {
    if (session.lifecycle.state === 'settled') nextRelativeTimes.push(session.lifecycle.settledAt)
  }
  if (searching) {
    for (const { session } of searchResults) nextRelativeTimes.push(activityAt(session))
  }
  const relativeTimes = useRetainedNumberArray(nextRelativeTimes)
  const wakeTimes = useRetainedNumberArray(visibleSnoozed.map(({ session }) => wakeAt(session)))

  // --- commands -----------------------------------------------------------
  const live = useRef({ props, visibleOrder, selectedIds, selectionAnchor })
  live.current = { props, visibleOrder, selectedIds, selectionAnchor }

  const recordUndo = useCallback((verb: UndoVerb, ids: string[], revert: () => void) => {
    setUndoNotice((current) =>
      current?.verb === verb
        ? {
            key: current.key + 1,
            verb,
            ids: [...new Set([...current.ids, ...ids])],
            revert: () => {
              current.revert()
              revert()
            },
          }
        : { key: (current?.key ?? 0) + 1, verb, ids, revert },
    )
  }, [])

  const commands = useMemo<ThreadCommands>(() => {
    const entryOf = (id: string) => findSession(live.current.props.projects, id)
    const clearSelection = () => setSelectedIds((current) => (current.size ? new Set() : current))
    const settleIds = (ids: string[]) => {
      const { actions } = live.current.props
      if (ids.length > 1 && actions.onSettleMany) actions.onSettleMany(ids)
      else ids.forEach((id) => actions.onSettle(id))
    }
    const unsettleIds = (ids: string[]) => {
      const { actions } = live.current.props
      if (ids.length > 1 && actions.onUnsettleMany) actions.onUnsettleMany(ids)
      else ids.forEach((id) => actions.onUnsettle(id))
    }
    const unsnoozeIds = (ids: string[]) => {
      const { actions } = live.current.props
      if (ids.length > 1 && actions.onUnsnoozeMany) actions.onUnsnoozeMany(ids)
      else ids.forEach((id) => actions.onUnsnooze(id))
    }
    const togglePins = (ids: string[]) => {
      for (const id of ids) live.current.props.onToggleSessionPin?.(id)
    }
    return {
      choose: (event, id) => {
        const { visibleOrder, selectionAnchor } = live.current
        if (event.shiftKey && selectionAnchor) {
          const from = visibleOrder.findIndex((entry) => entry.session.id === selectionAnchor)
          const to = visibleOrder.findIndex((entry) => entry.session.id === id)
          if (from >= 0 && to >= 0) {
            const [start, end] = from < to ? [from, to] : [to, from]
            setSelectedIds(
              new Set(visibleOrder.slice(start, end + 1).map((entry) => entry.session.id)),
            )
            return
          }
        }
        if (event.metaKey || event.ctrlKey) {
          setSelectedIds((current) => {
            const next = new Set(current)
            if (next.size === 0 && live.current.props.activeSessionId) {
              next.add(live.current.props.activeSessionId)
            }
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
          setSelectionAnchor(id)
          return
        }
        clearSelection()
        setSelectionAnchor(id)
        live.current.props.onSelectSession(id)
      },
      prepareContextMenu: (id) => {
        if (live.current.selectedIds.has(id)) return
        clearSelection()
        setSelectionAnchor(id)
      },
      register: (id, node) => {
        if (node) rowRefs.current.set(id, node)
        else rowRefs.current.delete(id)
      },
      navigate: (id, direction) => {
        const { visibleOrder } = live.current
        const index = visibleOrder.findIndex((entry) => entry.session.id === id)
        if (index < 0) return
        for (let offset = 1; offset <= visibleOrder.length; offset += 1) {
          const next =
            visibleOrder[(index + direction * offset + visibleOrder.length) % visibleOrder.length]
          const node = next ? rowRefs.current.get(next.session.id) : undefined
          if (node) {
            node.focus()
            return
          }
        }
      },
      clearSelection,
      rename: (id, title) => live.current.props.onRenameSession(id, title),
      settle: (ids) => {
        const targets = ids.filter((id) => {
          const entry = entryOf(id)
          return entry?.session.lifecycle.state === 'active' && canHide(entry.session)
        })
        if (targets.length === 0) return
        settleIds(targets)
        recordUndo('Settled', targets, () => unsettleIds(targets))
        clearSelection()
      },
      unsettle: (ids) => {
        unsettleIds(ids)
        clearSelection()
      },
      snooze: (ids, at) => {
        const targets = ids.filter((id) => {
          const entry = entryOf(id)
          return entry !== undefined && canHide(entry.session)
        })
        if (targets.length === 0) return
        const { actions } = live.current.props
        if (targets.length > 1 && actions.onSnoozeMany) actions.onSnoozeMany(targets, at)
        else targets.forEach((id) => actions.onSnooze(id, at))
        recordUndo('Snoozed', targets, () => unsnoozeIds(targets))
        clearSelection()
      },
      customSnooze: (ids) => setCustomSnoozeIds(ids),
      wake: (ids) => {
        unsnoozeIds(ids)
        clearSelection()
      },
      togglePin: (id) => {
        const pinnedBefore = entryOf(id)?.session.pinned === true
        togglePins([id])
        if (pinnedBefore) recordUndo('Unpinned', [id], () => togglePins([id]))
      },
      unpin: (ids) => {
        const targets = ids.filter((id) => entryOf(id)?.session.pinned === true)
        if (targets.length === 0) return
        togglePins(targets)
        recordUndo('Unpinned', targets, () => togglePins(targets))
        clearSelection()
      },
      keepActive: (id, keepActive) => live.current.props.actions.onKeepActive(id, keepActive),
      archive: (ids) => {
        const { onArchiveSession, onArchiveSessions } = live.current.props
        if (ids.length > 1 && onArchiveSessions) onArchiveSessions(ids)
        else ids.forEach((id) => onArchiveSession(id))
        clearSelection()
      },
      scope: (path) => live.current.props.onScopeChange(path),
      copy: (text) => void writeClipboardText(text).catch(() => undefined),
      dragStart: (event, id) => {
        const entry = entryOf(id)
        if (!entry || event.target !== event.currentTarget) return
        prepareAppHaptics()
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(THREAD_DRAG_TYPE, id)
        setDrag({ id, from: threadSection(entry.session), hideable: canHide(entry.session) })
      },
      dragEnd: () => {
        setDrag(undefined)
        setDropTarget(undefined)
      },
    }
  }, [recordUndo])

  /** Dropping on a section does what moving there means: pin, unpin, settle, un-settle, or wake. */
  const dropOn = (section: DropSection) => {
    if (!drag || !canDrop(drag, section)) return
    const { id, from } = drag
    setDrag(undefined)
    setDropTarget(undefined)
    if (section === 'pinned' || (section === 'active' && from === 'pinned')) {
      commands.togglePin(id)
    } else if (section === 'settled') commands.settle([id])
    else if (from === 'snoozed') commands.wake([id])
    else if (from === 'settled') commands.unsettle([id])
  }
  const dropZone = (section: DropSection) =>
    drag && canDrop(drag, section)
      ? {
          onDragOver: (event: DragEvent<HTMLElement>) => {
            if (!event.dataTransfer.types.includes(THREAD_DRAG_TYPE)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            if (dropTarget !== section) {
              setDropTarget(section)
              performAppHaptic('alignment')
            }
          },
          onDragLeave: (event: DragEvent<HTMLElement>) => {
            const next = event.relatedTarget
            if (next instanceof Node && event.currentTarget.contains(next)) return
            setDropTarget((current) => (current === section ? undefined : current))
          },
          onDrop: (event: DragEvent<HTMLElement>) => {
            event.preventDefault()
            dropOn(section)
          },
        }
      : {}
  const zoneClass = (section: DropSection) =>
    drag && canDrop(drag, section)
      ? ` is-drop-zone${dropTarget === section ? ' is-drop-target' : ''}`
      : ''

  const undo = useCallback(() => {
    setUndoNotice((current) => {
      current?.revert()
      return undefined
    })
  }, [])

  useEffect(() => {
    if (!undoNotice) return
    const timer = window.setTimeout(() => setUndoNotice(undefined), UNDO_WINDOW_MS)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.shiftKey) return
      if (!(macOS ? event.metaKey : event.ctrlKey) || event.key.toLocaleLowerCase() !== 'z') return
      if (isTextTarget(event.target)) return
      event.preventDefault()
      undo()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [macOS, undo, undoNotice])

  // --- ⌘1–9 hints (the app owns the shortcut and reads onOrderChange) --------
  const jumpHintsVisible = useJumpHints(macOS)
  const jumpLabels = useMemo(() => {
    if (!jumpHintsVisible) return undefined
    const labels = new Map<string, string>()
    visibleOrder.slice(0, 9).forEach((entry, index) => {
      labels.set(entry.session.id, shortcutLabel({ key: String(index + 1), primary: true }, macOS))
    })
    return labels
  }, [jumpHintsVisible, macOS, visibleOrder])

  // --- header -------------------------------------------------------------
  const preferredProject =
    props.scope ||
    props.activeProjectPath ||
    (props.projects.length === 1 ? props.projects[0]?.path : '')
  const newThread = (inCurrentProject: boolean) => {
    if (props.projects.length === 0) props.onAddProject()
    else if (inCurrentProject) props.onNewSession(preferredProject || undefined, false)
    else props.onNewSession(preferredProject || undefined, props.projects.length > 1)
  }
  const newThreadShortcut = keybindings.newChat ? shortcutLabel(keybindings.newChat, macOS) : ''
  const newThreadTitle = [
    newThreadShortcut ? `New thread (${newThreadShortcut})` : 'New thread',
    props.projects.length > 1 ? 'Shift-click: new thread in the current project' : undefined,
  ]
    .filter(Boolean)
    .join('\n')

  const clearSearch = () => {
    setQuery('')
    searchInput.current?.focus()
  }
  const openResult = (index: number) => {
    const entry = searchResults[index]
    if (!entry) return
    const match = messageSearch.matches.get(entry.session.id)
    setQuery('')
    if (match && props.onOpenSearchResult) props.onOpenSearchResult(entry.session.id, match.turnId)
    else props.onSelectSession(entry.session.id)
  }
  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && query) {
      event.preventDefault()
      event.stopPropagation()
      setQuery('')
      return
    }
    if (!searching) {
      if (event.key === 'ArrowDown') {
        const first = visibleOrder[0]
        const node = first ? rowRefs.current.get(first.session.id) : undefined
        if (node) {
          event.preventDefault()
          node.focus()
        }
      }
      return
    }
    if (searchResults.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setHighlight((highlighted + step + searchResults.length) % searchResults.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      openResult(highlighted)
    }
  }

  const hasThreads = pinned.length + active.length + snoozed.length + settled.length > 0
  const scopedProject = props.scope
    ? props.projects.find((project) => project.path === props.scope)
    : undefined
  const resultsVisible = searching && searchResults.length > 0
  const rowProps = (entry: Entry) => {
    const selected = selectedIds.has(entry.session.id)
    return {
      ...entry,
      current: entry.session.id === props.activeSessionId,
      selected,
      eagerActions: eagerRowActions,
      menuEntries: selected && selectedIds.size > 1 ? selectedEntries : undefined,
      scope: props.scope,
      jumpLabel: jumpLabels?.get(entry.session.id),
      commands,
    }
  }

  return (
    <InboxClock
      hasRunningThread={hasRunningThread}
      relativeTimes={relativeTimes}
      wakeTimes={wakeTimes}
    >
      <div className="thread-rail__head">
        <label className="thread-search">
          <Search size={15} aria-hidden />
          <input
            ref={searchInput}
            value={query}
            placeholder="Search"
            aria-label="Search threads"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={resultsVisible}
            aria-controls={resultsVisible ? 'thread-search-results' : undefined}
            aria-activedescendant={resultsVisible ? searchResultId(highlighted) : undefined}
            spellCheck={false}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onSearchKeyDown}
          />
          {query ? (
            <button type="button" aria-label="Clear thread search" onClick={clearSearch}>
              <X size={12} aria-hidden />
            </button>
          ) : null}
        </label>
        <div className="thread-rail__tools">
          {props.projects.length > 0 ? (
            <>
              <ProjectScopeMenu
                projects={props.projects}
                scope={props.scope}
                onScopeChange={props.onScopeChange}
              />
              <button
                type="button"
                className="thread-rail__icon"
                aria-label="New project"
                title="New project"
                onClick={props.onAddProject}
              >
                <FolderPlus size={16} aria-hidden />
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="thread-rail__icon"
            aria-label="New thread"
            title={newThreadTitle}
            onClick={(event) => newThread(event.shiftKey)}
          >
            <SquarePen size={16} aria-hidden />
          </button>
        </div>
      </div>

      <div className="rail__body thread-rail__body">
        {searching ? (
          searchResults.length > 0 ? (
            <ul className="thread-results" id="thread-search-results" role="listbox">
              {searchResults.map((entry, index) => (
                <SearchResultRow
                  key={entry.session.id}
                  entry={entry}
                  index={index}
                  highlighted={index === highlighted}
                  current={entry.session.id === props.activeSessionId}
                  snippet={messageSearch.matches.get(entry.session.id)?.snippet}
                  onHighlight={setHighlight}
                  onOpen={openResult}
                />
              ))}
            </ul>
          ) : (
            <p className="thread-empty" role="status">
              {messageSearch.pending ? 'Searching thread messages…' : 'No threads found'}
            </p>
          )
        ) : (
          <div className={`thread-list${drag ? ' is-dragging' : ''}`} ref={listRef}>
            {pinned.length > 0 || (drag && canDrop(drag, 'pinned')) ? (
              <div className={`thread-zone${zoneClass('pinned')}`} {...dropZone('pinned')}>
                {drag ? <p className="thread-zone__label">Pinned</p> : null}
                {pinned.length > 0 ? (
                  <ul className="thread-list__group" aria-label="Pinned threads">
                    {pinned.map((entry) => (
                      <ThreadCard key={entry.session.id} {...rowProps(entry)} />
                    ))}
                  </ul>
                ) : (
                  <p className="thread-zone__empty">Drop to pin</p>
                )}
              </div>
            ) : null}
            {visibleActive.length > 0 || (drag && canDrop(drag, 'active')) ? (
              <div className={`thread-zone${zoneClass('active')}`} {...dropZone('active')}>
                {drag ? <p className="thread-zone__label">Active</p> : null}
                {visibleActive.length > 0 ? (
                  <ul className="thread-list__group" aria-label="Active threads">
                    {visibleActive.map((entry) => (
                      <ThreadCard key={entry.session.id} {...rowProps(entry)} />
                    ))}
                    {active.length > activeLimit && !activePageDeferred ? (
                      <ShowMore
                        count={Math.min(PAGE_SIZE, active.length - activeLimit)}
                        onClick={() => setActiveLimit((limit) => limit + PAGE_SIZE)}
                      />
                    ) : null}
                  </ul>
                ) : (
                  <p className="thread-zone__empty">Drop to make active</p>
                )}
              </div>
            ) : null}
            {!hasThreads ? (
              <div className="thread-empty">
                {props.projects.length === 0 ? (
                  <>
                    <p>No projects yet</p>
                    <button
                      type="button"
                      className="thread-empty__action"
                      onClick={props.onAddProject}
                    >
                      <Plus size={14} aria-hidden />
                      <span>Add project</span>
                    </button>
                  </>
                ) : scopedProject ? (
                  <p>No threads in {projectName(scopedProject)} yet</p>
                ) : (
                  <p>No threads yet</p>
                )}
              </div>
            ) : null}
            {snoozed.length > 0 ? (
              <section className="thread-shelf thread-shelf--snoozed" aria-label="Snoozed threads">
                <h3 className="thread-shelf__head">
                  <span>Snoozed</span>
                  <span className="thread-shelf__count">{snoozed.length}</span>
                  <span className="thread-shelf__rule" aria-hidden />
                </h3>
                <ul className="thread-list__group">
                  {visibleSnoozed.map((entry) => (
                    <ThreadRow key={entry.session.id} {...rowProps(entry)} />
                  ))}
                  {snoozed.length > snoozedLimit ? (
                    <ShowMore
                      count={Math.min(PAGE_SIZE, snoozed.length - snoozedLimit)}
                      onClick={() => setSnoozedLimit((limit) => limit + PAGE_SIZE)}
                    />
                  ) : null}
                </ul>
              </section>
            ) : null}
            {settled.length > 0 || (drag && canDrop(drag, 'settled')) ? (
              <section
                className={`thread-shelf thread-zone${zoneClass('settled')}`}
                aria-label="Settled threads"
                {...dropZone('settled')}
              >
                <h3 className="thread-shelf__head">
                  <span>Settled</span>
                  <span className="thread-shelf__count">{settled.length}</span>
                  <span className="thread-shelf__rule" aria-hidden />
                </h3>
                {settled.length === 0 ? <p className="thread-zone__empty">Drop to settle</p> : null}
                <ul className="thread-list__group">
                  {visibleSettled.map((entry) => (
                    <ThreadRow key={entry.session.id} {...rowProps(entry)} />
                  ))}
                  {settled.length > settledLimit ? (
                    <ShowMore
                      count={Math.min(PAGE_SIZE, settled.length - settledLimit)}
                      onClick={() => setSettledLimit((limit) => limit + PAGE_SIZE)}
                    />
                  ) : null}
                </ul>
              </section>
            ) : null}
          </div>
        )}
      </div>

      {undoNotice ? (
        <div className="thread-undo" role="status" key={undoNotice.key}>
          <span>
            {undoNotice.verb} {undoNotice.ids.length}{' '}
            {undoNotice.ids.length === 1 ? 'thread' : 'threads'}
          </span>
          <button type="button" onClick={undo}>
            <Undo size={13} aria-hidden />
            <span>Undo</span>
            <kbd>{shortcutLabel({ key: 'z', primary: true }, macOS)}</kbd>
          </button>
        </div>
      ) : null}

      {props.footer}

      {customSnoozeIds ? (
        <CustomSnoozeDialog
          count={customSnoozeIds.length}
          onClose={() => setCustomSnoozeIds(undefined)}
          onSnooze={(at) => {
            commands.snooze(customSnoozeIds, at)
            setCustomSnoozeIds(undefined)
          }}
        />
      ) : null}
    </InboxClock>
  )
}

/** Skip unrelated shell commits when every inbox input keeps its identity. */
export const InboxSidebar = memo(InboxSidebarComponent)

function ShowMore(props: { count: number; onClick: () => void }) {
  return (
    <li className="thread-more">
      <button type="button" onClick={props.onClick}>
        <Plus size={14} aria-hidden />
        <span>Show {props.count} more</span>
      </button>
    </li>
  )
}

/**
 * Holding the primary modifier alone for a moment reveals ⌘1–9 badges on the
 * first nine visible rows. They stay while a digit is pressed with it.
 */
function useJumpHints(macOS: boolean): boolean {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let timer: number | undefined
    const hide = () => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = undefined
      setVisible(false)
    }
    const primary = macOS ? 'Meta' : 'Control'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === primary) {
        if (event.shiftKey || event.altKey || (macOS ? event.ctrlKey : event.metaKey)) return
        if (timer === undefined) {
          timer = window.setTimeout(() => setVisible(true), JUMP_HINT_DELAY_MS)
        }
        return
      }
      const primaryHeld = macOS ? event.metaKey : event.ctrlKey
      if (primaryHeld && /^[1-9]$/.test(event.key) && !isTerminalTarget(event.target)) return
      hide()
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === primary) hide()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', hide)
    return () => {
      hide()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', hide)
    }
  }, [macOS])

  return visible
}

/** Title hits come from the list itself; message hits wait for a short pause in typing. */
function useMessageSearch(
  search: InboxMessageSearch | undefined,
  query: string,
  scope: string,
): { matches: ReadonlyMap<string, MessageMatch>; pending: boolean } {
  const [state, setState] = useState<{
    key: string
    matches: ReadonlyMap<string, MessageMatch>
  }>({ key: '', matches: new Map() })
  const key = `${scope}\n${query}`
  const enabled = search !== undefined && query.length >= MESSAGE_SEARCH_MIN_LENGTH

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void search(query, scope || undefined)
        .then((results) => {
          if (cancelled) return
          const matches = new Map<string, MessageMatch>()
          for (const result of results) {
            if (!matches.has(result.threadId)) {
              matches.set(result.threadId, { turnId: result.turnId, snippet: result.snippet })
            }
          }
          setState({ key, matches })
        })
        .catch(() => {
          if (!cancelled) setState({ key, matches: new Map() })
        })
    }, MESSAGE_SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [enabled, key, query, scope, search])

  return enabled && state.key === key
    ? { matches: state.matches, pending: false }
    : { matches: EMPTY_MATCHES, pending: enabled }
}

const EMPTY_MATCHES: ReadonlyMap<string, MessageMatch> = new Map()

function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    isTerminalTarget(target)
  )
}

function isTerminalTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.xterm') !== null
}

function threadSection(session: Session): ThreadSection {
  if (session.lifecycle.state !== 'active') return session.lifecycle.state
  return session.pinned ? 'pinned' : 'active'
}

function canDrop(drag: ThreadDrag, section: DropSection): boolean {
  if (section === 'pinned') return drag.from === 'active'
  if (section === 'active') return drag.from !== 'active'
  return (drag.from === 'active' || drag.from === 'pinned') && drag.hideable
}

function splitPinned(entries: Entry[]) {
  const pinned: Entry[] = []
  const active: Entry[] = []
  for (const entry of entries) (entry.session.pinned ? pinned : active).push(entry)
  return { pinned, active }
}

function withSelected(entries: Entry[], selected: Entry | undefined): Entry[] {
  return selected && !entries.some((entry) => entry.session.id === selected.session.id)
    ? [...entries, selected]
    : entries
}

function settledAt(session: Session): number {
  return session.lifecycle.state === 'settled' ? session.lifecycle.settledAt : 0
}

function newestFirst(a: Entry, b: Entry): number {
  return b.session.createdAt - a.session.createdAt
}

export function classifyInboxEntries(
  projects: Project[],
  scope: string,
  normalizedQuery: string,
): InboxEntryGroups {
  const active: Entry[] = []
  const snoozed: Entry[] = []
  const settled: Entry[] = []

  for (const project of projects) {
    if (scope && project.path !== scope) continue
    for (const session of project.sessions) {
      if (normalizedQuery && !session.title.toLocaleLowerCase().includes(normalizedQuery)) continue
      const entry = { project, session }
      if (session.lifecycle.state === 'active') active.push(entry)
      else if (session.lifecycle.state === 'snoozed') snoozed.push(entry)
      else settled.push(entry)
    }
  }

  active.sort(newestFirst)
  snoozed.sort((left, right) => wakeAt(left.session) - wakeAt(right.session))
  settled.sort((left, right) => settledAt(right.session) - settledAt(left.session))
  return { active, snoozed, settled, ordered: [...active, ...snoozed, ...settled] }
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
    selectedEntries.push(selected)
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
          const entry = { project, session }
          entries[index] = entry
          entriesById.set(session.id, entry)
          continue
        }
        if (index >= 0) entries.splice(index, 1)
        entriesById.delete(session.id)
      }
      if (!included) continue
      const entry = { project, session }
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
