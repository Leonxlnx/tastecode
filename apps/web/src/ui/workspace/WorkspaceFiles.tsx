import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ResultOf } from '@harness/contracts'
import {
  ChevronDown,
  ChevronRight,
  FileWarning,
  Folder,
  FolderOpen,
  LoaderCircle,
  LockKeyhole,
  Search,
} from 'lucide-react'
import type { Transport } from '../../transport.js'
import { FileTypeIcon } from '../FileTypeIcon.js'
import { WorkspaceEmptyState } from './WorkspaceEmptyState.js'
import { propertiesWhen } from '../../properties-when.js'

type Entry = ResultOf<'workspace.listDirectory'>['entries'][number]
type FileContents = ResultOf<'workspace.readFile'>

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
  const directoryGeneration = useRef(0)
  const fileGeneration = useRef(0)

  const context = useCallback(
    () => ({
      projectPath: props.projectPath!,
      ...propertiesWhen(props.threadId, (includedValue) => ({ threadId: includedValue })),
    }),
    [props.projectPath, props.threadId],
  )

  const loadDirectory = useCallback(
    async (directory: string) => {
      if (!props.projectPath) return
      const mine = directoryGeneration.current
      setLoadingDirectories((current) => new Set(current).add(directory))
      try {
        const result = await props.transport.request('workspace.listDirectory', {
          ...context(),
          ...propertiesWhen(directory, (directory) => ({ directory })),
        })
        if (directoryGeneration.current === mine) {
          setDirectories((current) => new Map(current).set(directory, result.entries))
        }
      } catch (cause) {
        if (directoryGeneration.current === mine) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      } finally {
        if (directoryGeneration.current !== mine) return
        setLoadingDirectories((current) => {
          const next = new Set(current)
          next.delete(directory)
          return next
        })
      }
    },
    [context, props.projectPath, props.transport],
  )

  useEffect(() => {
    directoryGeneration.current += 1
    fileGeneration.current += 1
    setDirectories(new Map())
    setLoadingDirectories(new Set())
    setExpanded(new Set(['']))
    setSelectedPath(undefined)
    setFile(undefined)
    setError(undefined)
    if (props.projectPath) void loadDirectory('')
    return () => {
      directoryGeneration.current += 1
      fileGeneration.current += 1
    }
  }, [loadDirectory, props.projectPath, props.threadId])

  const toggleDirectory = (entry: Entry) => {
    if (entry.restricted) return
    const opening = !expanded.has(entry.path)
    setExpanded((current) => {
      const next = new Set(current)
      opening ? next.add(entry.path) : next.delete(entry.path)
      return next
    })
    if (opening && !directories.has(entry.path)) void loadDirectory(entry.path)
  }

  const selectFile = async (entry: Entry) => {
    if (!props.projectPath || entry.restricted) return
    const mine = ++fileGeneration.current
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
  }

  const visibleRoot = useMemo(
    () => filterEntries(directories.get('') ?? [], directories, filter),
    [directories, filter],
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
      </header>

      <div className="workspace-files__split">
        <main className="workspace-files__viewer">
          {loadingFile ? (
            <div className="workspace-files__loading" role="status">
              <LoaderCircle className="spinner" size={16} aria-hidden /> Opening file…
            </div>
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

          <div className="workspace-files__tree-list">
            {visibleRoot.map((entry) => (
              <FileTreeEntry
                key={entry.path}
                entry={entry}
                depth={0}
                selectedPath={selectedPath}
                directories={directories}
                expanded={expanded}
                loadingDirectories={loadingDirectories}
                filter={filter}
                onToggle={toggleDirectory}
                onSelect={(next) => void selectFile(next)}
              />
            ))}
            {loadingDirectories.has('') ? (
              <div className="workspace-files__tree-loading">
                <LoaderCircle className="spinner" size={13} aria-hidden /> Loading files…
              </div>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  )
})

function FileTreeEntry(props: {
  entry: Entry
  depth: number
  selectedPath?: string | undefined
  directories: Map<string, Entry[]>
  expanded: Set<string>
  loadingDirectories: Set<string>
  filter: string
  onToggle: (entry: Entry) => void
  onSelect: (entry: Entry) => void
}) {
  const { entry } = props
  if (entry.kind === 'file') {
    return (
      <button
        type="button"
        className={`workspace-files__entry is-file${props.selectedPath === entry.path ? ' is-selected' : ''}`}
        style={{ paddingLeft: 12 + props.depth * 18 }}
        title={entry.restricted ? `${entry.name} is protected` : entry.path}
        disabled={entry.restricted}
        onClick={() => props.onSelect(entry)}
      >
        <FileTypeIcon path={entry.path} />
        <MiddleEllipsis text={entry.name} />
        {entry.restricted ? <LockKeyhole size={12} aria-hidden /> : null}
      </button>
    )
  }

  const open = props.expanded.has(entry.path)
  const children = filterEntries(
    props.directories.get(entry.path) ?? [],
    props.directories,
    props.filter,
  )
  return (
    <div className="workspace-files__directory">
      <button
        type="button"
        className="workspace-files__entry is-directory"
        style={{ paddingLeft: 9 + props.depth * 18 }}
        aria-expanded={entry.restricted ? undefined : open}
        title={entry.restricted ? `${entry.name} is protected` : entry.path}
        onClick={() => props.onToggle(entry)}
      >
        {entry.restricted ? (
          <LockKeyhole size={13} aria-hidden />
        ) : open ? (
          <ChevronDown size={14} aria-hidden />
        ) : (
          <ChevronRight size={14} aria-hidden />
        )}
        {open ? <FolderOpen size={14} aria-hidden /> : <Folder size={14} aria-hidden />}
        <span>{entry.name}</span>
        {props.loadingDirectories.has(entry.path) ? (
          <LoaderCircle className="spinner" size={12} aria-hidden />
        ) : null}
      </button>
      {open
        ? children.map((child) => (
            <FileTreeEntry {...props} key={child.path} entry={child} depth={props.depth + 1} />
          ))
        : null}
    </div>
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
  const lines = useMemo(() => content.split('\n'), [content])
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
            <code>{lines[row.index] || ' '}</code>
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
  return entries.filter((entry) => {
    if (entry.name.toLocaleLowerCase().includes(query)) return true
    if (entry.kind !== 'directory') return false
    return filterEntries(directories.get(entry.path) ?? [], directories, filter).length > 0
  })
}

function lastPathPart(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
