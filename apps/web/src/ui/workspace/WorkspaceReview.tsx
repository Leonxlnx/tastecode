import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from '@pierre/diffs/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { DiffFile, SessionDiff } from '@harness/contracts'
import {
  IconCheck as Check,
  IconChevronDown as ChevronDown,
  IconChevronRight as ChevronRight,
  IconFolder as Folder,
  IconGitBranch as GitBranch,
  IconGitCommit as GitCommit,
  IconRefresh as RefreshCw,
  IconSearch as Search,
} from '@tabler/icons-react'
import { writeClipboardText } from '../../bridge.js'
import type { Transport } from '../../transport.js'
import { FileTypeIcon } from '../FileTypeIcon.js'
import { IconMorph } from '../IconMorph.js'
import { SkeletonCode, SkeletonStatus } from '../Skeleton.js'
import { ReviewCommitBox } from './ReviewComposer.js'
import { WorkspaceEmptyState } from './WorkspaceEmptyState.js'
import {
  buildReviewTree,
  flattenReviewTree,
  reviewTreeNodeKey,
  type ReviewTreeNode,
  type ReviewTreeRow,
} from './review-file-tree.js'
import { useWorkspaceRefresh } from './useWorkspaceRefresh.js'
import {
  workspaceDiffCollection,
  workspaceDiffItemId,
  type WorkspaceDiffFallback,
} from './workspace-diffs.js'

const WORKSPACE_DIFF_CSS = `
  :host {
    --diffs-font-family: var(--font-mono);
    --diffs-header-font-family: var(--font-ui);
    --diffs-font-size: 12px;
    --diffs-line-height: 23px;
    --diffs-light-bg: var(--chrome-recessed);
    --diffs-dark-bg: var(--chrome-recessed);
    --diffs-light: var(--text-2);
    --diffs-dark: var(--text-2);
    --diffs-addition-color: var(--success);
    --diffs-deletion-color: var(--error);
    --diffs-modified-color: var(--attention);
    --diffs-selection-base: var(--line-strong);
    --diffs-bg-context-override: var(--chrome-recessed);
    --diffs-bg-context-gutter-override: color-mix(
      in srgb,
      var(--chrome-recessed) 92%,
      var(--surface-2)
    );
    --diffs-bg-buffer-override: color-mix(
      in srgb,
      var(--chrome-recessed) 90%,
      var(--surface)
    );
    --diffs-bg-separator-override: color-mix(
      in srgb,
      var(--chrome-recessed) 86%,
      var(--surface)
    );
    --diffs-bg-addition-override: color-mix(
      in srgb,
      var(--success) 10%,
      var(--chrome-recessed)
    );
    --diffs-bg-deletion-override: color-mix(
      in srgb,
      var(--error) 11%,
      var(--chrome-recessed)
    );
    --diffs-bg-addition-number-override: color-mix(
      in srgb,
      var(--success) 15%,
      var(--chrome-recessed)
    );
    --diffs-bg-deletion-number-override: color-mix(
      in srgb,
      var(--error) 16%,
      var(--chrome-recessed)
    );
    --diffs-fg-number-override: var(--text-3);
    --diffs-gap-inline: 8px;
    --diffs-gap-block: 0px;
    background: var(--chrome-recessed);
  }

  [data-diffs-header='default'] {
    min-height: 38px;
    padding-inline: 12px;
    background: var(--chrome-recessed);
    border-bottom: 1px solid var(--line);
  }

  [data-separator] {
    border-block-color: var(--line);
  }
`

export const WorkspaceReview = memo(function WorkspaceReview(props: {
  transport: Transport
  projectPath?: string | undefined
  threadId?: string | undefined
  branch?: string | undefined
  theme: 'light' | 'dark'
  /** The chat's turn is running; commits wait for it. */
  turnRunning?: boolean | undefined
}) {
  // The server does not know a chat's provisional id while its first message
  // creates it; stay in the project checkout until the real id arrives.
  const threadId = props.threadId?.startsWith('pending:') ? undefined : props.threadId
  const [diff, setDiff] = useState<SessionDiff>()
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [composer, setComposer] = useState<'commit'>()
  const [commitMessage, setCommitMessage] = useState('')
  const [actionError, setActionError] = useState<string>()
  const [actionDone, setActionDone] = useState<string>()
  const [busy, setBusy] = useState<'commit'>()
  const [generatingCommit, setGeneratingCommit] = useState(false)
  const [copiedCommit, setCopiedCommit] = useState(false)
  const generation = useRef(0)
  const draftGeneration = useRef(0)
  const actionGeneration = useRef(0)
  /** The message is a generated draft nobody edited, so other changes make it stale. */
  const untouchedDraft = useRef(false)
  const diffVersion = useRef<string>(undefined)
  const codeViewRef = useRef<CodeViewHandle<undefined>>(null)

  const dropStaleDraft = useCallback(() => {
    draftGeneration.current += 1
    setGeneratingCommit(false)
    setCopiedCommit(false)
    if (!untouchedDraft.current) return
    untouchedDraft.current = false
    setCommitMessage('')
  }, [])

  const resetActions = useCallback(() => {
    actionGeneration.current += 1
    untouchedDraft.current = false
    dropStaleDraft()
    setComposer(undefined)
    setCommitMessage('')
    setActionError(undefined)
    setActionDone(undefined)
    setBusy(undefined)
  }, [dropStaleDraft])

  const refresh = useCallback(async () => {
    if (!props.projectPath) return
    const mine = ++generation.current
    setLoading(true)
    setError(undefined)
    try {
      const result = await props.transport.request('workspace.diff', {
        projectPath: props.projectPath,
        ...(threadId ? { threadId } : {}),
      })
      if (generation.current === mine) {
        // The version names the changes, so a draft survives a refresh that found the same ones.
        if (result.version !== diffVersion.current) dropStaleDraft()
        diffVersion.current = result.version
        setDiff(result)
      }
    } catch (cause) {
      if (generation.current === mine) setError(messageOf(cause))
    } finally {
      if (generation.current === mine) setLoading(false)
    }
  }, [dropStaleDraft, props.projectPath, threadId, props.transport])

  const generateCommitMessage = useCallback(async () => {
    if (!props.projectPath) return
    const mine = draftGeneration.current
    setGeneratingCommit(true)
    setActionError(undefined)
    setCopiedCommit(false)
    try {
      const result = await props.transport.request('backgroundModel.generateCommitMessage', {
        projectPath: props.projectPath,
        ...(threadId ? { threadId } : {}),
      })
      if (draftGeneration.current !== mine) return
      untouchedDraft.current = true
      setCommitMessage(result.message)
    } catch (cause) {
      if (draftGeneration.current === mine) setActionError(messageOf(cause))
    } finally {
      if (draftGeneration.current === mine) setGeneratingCommit(false)
    }
  }, [props.projectPath, threadId, props.transport])

  const copyCommitMessage = useCallback(async () => {
    if (!commitMessage) return
    try {
      await writeClipboardText(commitMessage)
      setCopiedCommit(true)
    } catch {
      setActionError('Could not copy the commit message.')
    }
  }, [commitMessage])

  /** One git write at a time; a reply for another checkout is dropped. */
  const runAction = useCallback(async (kind: 'commit', action: () => Promise<string>) => {
    const mine = actionGeneration.current
    setBusy(kind)
    setActionError(undefined)
    setActionDone(undefined)
    try {
      const done = await action()
      if (actionGeneration.current === mine) setActionDone(done)
    } catch (cause) {
      if (actionGeneration.current === mine) setActionError(messageOf(cause))
    } finally {
      if (actionGeneration.current === mine) setBusy(undefined)
    }
  }, [])

  const checkoutParams = useMemo(
    () =>
      props.projectPath
        ? { projectPath: props.projectPath, ...(threadId ? { threadId } : {}) }
        : undefined,
    [props.projectPath, threadId],
  )

  const commit = useCallback(() => {
    const message = commitMessage
    if (!checkoutParams || !message.trim()) return
    const mine = actionGeneration.current
    void runAction('commit', async () => {
      // Review shows untracked files, so committing what it shows includes them.
      const result = await props.transport.request('workspace.commit', {
        ...checkoutParams,
        message,
        includeUntracked: true,
      })
      // The box closes onto the new diff, never onto the changes just committed.
      if (actionGeneration.current === mine) await refresh()
      if (actionGeneration.current === mine) {
        untouchedDraft.current = false
        setCommitMessage('')
        setComposer(undefined)
      }
      return `Committed ${result.commit.slice(0, 7)}${result.branch ? ` to ${result.branch}` : ''}`
    })
  }, [checkoutParams, commitMessage, props.transport, refresh, runAction])

  useEffect(() => {
    setDiff(undefined)
    diffVersion.current = undefined
    resetActions()
    if (props.projectPath) void refresh()
    return () => {
      generation.current += 1
      draftGeneration.current += 1
      actionGeneration.current += 1
    }
  }, [resetActions, props.projectPath, threadId, refresh])

  const refreshAfterChange = useCallback(() => void refresh(), [refresh])
  useWorkspaceRefresh(props.transport, threadId, refreshAfterChange)

  const fileCount = diff?.files.length ?? 0
  const waitReason = props.turnRunning ? 'Wait until the chat finishes its turn.' : undefined
  const toggleComposer = (next: 'commit') => {
    setActionError(undefined)
    setActionDone(undefined)
    setComposer((current) => (current === next ? undefined : next))
  }

  const stats = useMemo(() => diffStats(diff), [diff])
  const matchingFiles = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase()
    return (
      diff?.files.filter((file) => !query || file.path.toLocaleLowerCase().includes(query)) ?? []
    )
  }, [diff, filter])
  const renderedDiff = useMemo(
    () =>
      diff ? workspaceDiffCollection(diff.version, matchingFiles) : { items: [], fallbacks: [] },
    [diff, matchingFiles],
  )
  const diffOptions = useMemo<CodeViewReactOptions<undefined>>(
    () => ({
      diffStyle: 'unified',
      diffIndicators: 'bars',
      hunkSeparators: 'line-info-basic',
      lineDiffType: 'word-alt',
      lineHoverHighlight: 'line',
      overflow: 'wrap',
      preferredHighlighter: 'shiki-js',
      stickyHeaders: true,
      theme: { dark: 'github-dark', light: 'github-light' },
      themeType: props.theme,
      unsafeCSS: WORKSPACE_DIFF_CSS,
      layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
      itemMetrics: {
        lineHeight: 23,
        diffHeaderHeight: 38,
        hunkSeparatorHeight: 32,
        spacing: 0,
        paddingTop: 0,
        paddingBottom: 0,
      },
    }),
    [props.theme],
  )
  const fallbackPaths = useMemo(
    () => new Set(renderedDiff.fallbacks.map((fallback) => fallback.file.path)),
    [renderedDiff.fallbacks],
  )
  const selectFile = useCallback(
    (file: DiffFile) => {
      if (fallbackPaths.has(file.path)) {
        document.getElementById(reviewFileId(file.path))?.scrollIntoView({ block: 'start' })
        return
      }
      codeViewRef.current?.scrollTo({
        type: 'item',
        id: workspaceDiffItemId(file.path),
        align: 'start',
        behavior: 'smooth',
      })
    },
    [fallbackPaths],
  )
  const renderFallbacks = useCallback(
    () => <ReviewFallbackFiles fallbacks={renderedDiff.fallbacks} />,
    [renderedDiff.fallbacks],
  )

  if (!props.projectPath) {
    return (
      <WorkspaceEmptyState
        kind="review"
        title="Choose a project"
        detail="Review shows the active checkout's uncommitted changes against HEAD."
      />
    )
  }

  return (
    <div className="workspace-review">
      <header className="workspace-review__toolbar">
        <span className="workspace-review__branch">
          <GitBranch size={14} aria-hidden />
          <strong title={props.branch}>{props.branch ?? 'Workspace'}</strong>
        </span>
        <span className="workspace-review__stats" aria-label="Diff statistics">
          <span className="is-add">+{stats.added.toLocaleString()}</span>
          <span className="is-delete">−{stats.removed.toLocaleString()}</span>
        </span>
        <span className="workspace-review__file-count">
          {fileCount} file{fileCount === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          className={`workspace-review__action${composer === 'commit' ? ' is-open' : ''}`}
          title="Commit changes"
          aria-label="Commit changes"
          aria-expanded={composer === 'commit'}
          disabled={fileCount === 0}
          onClick={() => toggleComposer('commit')}
        >
          <GitCommit size={14} aria-hidden />
          <span className="workspace-review__action-label">Commit</span>
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Refresh diff"
          aria-label="Refresh diff"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw className={loading ? 'spinner' : undefined} size={14} aria-hidden />
        </button>
      </header>

      <div className="workspace-review__notices">
        {composer === 'commit' && fileCount > 0 ? (
          <ReviewCommitBox
            message={commitMessage}
            fileCount={fileCount}
            generating={generatingCommit}
            copied={copiedCommit}
            committing={busy === 'commit'}
            blocked={waitReason}
            disabled={busy !== undefined || loading}
            onMessageChange={(message) => {
              untouchedDraft.current = false
              setCopiedCommit(false)
              setCommitMessage(message)
            }}
            onGenerate={() => void generateCommitMessage()}
            onCopy={() => void copyCommitMessage()}
            onCommit={commit}
            onCancel={() => setComposer(undefined)}
          />
        ) : null}

        <div className="workspace-review__status" aria-live="polite">
          {error ? (
            <div className="workspace-review__message" role="alert">
              {error}
            </div>
          ) : null}
          {actionError ? (
            <div className="workspace-review__message is-action" role="alert">
              {actionError}
            </div>
          ) : null}
          {actionDone ? (
            <div className="workspace-review__done" role="status">
              <Check size={14} aria-hidden />
              {actionDone}
            </div>
          ) : null}
        </div>
      </div>

      {!diff && loading ? (
        <SkeletonStatus label="Loading diff…" className="workspace-review__skeleton">
          <SkeletonCode lines={22} gutter />
        </SkeletonStatus>
      ) : null}

      {diff && diff.files.length === 0 ? (
        <WorkspaceEmptyState
          kind="review"
          title="Working tree is clean"
          detail="Uncommitted changes on the current branch will appear here."
        />
      ) : null}

      {diff && diff.files.length > 0 ? (
        <div className="workspace-review__split">
          {matchingFiles.length === 0 ? (
            <div className="workspace-review__diff">
              <div className="workspace-review__message">No changed files match “{filter}”.</div>
            </div>
          ) : renderedDiff.items.length > 0 ? (
            <CodeView
              ref={codeViewRef}
              className="workspace-review__diff workspace-review__code-view"
              items={renderedDiff.items}
              options={diffOptions}
              selectedLines={null}
              disableWorkerPool
              {...(renderedDiff.fallbacks.length > 0
                ? { renderCodeViewFooter: renderFallbacks }
                : {})}
            />
          ) : (
            <div className="workspace-review__diff">
              <ReviewFallbackFiles fallbacks={renderedDiff.fallbacks} />
            </div>
          )}

          <aside className="workspace-review__tree" aria-label="Changed file tree">
            <label className="workspace-tree-search">
              <Search size={14} aria-hidden />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter files…"
                aria-label="Filter changed files"
              />
            </label>
            <ReviewTree files={matchingFiles} onSelect={selectFile} />
          </aside>
        </div>
      ) : null}
    </div>
  )
})

function ReviewFallbackFiles({ fallbacks }: { fallbacks: WorkspaceDiffFallback[] }) {
  return (
    <>
      {fallbacks.map(({ file, reason }) => {
        const stats = fileStats(file)
        return (
          <section className="workspace-review__file" id={reviewFileId(file.path)} key={file.path}>
            <header>
              <FileTypeIcon path={file.path} />
              <strong>{file.path}</strong>
              <span className="workspace-review__file-stats">
                <span className="is-add">+{stats.added}</span>
                <span className="is-delete">−{stats.removed}</span>
              </span>
            </header>
            <div className="workspace-review__message">
              {reason === 'binary' ? 'Binary file changed' : 'Diffs could not parse this patch.'}
            </div>
          </section>
        )
      })}
    </>
  )
}

const REVIEW_TREE_VIRTUAL_FILE_THRESHOLD = 200
const REVIEW_TREE_ROW_HEIGHT = 29
const EMPTY_REVIEW_TREE_ROWS: ReviewTreeRow[] = []

export const ReviewTree = memo(function ReviewTree({
  files,
  onSelect,
}: {
  files: DiffFile[]
  onSelect: (file: DiffFile) => void
}) {
  const tree = useMemo(() => buildReviewTree(files), [files])
  if (files.length > REVIEW_TREE_VIRTUAL_FILE_THRESHOLD) {
    return <VirtualReviewTree tree={tree} onSelect={onSelect} />
  }

  return (
    <div className="workspace-review__tree-list">
      {tree.map((node) => (
        <ReviewTreeNode key={reviewTreeNodeKey(node)} node={node} depth={0} onSelect={onSelect} />
      ))}
    </div>
  )
})

function VirtualReviewTree({
  tree,
  onSelect,
}: {
  tree: ReviewTreeNode[]
  onSelect: (file: DiffFile) => void
}) {
  const [closedPaths, setClosedPaths] = useState<ReadonlySet<string>>(() => new Set())
  const rows = useMemo(
    () => (tree.length > 0 ? flattenReviewTree(tree, closedPaths) : EMPTY_REVIEW_TREE_ROWS),
    [closedPaths, tree],
  )
  const scroller = useRef<HTMLDivElement>(null)
  const getItemKey = useCallback(
    (index: number) => {
      const row = rows[index]
      return row ? reviewTreeNodeKey(row.node) : `missing-review-row-${index}`
    },
    [rows],
  )
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => REVIEW_TREE_ROW_HEIGHT,
    getItemKey,
    overscan: 12,
  })
  const toggleFolder = useCallback((path: string) => {
    setClosedPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  return (
    <div ref={scroller} className="workspace-review__tree-list is-virtual">
      <div className="workspace-review__tree-canvas" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index]
          if (!row) return null
          return (
            <VirtualReviewTreeRow
              key={virtualRow.key}
              row={row}
              open={!closedPaths.has(row.node.path)}
              start={virtualRow.start}
              onSelect={onSelect}
              onToggle={toggleFolder}
            />
          )
        })}
      </div>
    </div>
  )
}

function VirtualReviewTreeRow({
  row,
  open,
  start,
  onSelect,
  onToggle,
}: {
  row: ReviewTreeRow
  open: boolean
  start: number
  onSelect: (file: DiffFile) => void
  onToggle: (path: string) => void
}) {
  const { node, depth } = row
  if (node.file) {
    return (
      <button
        type="button"
        className="workspace-review__tree-file workspace-review__tree-row"
        style={{ paddingLeft: 10 + depth * 18, transform: `translateY(${start}px)` }}
        title={node.path}
        onClick={() => onSelect(node.file!)}
      >
        <FileTypeIcon path={node.path} />
        <span>{node.name}</span>
        <i data-status={node.file.status}>{statusLetter(node.file.status)}</i>
      </button>
    )
  }

  return (
    <div
      className="workspace-review__tree-folder workspace-review__tree-row"
      style={{ transform: `translateY(${start}px)` }}
    >
      <button
        type="button"
        style={{ paddingLeft: 8 + depth * 18 }}
        aria-expanded={open}
        onClick={() => onToggle(node.path)}
      >
        <IconMorph active={open ? 1 : 0}>
          <ChevronRight size={14} aria-hidden />
          <ChevronDown size={14} aria-hidden />
        </IconMorph>
        <Folder size={14} aria-hidden />
        <span>{node.name}</span>
      </button>
    </div>
  )
}

function ReviewTreeNode({
  node,
  depth,
  onSelect,
}: {
  node: ReviewTreeNode
  depth: number
  onSelect: (file: DiffFile) => void
}) {
  const [open, setOpen] = useState(true)
  if (node.file) {
    return (
      <button
        type="button"
        className="workspace-review__tree-file"
        style={{ paddingLeft: 10 + depth * 18 }}
        title={node.path}
        onClick={() => onSelect(node.file!)}
      >
        <FileTypeIcon path={node.path} />
        <span>{node.name}</span>
        <i data-status={node.file.status}>{statusLetter(node.file.status)}</i>
      </button>
    )
  }

  return (
    <div className="workspace-review__tree-folder">
      <button
        type="button"
        style={{ paddingLeft: 8 + depth * 18 }}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <IconMorph active={open ? 1 : 0}>
          <ChevronRight size={14} aria-hidden />
          <ChevronDown size={14} aria-hidden />
        </IconMorph>
        <Folder size={14} aria-hidden />
        <span>{node.name}</span>
      </button>
      {open
        ? node.children.map((child) => (
            <ReviewTreeNode
              key={reviewTreeNodeKey(child)}
              node={child}
              depth={depth + 1}
              onSelect={onSelect}
            />
          ))
        : null}
    </div>
  )
}

function diffStats(diff: SessionDiff | undefined): { added: number; removed: number } {
  return (diff?.files ?? []).reduce(
    (total, file) => {
      const next = fileStats(file)
      return { added: total.added + next.added, removed: total.removed + next.removed }
    },
    { added: 0, removed: 0 },
  )
}

function fileStats(file: DiffFile) {
  let added = 0
  let removed = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'addition') added += 1
      else if (line.kind === 'deletion') removed += 1
    }
  }
  return { added, removed }
}

function reviewFileId(path: string): string {
  return `workspace-review-${encodeURIComponent(path)}`
}

function statusLetter(status: DiffFile['status']): string {
  return status === 'added' ? 'A' : status === 'deleted' ? 'D' : status === 'renamed' ? 'R' : 'M'
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
