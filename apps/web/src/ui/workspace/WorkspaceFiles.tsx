import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ResultOf } from '@harness/contracts'
import {
  IconChevronDown as ChevronDown,
  IconChevronRight as ChevronRight,
  IconFileAlert as FileWarning,
  IconFolder as Folder,
  IconFolderOpen as FolderOpen,
  IconLoader2 as LoaderCircle,
  IconLock as LockKeyhole,
  IconSearch as Search,
  IconRefresh as Refresh,
} from '@tabler/icons-react'
import type { Transport } from '../../transport.js'
import { FileTypeIcon } from '../FileTypeIcon.js'
import { IconMorph } from '../IconMorph.js'
import { Skeleton, SkeletonCode, SkeletonRows, SkeletonStatus } from '../Skeleton.js'
import { indexedTextLine, indexTextLines } from '../text-line-index.js'
import { WorkspaceEmptyState } from './WorkspaceEmptyState.js'

type Entry = ResultOf<'workspace.listDirectory'>['entries'][number]
type FileContents = ResultOf<'workspace.readFile'>
const EMPTY_WORKSPACE_ENTRIES: Entry[] = []
const WORKSPACE_TREE_INDENT = 18
// Name widths for placeholder rows, in pixels: the tree column is narrow and
// percentages of it would all look alike.
const TREE_SKELETON_WIDTHS = [96, 128, 72, 112, 88, 140, 64, 104, 120]

class FileSelectionStore {
  readonly #listeners = new Map<string, Set<() => void>>()
  #selectedPath: string | undefined

  select(path: string | undefined): void {
    const previous = this.#selectedPath
    if (previous === path) return
    this.#selectedPath = path
    this.#emit(previous)
    this.#emit(path)
  }

  selected(path: string): boolean {
    return this.#selectedPath === path
  }

  subscribe(path: string, listener: () => void): () => void {
    let listeners = this.#listeners.get(path)
    if (!listeners) {
      listeners = new Set()
      this.#listeners.set(path, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#listeners.delete(path)
    }
  }

  #emit(path: string | undefined): void {
    if (!path) return
    for (const listener of this.#listeners.get(path) ?? []) listener()
  }
}

export const WorkspaceFiles = memo(function WorkspaceFiles(props: {
  transport: Transport
  projectPath?: string | undefined
  projectName?: string | undefined
  threadId?: string | undefined
}) {
  const [directories, setDirectories] = useState<Map<string, Entry[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [selectedPath, setSelectedPath] = useState<string>()
  const [file, setFile] = useState<FileContents>()
  const [loadingFile, setLoadingFile] = useState(false)
  const [error, setError] = useState<string>()
  const [fileSelection] = useState(() => new FileSelectionStore())
  const directoryGeneration = useRef(0)
  const directoryRequests = useRef(new Map<string, number>())
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const fileGeneration = useRef(0)

  const context = useCallback(
    () => ({
      projectPath: props.projectPath!,
      ...(props.threadId ? { threadId: props.threadId } : {}),
    }),
    [props.projectPath, props.threadId],
  )

  const loadDirectory = useCallback(
    async (directory: string) => {
      if (!props.projectPath) return
      const mine = directoryGeneration.current
      const request = (directoryRequests.current.get(directory) ?? 0) + 1
      directoryRequests.current.set(directory, request)
      const isCurrent = () =>
        directoryGeneration.current === mine && directoryRequests.current.get(directory) === request
      setLoadingDirectories((current) => new Set(current).add(directory))
      try {
        const result = await props.transport.request('workspace.listDirectory', {
          ...context(),
          ...(directory ? { directory } : {}),
        })
        if (isCurrent()) {
          setDirectories((current) => new Map(current).set(directory, result.entries))
        }
      } catch (cause) {
        if (isCurrent()) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      } finally {
        if (isCurrent()) {
          setLoadingDirectories((current) => {
            const next = new Set(current)
            next.delete(directory)
            return next
          })
        }
      }
    },
    [context, props.projectPath, props.transport],
  )

  useEffect(() => {
    directoryGeneration.current += 1
    directoryRequests.current.clear()
    fileGeneration.current += 1
    setDirectories(new Map())
    setLoadingDirectories(new Set())
    setExpanded(new Set(['']))
    fileSelection.select(undefined)
    setSelectedPath(undefined)
    setFile(undefined)
    setError(undefined)
    if (props.projectPath) void loadDirectory('')
    return () => {
      directoryGeneration.current += 1
      fileGeneration.current += 1
    }
  }, [fileSelection, loadDirectory, props.projectPath, props.threadId])

  const toggleDirectory = useCallback(
    (entry: Entry) => {
      if (entry.restricted) return
      const opening = !expanded.has(entry.path)
      setExpanded((current) => {
        const next = new Set(current)
        if (opening) next.add(entry.path)
        else next.delete(entry.path)
        return next
      })
      if (opening) void loadDirectory(entry.path)
    },
    [expanded, loadDirectory],
  )

  const refreshDirectories = useCallback(() => {
    setError(undefined)
    for (const directory of expandedRef.current) void loadDirectory(directory)
  }, [loadDirectory])

  useEffect(() => {
    let refresh: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      refresh ??= setTimeout(() => {
        refresh = undefined
        refreshDirectories()
      }, 200)
    }
    const offEvent = props.transport.on('thread.event', ({ threadId, event }) => {
      if (event.type === 'turn.completed' && (!props.threadId || threadId === props.threadId))
        schedule()
    })
    const offState = props.transport.onState((state) => {
      if (state === 'open') schedule()
    })
    return () => {
      clearTimeout(refresh)
      offEvent()
      offState()
    }
  }, [props.threadId, props.transport, refreshDirectories])

  const selectFile = useCallback(
    async (entry: Entry) => {
      if (!props.projectPath || entry.restricted) return
      const mine = ++fileGeneration.current
      fileSelection.select(entry.path)
      setSelectedPath(entry.path)
      setFile(undefined)
      setLoadingFile(true)
      setError(undefined)
      try {
        const result = await props.transport.request('workspace.readFile', {
          ...context(),
          path: entry.path,
        })
        if (fileGeneration.current === mine) setFile(result)
      } catch (cause) {
        if (fileGeneration.current === mine) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      } finally {
        if (fileGeneration.current === mine) setLoadingFile(false)
      }
    },
    [context, fileSelection, props.projectPath, props.transport],
  )
  const selectTreeFile = useCallback((entry: Entry) => void selectFile(entry), [selectFile])

  const rootEntries = directories.get('') ?? EMPTY_WORKSPACE_ENTRIES
  const visibleRoot = useMemo(
    () => filterEntries(rootEntries, directories, filter),
    [directories, filter, rootEntries],
  )
  const virtualFileTree = useMemo(
    () =>
      rootEntries.length >= WORKSPACE_TREE_VIRTUAL_ROW_THRESHOLD ||
      exceedsWorkspaceFileTreeRowLimit(
        rootEntries,
        directories,
        expanded,
        '',
        WORKSPACE_TREE_VIRTUAL_ROW_THRESHOLD,
      ),
    [directories, expanded, rootEntries],
  )

  if (!props.projectPath) {
    return (
      <WorkspaceEmptyState
        kind="files"
        title="Choose a project"
        detail="Files are read from the active project or its isolated session checkout."
      />
    )
  }

  return (
    <div className="workspace-files">
      <header className="workspace-files__toolbar">
        <FolderOpen size={15} aria-hidden />
        <span>{props.projectName ?? lastPathPart(props.projectPath)}</span>
        {selectedPath ? <span className="workspace-files__crumb">› {selectedPath}</span> : null}
        <button
          type="button"
          className="icon-btn icon-btn--always"
          aria-label="Refresh files"
          onClick={refreshDirectories}
        >
          <Refresh size={14} aria-hidden />
        </button>
      </header>

      <div className="workspace-files__split">
        <main className="workspace-files__viewer">
          {loadingFile ? (
            <SkeletonStatus
              label="Opening file…"
              className="workspace-files__document workspace-files__document-skeleton"
            >
              <header>
                <Skeleton className="skeleton--icon" />
                <Skeleton width={164} height={9} />
              </header>
              <SkeletonCode lines={26} gutter />
            </SkeletonStatus>
          ) : file ? (
            <FileViewer file={file} />
          ) : error && selectedPath ? (
            <div className="workspace-files__loading" role="alert">
              <FileWarning size={18} aria-hidden /> {error}
            </div>
          ) : (
            <WorkspaceEmptyState
              kind="files"
              title="Open file"
              detail="Select a file from the workspace tree."
            />
          )}
        </main>

        <aside className="workspace-files__tree" aria-label="Workspace file tree">
          <label className="workspace-tree-search">
            <Search size={14} aria-hidden />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter files…"
              aria-label="Filter workspace files"
            />
          </label>

          {error && !selectedPath ? (
            <div className="workspace-files__tree-error" role="alert">
              {error}
            </div>
          ) : null}

          <WorkspaceFileTree
            entries={visibleRoot}
            directories={directories}
            expanded={expanded}
            loadingDirectories={loadingDirectories}
            filter={filter}
            virtual={virtualFileTree}
            selection={fileSelection}
            onToggle={toggleDirectory}
            onSelect={selectTreeFile}
          />
        </aside>
      </div>
    </div>
  )
})

const WorkspaceFileTree = memo(function WorkspaceFileTree(props: {
  entries: Entry[]
  directories: Map<string, Entry[]>
  expanded: Set<string>
  loadingDirectories: Set<string>
  filter: string
  virtual: boolean
  selection: FileSelectionStore
  onToggle: (entry: Entry) => void
  onSelect: (entry: Entry) => void
}) {
  const rows = useMemo(
    () =>
      props.virtual
        ? workspaceFileTreeRows(props.entries, props.directories, props.expanded, props.filter)
        : EMPTY_WORKSPACE_FILE_TREE_ROWS,
    [props.directories, props.entries, props.expanded, props.filter, props.virtual],
  )

  if (props.virtual) {
    return (
      <VirtualWorkspaceFileTree
        rows={rows}
        expanded={props.expanded}
        loadingDirectories={props.loadingDirectories}
        selection={props.selection}
        onToggle={props.onToggle}
        onSelect={props.onSelect}
      />
    )
  }

  return (
    <div className="workspace-files__tree-list">
      {props.entries.map((entry) => (
        <FileTreeEntry
          key={entry.path}
          entry={entry}
          depth={0}
          directories={props.directories}
          expanded={props.expanded}
          loadingDirectories={props.loadingDirectories}
          filter={props.filter}
          selection={props.selection}
          onToggle={props.onToggle}
          onSelect={props.onSelect}
        />
      ))}
      {props.loadingDirectories.has('') ? (
        <SkeletonStatus label="Loading files…" className="workspace-files__tree-skeleton">
          <SkeletonRows rows={9} icon widths={TREE_SKELETON_WIDTHS} />
        </SkeletonStatus>
      ) : null}
    </div>
  )
})

const WORKSPACE_TREE_VIRTUAL_ROW_THRESHOLD = 200
const WORKSPACE_TREE_ROW_HEIGHT = 29

type WorkspaceFileTreeRows = {
  entries: Entry[]
  depths?: number[] | undefined
}

type FlattenedWorkspaceFileTreeRows = {
  entries: Entry[]
  depths: number[]
}

const EMPTY_WORKSPACE_FILE_TREE_ROWS: WorkspaceFileTreeRows = { entries: [] }

function VirtualWorkspaceFileTree(props: {
  rows: WorkspaceFileTreeRows
  expanded: Set<string>
  loadingDirectories: Set<string>
  selection: FileSelectionStore
  onToggle: (entry: Entry) => void
  onSelect: (entry: Entry) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const getItemKey = useCallback(
    (index: number) => props.rows.entries[index]?.path ?? `missing-workspace-file-row-${index}`,
    [props.rows],
  )
  const virtualizer = useVirtualizer({
    count: props.rows.entries.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => WORKSPACE_TREE_ROW_HEIGHT,
    getItemKey,
    overscan: 12,
  })

  return (
    <div ref={scroller} className="workspace-files__tree-list is-virtual">
      <div className="workspace-files__tree-canvas" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const entry = props.rows.entries[virtualRow.index]
          if (!entry) return null
          const depth = props.rows.depths?.[virtualRow.index] ?? 0
          return (
            <div
              className="workspace-files__tree-row"
              key={virtualRow.key}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {entry.kind === 'file' ? (
                <FileTreeFile
                  entry={entry}
                  depth={depth}
                  selection={props.selection}
                  onSelect={props.onSelect}
                />
              ) : (
                <FileTreeDirectoryButton
                  entry={entry}
                  depth={depth}
                  open={props.expanded.has(entry.path)}
                  loading={props.loadingDirectories.has(entry.path)}
                  onToggle={props.onToggle}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

type FileTreeEntryProps = {
  entry: Entry
  depth: number
  directories: Map<string, Entry[]>
  expanded: Set<string>
  loadingDirectories: Set<string>
  filter: string
  selection: FileSelectionStore
  onToggle: (entry: Entry) => void
  onSelect: (entry: Entry) => void
}

const FileTreeEntry = memo(function FileTreeEntry(props: FileTreeEntryProps) {
  const { entry } = props
  if (entry.kind === 'file') {
    return (
      <FileTreeFile
        entry={entry}
        depth={props.depth}
        selection={props.selection}
        onSelect={props.onSelect}
      />
    )
  }

  const open = props.expanded.has(entry.path)
  const loading = props.loadingDirectories.has(entry.path)
  const children = filterEntries(
    props.directories.get(entry.path) ?? [],
    props.directories,
    props.filter,
  )
  // A first listing gets placeholder rows where its children will appear; a
  // refresh of a listed folder keeps the rows and spins on the folder instead.
  const pending = open && loading && children.length === 0
  return (
    <div className="workspace-files__directory">
      <FileTreeDirectoryButton
        entry={entry}
        depth={props.depth}
        open={open}
        loading={loading && !pending}
        onToggle={props.onToggle}
      />
      {pending ? (
        <SkeletonRows
          rows={3}
          icon
          widths={TREE_SKELETON_WIDTHS}
          indents={[12 + (props.depth + 1) * WORKSPACE_TREE_INDENT]}
          className="workspace-files__tree-skeleton skeleton-group"
        />
      ) : null}
      {open
        ? children.map((child) => (
            <FileTreeEntry {...props} key={child.path} entry={child} depth={props.depth + 1} />
          ))
        : null}
    </div>
  )
}, sameFileTreeEntryProps)

function FileTreeDirectoryButton(props: {
  entry: Entry
  depth: number
  open: boolean
  loading: boolean
  onToggle: (entry: Entry) => void
}) {
  return (
    <button
      type="button"
      className="workspace-files__entry is-directory"
      style={{ paddingLeft: 9 + props.depth * WORKSPACE_TREE_INDENT }}
      aria-expanded={props.entry.restricted ? undefined : props.open}
      title={props.entry.restricted ? `${props.entry.name} is protected` : props.entry.path}
      onClick={() => props.onToggle(props.entry)}
    >
      <IconMorph active={props.entry.restricted ? 2 : props.open ? 1 : 0}>
        <ChevronRight size={14} aria-hidden />
        <ChevronDown size={14} aria-hidden />
        <LockKeyhole size={13} aria-hidden />
      </IconMorph>
      <IconMorph active={props.open ? 1 : 0}>
        <Folder size={14} aria-hidden />
        <FolderOpen size={14} aria-hidden />
      </IconMorph>
      <span>{props.entry.name}</span>
      {props.loading ? <LoaderCircle className="spinner" size={12} aria-hidden /> : null}
    </button>
  )
}

function sameFileTreeEntryProps(
  previous: Readonly<FileTreeEntryProps>,
  next: Readonly<FileTreeEntryProps>,
): boolean {
  if (previous.entry.kind !== 'file' || next.entry.kind !== 'file') return false
  return (
    previous.entry === next.entry &&
    previous.depth === next.depth &&
    previous.selection === next.selection &&
    previous.onSelect === next.onSelect
  )
}

function FileTreeFile(props: {
  entry: Entry
  depth: number
  selection: FileSelectionStore
  onSelect: (entry: Entry) => void
}) {
  const subscribe = useCallback(
    (listener: () => void) => props.selection.subscribe(props.entry.path, listener),
    [props.entry.path, props.selection],
  )
  const selected = useSyncExternalStore(
    subscribe,
    () => props.selection.selected(props.entry.path),
    () => props.selection.selected(props.entry.path),
  )

  return (
    <button
      type="button"
      className={`workspace-files__entry is-file${selected ? ' is-selected' : ''}`}
      style={{ paddingLeft: 12 + props.depth * WORKSPACE_TREE_INDENT }}
      title={props.entry.restricted ? `${props.entry.name} is protected` : props.entry.path}
      disabled={props.entry.restricted}
      onClick={() => props.onSelect(props.entry)}
    >
      <FileTypeIcon path={props.entry.path} />
      <MiddleEllipsis text={props.entry.name} />
      {props.entry.restricted ? <LockKeyhole size={12} aria-hidden /> : null}
    </button>
  )
}

function MiddleEllipsis({ text }: { text: string }) {
  const characters = Array.from(text)
  const suffixLength = Math.min(10, Math.max(1, Math.floor(characters.length * 0.45)))
  const splitAt = characters.length - suffixLength

  return (
    <span className="workspace-files__name" aria-label={text}>
      <span className="workspace-files__name-start" aria-hidden>
        {characters.slice(0, splitAt).join('')}
      </span>
      <span className="workspace-files__name-end" aria-hidden>
        {characters.slice(splitAt).join('')}
      </span>
    </span>
  )
}

function FileViewer({ file }: { file: FileContents }) {
  if (file.binary) {
    return (
      <WorkspaceEmptyState
        kind="files"
        title="Binary file"
        detail={`${file.name} is ${formatBytes(file.size)} and cannot be shown as text.`}
      />
    )
  }

  return (
    <div className="workspace-files__document">
      <header>
        <strong>{file.path}</strong>
        <span>{formatBytes(file.size)}</span>
        {file.truncated ? <em>First 2 MB</em> : null}
      </header>
      <VirtualCode content={file.content ?? ''} />
    </div>
  )
}

function VirtualCode({ content }: { content: string }) {
  const scroller = useRef<HTMLDivElement>(null)
  const lines = useMemo(() => indexTextLines(content), [content])
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 22,
    overscan: 24,
  })

  return (
    <div ref={scroller} className="workspace-code" tabIndex={0}>
      <div className="workspace-code__canvas" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            className="workspace-code__line"
            key={row.key}
            style={{ transform: `translateY(${row.start}px)` }}
          >
            <span>{row.index + 1}</span>
            <code>{indexedTextLine(content, lines, row.index) || ' '}</code>
          </div>
        ))}
      </div>
    </div>
  )
}

function filterEntries(
  entries: Entry[],
  directories: Map<string, Entry[]>,
  filter: string,
): Entry[] {
  const query = filter.trim().toLocaleLowerCase()
  if (!query) return entries
  return entries.filter(
    (entry) =>
      normalizedWorkspaceEntryName(entry).includes(query) ||
      (entry.kind === 'directory' &&
        hasWorkspaceEntryMatch(directories.get(entry.path) ?? [], directories, query)),
  )
}

const normalizedWorkspaceEntryNames = new WeakMap<Entry, string>()

function normalizedWorkspaceEntryName(entry: Entry): string {
  let normalized = normalizedWorkspaceEntryNames.get(entry)
  if (normalized === undefined) {
    normalized = entry.name.toLocaleLowerCase()
    normalizedWorkspaceEntryNames.set(entry, normalized)
  }
  return normalized
}

function hasWorkspaceEntryMatch(
  entries: Entry[],
  directories: Map<string, Entry[]>,
  query: string,
): boolean {
  for (const entry of entries) {
    if (normalizedWorkspaceEntryName(entry).includes(query)) return true
    if (
      entry.kind === 'directory' &&
      hasWorkspaceEntryMatch(directories.get(entry.path) ?? [], directories, query)
    ) {
      return true
    }
  }
  return false
}

function workspaceFileTreeRows(
  entries: Entry[],
  directories: Map<string, Entry[]>,
  expanded: Set<string>,
  filter: string,
): WorkspaceFileTreeRows {
  if (expanded.size === 1 && expanded.has('')) return { entries }
  return flattenWorkspaceFileTree(entries, directories, expanded, filter)
}

function flattenWorkspaceFileTree(
  entries: Entry[],
  directories: Map<string, Entry[]>,
  expanded: Set<string>,
  filter: string,
  depth = 0,
  rows: FlattenedWorkspaceFileTreeRows = { entries: [], depths: [] },
): WorkspaceFileTreeRows {
  for (const entry of entries) {
    rows.entries.push(entry)
    rows.depths.push(depth)
    if (entry.kind !== 'directory' || entry.restricted || !expanded.has(entry.path)) continue
    flattenWorkspaceFileTree(
      filterEntries(directories.get(entry.path) ?? [], directories, filter),
      directories,
      expanded,
      filter,
      depth + 1,
      rows,
    )
  }
  return rows
}

function exceedsWorkspaceFileTreeRowLimit(
  entries: Entry[],
  directories: Map<string, Entry[]>,
  expanded: Set<string>,
  filter: string,
  limit: number,
): boolean {
  let count = 0
  const visit = (visibleEntries: Entry[]): boolean => {
    for (const entry of visibleEntries) {
      count += 1
      if (count >= limit) return true
      if (entry.kind !== 'directory' || entry.restricted || !expanded.has(entry.path)) continue
      if (visit(filterEntries(directories.get(entry.path) ?? [], directories, filter))) return true
    }
    return false
  }
  return visit(entries)
}

function lastPathPart(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
