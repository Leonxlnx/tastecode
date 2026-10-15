import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { DiffDecision, DiffHunk, DiffLine, SessionDiff } from '@harness/contracts'
import { IconCheck as Check, IconRefresh as RefreshCw, IconX as X } from '@tabler/icons-react'
import type { Transport } from '../transport.js'
import { SkeletonCode, SkeletonStatus } from './Skeleton.js'

/**
 * The server's refusal for a chat that edits the project checkout itself
 * (`#diffRepoPath` in apps/server/src/orchestrator.ts). Accepting or rejecting
 * hunks there would touch the user's own work, so only the turn's patch is shown.
 */
const SHARED_CHECKOUT = 'requires an isolated session'

export function DiffReview({
  transport,
  threadId,
  fallback,
}: {
  transport: Transport
  threadId: string
  /** Shown instead of the review when the chat has no isolated checkout. */
  fallback?: ReactNode | undefined
}) {
  const [diff, setDiff] = useState<SessionDiff>()
  const [sharedCheckout, setSharedCheckout] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string>()
  const [showSlowLoad, setShowSlowLoad] = useState(false)

  // Generation-guarded: an in-flight diff for the previous thread (or an
  // unmounted panel) must not land its snapshot on top of the current one.
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const mine = ++generation.current
    try {
      const result = await transport.request('thread.diff', { threadId })
      if (generation.current !== mine) return
      setDiff(result)
      setSharedCheckout(false)
      setStatus(undefined)
    } catch (cause) {
      if (generation.current !== mine) return
      const detail = message(cause)
      if (detail.includes(SHARED_CHECKOUT)) setSharedCheckout(true)
      else setStatus(detail)
    }
  }, [transport, threadId])

  useEffect(() => {
    void refresh()
    return () => {
      generation.current++
    }
  }, [refresh])

  useEffect(() => {
    const timer = window.setTimeout(() => setShowSlowLoad(true), 200)
    return () => window.clearTimeout(timer)
  }, [])

  async function decide(path: string, hunkId: string, decision: DiffDecision): Promise<void> {
    if (!diff) return
    setBusy(true)
    setStatus(undefined)
    try {
      const result = await transport.request('thread.reviewHunk', {
        threadId,
        version: diff.version,
        path,
        hunkId,
        decision,
      })
      setDiff(result.diff)
    } catch (cause) {
      const detail = message(cause)
      if (detail.includes('Refresh the diff')) {
        await refresh()
        setStatus('The diff changed and was refreshed. Choose again.')
      } else {
        setStatus(detail)
      }
    } finally {
      setBusy(false)
    }
  }

  if (sharedCheckout) return fallback ?? null

  // No placeholder inside the first grace period: this component remounts at
  // every turn boundary, and flashing "Loading review…" for a fast local
  // fetch reads as flicker, not information.
  if (!diff && !status) {
    if (!showSlowLoad) return null
    return (
      <SkeletonStatus label="Loading review…" className="diff-review__skeleton">
        <SkeletonCode lines={8} gutter />
      </SkeletonStatus>
    )
  }

  return (
    <div className="diff-review">
      <div className="diff-review__toolbar">
        <span>
          {diff
            ? `${diff.files.length} file${diff.files.length === 1 ? '' : 's'} in current snapshot`
            : 'Review unavailable'}
        </span>
        <button
          className="diff__review"
          type="button"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={13} aria-hidden /> Refresh
        </button>
      </div>
      {status ? (
        <p className="diff-review__status" role="status">
          {status}
        </p>
      ) : null}
      {diff?.files.length === 0 ? (
        <p className="diff-review__status">No changed files remain.</p>
      ) : null}
      {diff?.files.map((file) => (
        <section className="diff-file" key={file.path} aria-label={`Review ${file.path}`}>
          <header className="diff-file__head">
            <strong>{file.path}</strong>
            <span>{file.previousPath ? `${file.previousPath} → ${file.status}` : file.status}</span>
          </header>
          {file.binary ? <p className="diff-review__status">Binary file</p> : null}
          {file.hunks.map((hunk) => (
            <Hunk
              key={hunk.id}
              path={file.path}
              hunk={hunk}
              busy={busy}
              onDecision={(decision) => void decide(file.path, hunk.id, decision)}
            />
          ))}
        </section>
      ))}
    </div>
  )
}

function Hunk({
  path,
  hunk,
  busy,
  onDecision,
}: {
  path: string
  hunk: DiffHunk
  busy: boolean
  onDecision: (decision: DiffDecision) => void
}) {
  const highlights = wordHighlights(hunk.lines)
  return (
    <section className={`diff-hunk${hunk.decision ? ' is-reviewed' : ''}`}>
      <header className="diff-hunk__head">
        <code>{hunk.header}</code>
        <div className="diff-decisions" aria-label={`Decision for ${hunk.header} in ${path}`}>
          <button
            type="button"
            className={`diff__review${hunk.decision === 'accept' ? ' is-selected' : ''}`}
            aria-label={`Accept ${hunk.header} in ${path}`}
            disabled={busy || hunk.decision === 'accept'}
            onClick={() => onDecision('accept')}
          >
            <Check size={13} aria-hidden /> Accept
          </button>
          <button
            type="button"
            className={`diff__review${hunk.decision === 'reject' ? ' is-selected is-reject' : ''}`}
            aria-label={`Reject ${hunk.header} in ${path}`}
            disabled={busy || hunk.decision === 'reject'}
            onClick={() => onDecision('reject')}
          >
            <X size={13} aria-hidden /> Reject
          </button>
        </div>
      </header>
      {hunk.lines.map((line, index) => (
        <div className={`diff-line is-${line.kind}`} key={`${line.kind}:${index}`}>
          <span>{'oldLine' in line ? line.oldLine : ''}</span>
          <span>{'newLine' in line ? line.newLine : ''}</span>
          <code>
            <i aria-hidden>
              {line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ' '}
            </i>
            {highlights.get(index) ?? (line.text || ' ')}
          </code>
        </div>
      ))}
    </section>
  )
}

function wordHighlights(lines: DiffLine[]): Map<number, ReactNode> {
  const result = new Map<number, ReactNode>()
  for (let start = 0; start < lines.length;) {
    if (lines[start]?.kind === 'context') {
      start += 1
      continue
    }
    let end = start
    while (end < lines.length && lines[end]?.kind !== 'context') end += 1
    const changed = lines.slice(start, end).map((line, offset) => ({ line, index: start + offset }))
    const deleted = changed.filter(({ line }) => line.kind === 'deletion')
    const added = changed.filter(({ line }) => line.kind === 'addition')
    for (let index = 0; index < Math.min(deleted.length, added.length); index += 1) {
      const before = deleted[index]!
      const after = added[index]!
      const [oldText, newText] = changedWords(before.line.text, after.line.text)
      result.set(before.index, oldText)
      result.set(after.index, newText)
    }
    start = end
  }
  return result
}

function changedWords(before: string, after: string): [ReactNode, ReactNode] {
  const oldWords = before.split(/(\s+|[^\w]+)/)
  const newWords = after.split(/(\s+|[^\w]+)/)
  let prefix = 0
  while (prefix < oldWords.length && oldWords[prefix] === newWords[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < oldWords.length - prefix &&
    suffix < newWords.length - prefix &&
    oldWords.at(-1 - suffix) === newWords.at(-1 - suffix)
  )
    suffix += 1
  const render = (words: string[], kind: 'old' | 'new') => {
    // The suffix can cover a whole side (`foo()` → `await foo()`), so the
    // changed run may be empty; it must never fall back to the rest of the line.
    const changed = words.slice(prefix, words.length - suffix).join('')
    return (
      <>
        {words.slice(0, prefix).join('')}
        {changed ? <mark className={`is-${kind}`}>{changed}</mark> : null}
        {suffix ? words.slice(-suffix).join('') : ''}
      </>
    )
  }
  return [render(oldWords, 'old'), render(newWords, 'new')]
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
