import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from 'react'
import type {
  PullRequestAction,
  PullRequestDetail,
  PullRequestFile,
  PullRequestReviewThread,
} from '@harness/contracts'
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleAlert,
  Ellipsis,
  FileCode2,
  LoaderCircle,
  Pencil,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'
import type { Transport } from '../../transport.js'
import { errorMessage as messageOf } from '../../boundary.js'
import { Markdown } from '../Markdown.js'
import { Menu, MenuItem } from '../Menu.js'
import { parsePullRequestPatch } from './diff.js'
import type {
  PullRequestDiffAnnotation,
  PullRequestDiffRendererProps,
  PullRequestDiffSide,
} from './PullRequestDiffRenderer.js'

const LazyPullRequestDiffRenderer = lazy(() =>
  import('./PullRequestDiffRenderer.js').then((module) => ({
    default: module.PullRequestDiffRenderer,
  })),
)

export type PullRequestDiffView = ComponentType<PullRequestDiffRendererProps>

export function PullRequestFiles(props: {
  detail: PullRequestDetail
  transport: Transport
  onAction: (action: PullRequestAction) => Promise<boolean>
  onConfirmAction: (action: PullRequestAction) => void
  actionBusy: boolean
  diffRendererComponent?: PullRequestDiffView | undefined
}) {
  const [files, setFiles] = useState<PullRequestFile[]>([])
  const [selectedPath, setSelectedPath] = useState<string>()
  const [nextPage, setNextPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const request = useRef(0)

  const loadPage = useCallback(
    async (page: number, refresh = false) => {
      const id = ++request.current
      setLoading(true)
      setError(undefined)
      try {
        const result = await props.transport.request('pullRequests.files', {
          repository: props.detail.repository,
          number: props.detail.number,
          page,
          refresh,
        })
        if (id !== request.current) return
        setFiles((current) =>
          page === 1 ? result.files : dedupeFiles([...current, ...result.files]),
        )
        setSelectedPath((current) => current ?? result.files[0]?.path)
        setHasMore(result.hasMore)
        setNextPage(page + 1)
      } catch (cause) {
        if (id === request.current) setError(messageOf(cause))
      } finally {
        if (id === request.current) setLoading(false)
      }
    },
    [props.detail.number, props.detail.repository, props.transport],
  )

  useEffect(() => {
    void loadPage(1)
    return () => {
      request.current += 1
    }
  }, [loadPage])

  const selected = files.find((file) => file.path === selectedPath) ?? files[0]

  return (
    <div className="pr-files-view">
      <aside className="pr-files-nav">
        <header>
          <div>
            <strong>{props.detail.changedFiles} files</strong>
            <span>
              <b className="is-addition">+{props.detail.additions.toLocaleString()}</b>
              <b className="is-deletion">−{props.detail.deletions.toLocaleString()}</b>
            </span>
          </div>
        </header>
        <div className="pr-files-nav-scroll">
          {files.map((file) => {
            const openThreads = props.detail.reviewThreads.filter(
              (thread) => thread.path === file.path && !thread.resolved,
            ).length
            return (
              <button
                type="button"
                className={selected?.path === file.path ? 'is-selected' : undefined}
                key={file.path}
                title={file.path}
                onClick={() => setSelectedPath(file.path)}
              >
                <FileCode2 size={13} aria-hidden />
                <span>
                  <strong>{fileName(file.path)}</strong>
                  <small>{parentPath(file.path)}</small>
                </span>
                {openThreads > 0 ? <em>{openThreads}</em> : null}
                <ChevronRight size={12} aria-hidden />
              </button>
            )
          })}
          {hasMore ? (
            <button
              type="button"
              className="pr-files-load"
              disabled={loading}
              onClick={() => void loadPage(nextPage)}
            >
              {loading ? <LoaderCircle size={13} className="is-spinning" aria-hidden /> : null}
              Load more files
            </button>
          ) : null}
        </div>
      </aside>

      <div className="pr-file-stage">
        {loading && files.length === 0 ? (
          <div className="pr-file-loading">
            <LoaderCircle size={17} className="is-spinning" aria-hidden /> Loading file changes
          </div>
        ) : error && files.length === 0 ? (
          <div className="pr-file-loading is-error">
            <CircleAlert size={17} aria-hidden />
            <span>{error}</span>
            <button
              type="button"
              className="pr-button is-secondary"
              onClick={() => void loadPage(1, true)}
            >
              Try again
            </button>
          </div>
        ) : selected ? (
          <PullRequestFileDiff
            file={selected}
            headRefOid={props.detail.headRefOid}
            threads={props.detail.reviewThreads.filter((thread) => thread.path === selected.path)}
            busy={props.actionBusy}
            onAction={props.onAction}
            onConfirmAction={props.onConfirmAction}
            diffRendererComponent={props.diffRendererComponent}
          />
        ) : (
          <div className="pr-file-loading">No files were returned for this pull request.</div>
        )}
      </div>
    </div>
  )
}

type DiffCommentTarget = { line: number; side: 'LEFT' | 'RIGHT' }

function PullRequestFileDiff(props: {
  file: PullRequestFile
  headRefOid: string
  threads: PullRequestReviewThread[]
  busy: boolean
  onAction: (action: PullRequestAction) => Promise<boolean>
  onConfirmAction: (action: PullRequestAction) => void
  diffRendererComponent?: PullRequestDiffView | undefined
}) {
  const hunks = useMemo(() => parsePullRequestPatch(props.file.patch ?? ''), [props.file.patch])
  const [commentLine, setCommentLine] = useState<DiffCommentTarget>()
  const [comment, setComment] = useState('')
  const DiffRendererComponent = props.diffRendererComponent ?? LazyPullRequestDiffRenderer
  const visibleCoordinates = useMemo(() => {
    const result = new Set<string>()
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.oldLine !== undefined) result.add(`LEFT:${line.oldLine}`)
        if (line.newLine !== undefined) result.add(`RIGHT:${line.newLine}`)
      }
    }
    return result
  }, [hunks])
  const unplacedThreads = useMemo(
    () =>
      props.threads.filter((thread) => {
        const coordinate = threadCoordinate(thread)
        return !coordinate || !visibleCoordinates.has(coordinate)
      }),
    [props.threads, visibleCoordinates],
  )
  const annotations = useMemo<PullRequestDiffAnnotation[]>(() => {
    const result: PullRequestDiffAnnotation[] = []
    for (const thread of props.threads) {
      const target = reviewThreadTarget(thread)
      if (!target || !visibleCoordinates.has(`${target.side}:${target.line}`)) continue
      result.push({
        side: target.side === 'LEFT' ? 'deletions' : 'additions',
        lineNumber: target.line,
        metadata: { kind: 'thread', thread },
      })
    }
    if (commentLine) {
      result.push({
        side: commentLine.side === 'LEFT' ? 'deletions' : 'additions',
        lineNumber: commentLine.line,
        metadata: { kind: 'composer' },
      })
    }
    return result
  }, [commentLine, props.threads, visibleCoordinates])

  const startComment = useCallback((target: { lineNumber: number; side: PullRequestDiffSide }) => {
    setCommentLine({
      line: target.lineNumber,
      side: target.side === 'deletions' ? 'LEFT' : 'RIGHT',
    })
    setComment('')
  }, [])

  const submitComment = async () => {
    if (!commentLine) return
    if (
      await props.onAction({
        type: 'inline_comment',
        body: comment.trim(),
        commitId: props.headRefOid,
        path: props.file.path,
        line: commentLine.line,
        side: commentLine.side,
      })
    ) {
      setComment('')
      setCommentLine(undefined)
    }
  }

  return (
    <div className="pr-file-diff">
      <header className="pr-file-head">
        <div>
          <FileCode2 size={15} aria-hidden />
          <div>
            <strong>{props.file.path}</strong>
            {props.file.previousPath ? <span>renamed from {props.file.previousPath}</span> : null}
          </div>
        </div>
        <span>
          <b className="is-addition">+{props.file.additions}</b>
          <b className="is-deletion">−{props.file.deletions}</b>
          {props.file.blobUrl ? (
            <a
              href={props.file.blobUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="Open file on GitHub"
              title="Open file on GitHub"
            >
              <ArrowUpRight size={13} aria-hidden />
            </a>
          ) : null}
        </span>
      </header>

      <div className="pr-diff-scroll">
        {hunks.length === 0 ? (
          <div className="pr-no-patch">
            <FileCode2 size={19} aria-hidden />
            <strong>Diff preview unavailable</strong>
            <p>
              The file may be binary, unchanged during a rename, or too large for GitHub's patch
              response.
            </p>
            {props.file.blobUrl ? (
              <a href={props.file.blobUrl} target="_blank" rel="noreferrer">
                Open the file on GitHub <ArrowUpRight size={12} aria-hidden />
              </a>
            ) : null}
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="pr-diffs-loading">
                <LoaderCircle size={14} className="is-spinning" aria-hidden /> Preparing diff
              </div>
            }
          >
            <DiffRendererComponent
              file={props.file}
              cacheKey={`${props.headRefOid}:${props.file.sha}`}
              annotations={annotations}
              onCommentLine={startComment}
              renderAnnotation={(annotation) => (
                <div className="pr-diffs-annotation">
                  {annotation.metadata.kind === 'composer' ? (
                    <InlineCommentEditor
                      value={comment}
                      busy={props.busy}
                      onChange={setComment}
                      onCancel={() => {
                        setCommentLine(undefined)
                        setComment('')
                      }}
                      onSubmit={() => void submitComment()}
                    />
                  ) : (
                    <InlineThread
                      thread={annotation.metadata.thread}
                      busy={props.busy}
                      onAction={props.onAction}
                      onConfirmAction={props.onConfirmAction}
                    />
                  )}
                </div>
              )}
            />
          </Suspense>
        )}

        {unplacedThreads.length > 0 ? (
          <section className="pr-unplaced-threads">
            <h3>Other review conversations</h3>
            {unplacedThreads.map((thread) => (
              <InlineThread
                key={thread.id}
                thread={thread}
                busy={props.busy}
                onAction={props.onAction}
                onConfirmAction={props.onConfirmAction}
              />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  )
}

function InlineCommentEditor(props: {
  value: string
  busy: boolean
  onChange: (value: string) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  return (
    <div className="pr-inline-editor">
      <textarea
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder="Comment on this line"
        autoFocus
      />
      <div>
        <button type="button" className="pr-button is-quiet" onClick={props.onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="pr-button is-primary"
          disabled={props.busy || !props.value.trim()}
          onClick={props.onSubmit}
        >
          Add comment
        </button>
      </div>
    </div>
  )
}

function InlineThread(props: {
  thread: PullRequestReviewThread
  busy: boolean
  onAction: (action: PullRequestAction) => Promise<boolean>
  onConfirmAction: (action: PullRequestAction) => void
}) {
  const [replying, setReplying] = useState(false)
  const [reply, setReply] = useState('')
  const last = props.thread.comments.at(-1)
  return (
    <article className={`pr-inline-thread${props.thread.resolved ? ' is-resolved' : ''}`}>
      <header>
        <span>{props.thread.resolved ? 'Resolved conversation' : 'Review conversation'}</span>
        <button
          type="button"
          disabled={props.busy}
          onClick={() =>
            void props.onAction({
              type: 'resolve_thread',
              threadId: props.thread.id,
              resolved: !props.thread.resolved,
            })
          }
        >
          {props.thread.resolved ? (
            <RotateCcw size={11} aria-hidden />
          ) : (
            <Check size={11} aria-hidden />
          )}
          {props.thread.resolved ? 'Reopen' : 'Resolve'}
        </button>
      </header>
      {props.thread.comments.map((comment) => (
        <InlineThreadComment
          key={comment.id}
          comment={comment}
          busy={props.busy}
          onAction={props.onAction}
          onConfirmAction={props.onConfirmAction}
        />
      ))}
      {replying ? (
        <div className="pr-inline-thread-reply">
          <textarea value={reply} onChange={(event) => setReply(event.target.value)} autoFocus />
          <div>
            <button type="button" className="pr-button is-quiet" onClick={() => setReplying(false)}>
              <X size={11} aria-hidden /> Cancel
            </button>
            <button
              type="button"
              className="pr-button is-primary"
              disabled={props.busy || !reply.trim() || !last?.databaseId}
              onClick={() => {
                if (!last?.databaseId) return
                void props
                  .onAction({
                    type: 'reply_to_review',
                    commentId: last.databaseId,
                    body: reply.trim(),
                  })
                  .then((success) => {
                    if (success) {
                      setReply('')
                      setReplying(false)
                    }
                  })
              }}
            >
              Reply
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="pr-inline-reply" onClick={() => setReplying(true)}>
          Reply
        </button>
      )}
    </article>
  )
}

function InlineThreadComment(props: {
  comment: PullRequestReviewThread['comments'][number]
  busy: boolean
  onAction: (action: PullRequestAction) => Promise<boolean>
  onConfirmAction: (action: PullRequestAction) => void
}) {
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(props.comment.body)

  return (
    <div className="pr-inline-thread-comment">
      <header>
        <strong>{props.comment.author.login}</strong>
        {props.comment.viewerDidAuthor && props.comment.databaseId ? (
          <Menu
            align="right"
            drop="down"
            label="Review comment actions"
            trigger={() => <Ellipsis size={12} aria-hidden />}
          >
            {(close) => (
              <>
                <MenuItem
                  title="Edit comment"
                  icon={<Pencil size={12} aria-hidden />}
                  onClick={() => {
                    setEditing(true)
                    close()
                  }}
                />
                <MenuItem
                  title="Delete comment"
                  icon={<Trash2 size={12} aria-hidden />}
                  className="is-danger"
                  onClick={() => {
                    props.onConfirmAction({
                      type: 'delete_comment',
                      kind: 'review',
                      commentId: props.comment.databaseId!,
                    })
                    close()
                  }}
                />
              </>
            )}
          </Menu>
        ) : null}
      </header>
      {editing ? (
        <div className="pr-inline-thread-reply">
          <textarea value={body} onChange={(event) => setBody(event.target.value)} autoFocus />
          <div>
            <button
              type="button"
              className="pr-button is-quiet"
              onClick={() => {
                setBody(props.comment.body)
                setEditing(false)
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="pr-button is-primary"
              disabled={props.busy || !body.trim()}
              onClick={() => {
                if (!props.comment.databaseId) return
                void props
                  .onAction({
                    type: 'update_comment',
                    kind: 'review',
                    commentId: props.comment.databaseId,
                    body: body.trim(),
                  })
                  .then((success) => success && setEditing(false))
              }}
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <Markdown text={props.comment.body} />
      )}
    </div>
  )
}

function reviewThreadTarget(thread: PullRequestReviewThread): DiffCommentTarget | undefined {
  if (thread.outdated) return undefined
  if (thread.diffSide === 'LEFT') {
    const line = thread.originalLine ?? thread.line
    return line === undefined ? undefined : { side: 'LEFT', line }
  }
  if (thread.diffSide === 'RIGHT') {
    const line = thread.line ?? thread.originalLine
    return line === undefined ? undefined : { side: 'RIGHT', line }
  }
  if (thread.line !== undefined) return { side: 'RIGHT', line: thread.line }
  return thread.originalLine === undefined ? undefined : { side: 'LEFT', line: thread.originalLine }
}

function threadCoordinate(thread: PullRequestReviewThread): string | undefined {
  const target = reviewThreadTarget(thread)
  return target ? `${target.side}:${target.line}` : undefined
}

function dedupeFiles(files: PullRequestFile[]): PullRequestFile[] {
  return [...new Map(files.map((file) => [file.path, file])).values()]
}

function fileName(path: string): string {
  return path.split('/').at(-1) ?? path
}

function parentPath(path: string): string {
  const parts = path.split('/')
  return parts.length > 1 ? parts.slice(0, -1).join('/') : 'repository root'
}
