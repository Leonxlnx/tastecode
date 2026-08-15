import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from '@pierre/diffs/react'
import type { DiffFile, SessionDiff } from '@harness/contracts'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Search,
  Sparkles,
} from 'lucide-react'
import type { Transport } from '../../transport.js'
import { FileTypeIcon } from '../FileTypeIcon.js'
import { WorkspaceEmptyState } from './WorkspaceEmptyState.js'
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
}) {
  const [diff, setDiff] = useState<SessionDiff>()
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [commitMessage, setCommitMessage] = useState<string>()
  const [commitError, setCommitError] = useState<string>()
  const [generatingCommit, setGeneratingCommit] = useState(false)
  const [copiedCommit, setCopiedCommit] = useState(false)
  const generation = useRef(0)
  const codeViewRef = useRef<CodeViewHandle<undefined>>(null)

  const refresh = useCallback(async () => {
    if (!props.projectPath) return
    const mine = ++generation.current
    setLoading(true)
    setError(undefined)
    setCommitMessage(undefined)
    setCommitError(undefined)
    setGeneratingCommit(false)
    setCopiedCommit(false)
    try {
      const result = await props.transport.request('workspace.diff', {
        projectPath: props.projectPath,
        ...(props.threadId ? { threadId: props.threadId } : {}),
      })
      if (generation.current === mine) setDiff(result)
    } catch (cause) {
      if (generation.current === mine) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (generation.current === mine) setLoading(false)
    }
  }, [props.projectPath, props.threadId, props.transport])

  const generateCommitMessage = useCallback(async () => {
    if (!props.projectPath) return
    const mine = generation.current
    setGeneratingCommit(true)
    setCommitError(undefined)
    setCopiedCommit(false)
    try {
      const result = await props.transport.request('backgroundModel.generateCommitMessage', {
        projectPath: props.projectPath,
        ...(props.threadId ? { threadId: props.threadId } : {}),
      })
      if (generation.current === mine) setCommitMessage(result.message)
    } catch (cause) {
      if (generation.current === mine) {
        setCommitError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (generation.current === mine) setGeneratingCommit(false)
    }
  }, [props.projectPath, props.threadId, props.transport])

  const copyCommitMessage = useCallback(async () => {
    if (!commitMessage) return
    try {
      await navigator.clipboard.writeText(commitMessage)
      setCopiedCommit(true)
    } catch {
      setCommitError('Could not copy the commit message.')
    }
  }, [commitMessage])

  useEffect(() => {
    setDiff(undefined)
    setCommitMessage(undefined)
    setCommitError(undefined)
    setGeneratingCommit(false)
    setCopiedCommit(false)
    if (props.projectPath) void refresh()
    return () => {
      generation.current += 1
    }
  }, [props.projectPath, props.threadId, refresh])

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
          <strong>{props.branch ?? 'Workspace'}</strong>
        </span>
        <span className="workspace-review__stats" aria-label="Diff statistics">
          <span className="is-add">+{stats.added.toLocaleString()}</span>
          <span className="is-delete">−{stats.removed.toLocaleString()}</span>
        </span>
        <span className="workspace-review__file-count">
          {diff?.files.length ?? 0} file{diff?.files.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          className="workspace-review__generate-commit"
          title="Draft commit message"
          aria-label="Draft commit message"
          disabled={loading || generatingCommit || !diff || diff.files.length === 0}
          onClick={() => void generateCommitMessage()}
        >
          {generatingCommit ? (
            <LoaderCircle className="spinner" size={14} aria-hidden />
          ) : (
            <Sparkles size={14} aria-hidden />
          )}
          <span>Commit message</span>
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Refresh diff"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw className={loading ? 'spinner' : undefined} size={14} aria-hidden />
        </button>
      </header>

      <div className="workspace-review__notices" aria-live="polite">
        {error ? (
          <div className="workspace-review__message" role="alert">
            {error}
          </div>
        ) : null}

        {commitError ? (
          <div className="workspace-review__message" role="alert">
            {commitError}
          </div>
        ) : null}

        {commitMessage ? (
          <div className="workspace-review__commit-draft" role="status">
            <pre>{commitMessage}</pre>
            <button
              type="button"
              aria-label="Copy commit message"
              onClick={() => void copyCommitMessage()}
            >
              {copiedCommit ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
            </button>
          </div>
        ) : null}

        {!diff && loading ? (
          <div className="workspace-review__message" role="status">
            <LoaderCircle className="spinner" size={15} aria-hidden /> Loading diff…
          </div>
        ) : null}
      </div>

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

type TreeNode = {
  name: string
  path: string
  children: TreeNode[]
  file?: DiffFile
}

function ReviewTree({
  files,
  onSelect,
}: {
  files: DiffFile[]
  onSelect: (file: DiffFile) => void
}) {
  const tree = useMemo(() => buildReviewTree(files), [files])
  return (
    <div className="workspace-review__tree-list">
      {tree.map((node) => (
        <ReviewTreeNode key={node.path} node={node} depth={0} onSelect={onSelect} />
      ))}
    </div>
  )
}

function ReviewTreeNode({
  node,
  depth,
  onSelect,
}: {
  node: TreeNode
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
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        <Folder size={14} aria-hidden />
        <span>{node.name}</span>
      </button>
      {open
        ? node.children.map((child) => (
            <ReviewTreeNode key={child.path} node={child} depth={depth + 1} onSelect={onSelect} />
          ))
        : null}
    </div>
  )
}

function buildReviewTree(files: DiffFile[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] }
  for (const file of files) {
    const parts = file.path.replaceAll('\\', '/').split('/').filter(Boolean)
    let parent = root
    parts.forEach((part, index) => {
      const currentPath = parts.slice(0, index + 1).join('/')
      let node = parent.children.find((child) => child.name === part)
      if (!node) {
        node = { name: part, path: currentPath, children: [] }
        parent.children.push(node)
      }
      if (index === parts.length - 1) node.file = file
      parent = node
    })
  }
  const sort = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .sort((left, right) => {
        if (Boolean(left.file) !== Boolean(right.file)) return left.file ? 1 : -1
        return left.name.localeCompare(right.name, undefined, { numeric: true })
      })
      .map((node) => ({ ...node, children: sort(node.children) }))
  return sort(root.children)
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

function fileStats(file: DiffFile): { added: number; removed: number } {
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
