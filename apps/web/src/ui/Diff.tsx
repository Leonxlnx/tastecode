import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, FilePenLine } from 'lucide-react'
import type { Transport } from '../transport.js'
import { DiffReview } from './DiffReview.js'

/**
 * Everything the current turn changed, as one unified diff.
 *
 * Collapsed by default and pinned above the composer: "what did it do to my
 * repo" is a different question from "what did it do next", and answering it
 * should never mean scrolling back through a transcript.
 *
 * The summary stays cheap; opening Review fetches the authoritative structured
 * snapshot so decisions always carry the server's current version.
 */

type Line = { text: string; kind: 'add' | 'del' | 'meta' | 'hunk' | 'ctx' }
type FileEntry = { path: string; added: number; removed: number }

export function Diff({
  diff,
  threadId,
  transport,
}: {
  diff: string | undefined
  threadId?: string | undefined
  transport?: Transport | undefined
}) {
  const parsed = useMemo(() => (diff ? parseDiff(diff) : null), [diff])
  const [reviewing, setReviewing] = useState(false)
  const [showAllFiles, setShowAllFiles] = useState(false)

  useEffect(() => {
    setReviewing(false)
    setShowAllFiles(false)
  }, [diff])

  if (!parsed || parsed.lines.length === 0) return null
  const visibleFiles = showAllFiles ? parsed.fileEntries : parsed.fileEntries.slice(0, 3)
  const hiddenFiles = parsed.fileEntries.length - visibleFiles.length

  return (
    <section className={`diff ${reviewing ? 'is-reviewing' : ''}`} aria-label="Edited files">
      <div className="diff__head">
        <span className="diff__icon" aria-hidden>
          <FilePenLine size={15} strokeWidth={1.8} />
        </span>
        <span className="diff__copy">
          <span className="diff__title">
            Edited {parsed.files} file{parsed.files === 1 ? '' : 's'}
          </span>
          <ChangeStats added={parsed.added} removed={parsed.removed} className="diff__stat" />
        </span>
        <button
          type="button"
          className="diff__review"
          aria-expanded={reviewing}
          onClick={() => setReviewing((current) => !current)}
        >
          {reviewing ? 'Close' : 'Review'}
        </button>
      </div>

      <ul className="diff__file-list">
        {visibleFiles.map((file, index) => (
          <li className="diff__file" key={`${file.path}:${index}`}>
            <FilePath path={file.path} />
            <ChangeStats added={file.added} removed={file.removed} className="diff__file-stat" />
          </li>
        ))}
        {parsed.fileEntries.length > 3 ? (
          <li className="diff__more">
            <button type="button" onClick={() => setShowAllFiles((current) => !current)}>
              {showAllFiles
                ? 'Show fewer files'
                : `Show ${hiddenFiles} more file${hiddenFiles === 1 ? '' : 's'}`}
              <ChevronDown className={showAllFiles ? 'is-open' : ''} size={14} aria-hidden />
            </button>
          </li>
        ) : null}
      </ul>

      {reviewing && threadId && transport ? (
        <DiffReview transport={transport} threadId={threadId} />
      ) : reviewing ? (
        <pre className="diff__body">
          {parsed.lines.map((line, index) => (
            <span key={index} className={`dline dline--${line.kind}`}>
              {line.text || ' '}
            </span>
          ))}
        </pre>
      ) : null}
    </section>
  )
}

function ChangeStats({
  added,
  removed,
  className,
}: {
  added: number
  removed: number
  className: string
}) {
  if (added === 0 && removed === 0) return null

  return (
    <span className={className}>
      {added > 0 ? <span className="stat stat--add">+{added}</span> : null}
      {removed > 0 ? <span className="stat stat--del">−{removed}</span> : null}
    </span>
  )
}

function FilePath({ path }: { path: string }) {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const directory = separator >= 0 ? path.slice(0, separator + 1) : ''
  const name = path.slice(separator + 1)

  return (
    <span className="diff__path">
      {directory ? <span className="diff__directory">{directory}</span> : null}
      <span>{name || path}</span>
    </span>
  )
}

export function parseDiff(diff: string): {
  lines: Line[]
  added: number
  removed: number
  files: number
  fileEntries: FileEntry[]
} {
  const lines: Line[] = []
  const fileEntries: FileEntry[] = []
  let added = 0
  let removed = 0
  let currentFile: FileEntry | undefined

  // `--- a/x` (a header) and `--- reset the sequence` (a deleted `-- reset`
  // comment) are textually indistinguishable. Position is the discriminator:
  // headers only appear before a file's first hunk. Inside a hunk, a leading
  // +/- is always a change — which is what git's own parsers assume.
  let inHunk = false

  const addFile = (path: string) => {
    currentFile = { path, added: 0, removed: 0 }
    fileEntries.push(currentFile)
    inHunk = false
  }

  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git')) {
      addFile(pathFromGitHeader(text))
      lines.push({ text, kind: 'meta' })
    } else if (
      !inHunk &&
      (text.startsWith('+++ ') || text.startsWith('--- ') || text.startsWith('index '))
    ) {
      if (text.startsWith('+++ ') && currentFile) {
        const destination = text.slice(4).trim()
        if (destination !== '/dev/null') currentFile.path = stripGitPrefix(destination)
      }
      lines.push({ text, kind: 'meta' })
    } else if (text.startsWith('@@')) {
      inHunk = true
      lines.push({ text, kind: 'hunk' })
    } else if (text.startsWith('+')) {
      added += 1
      currentFile ??= { path: 'Changes', added: 0, removed: 0 }
      if (!fileEntries.includes(currentFile)) fileEntries.push(currentFile)
      currentFile.added += 1
      lines.push({ text, kind: 'add' })
    } else if (text.startsWith('-')) {
      removed += 1
      currentFile ??= { path: 'Changes', added: 0, removed: 0 }
      if (!fileEntries.includes(currentFile)) fileEntries.push(currentFile)
      currentFile.removed += 1
      lines.push({ text, kind: 'del' })
    } else {
      lines.push({ text, kind: 'ctx' })
    }
  }

  if (fileEntries.length === 0) fileEntries.push({ path: 'Changes', added, removed })

  return {
    lines,
    added,
    removed,
    files: fileEntries.length,
    fileEntries,
  }
}

function pathFromGitHeader(text: string): string {
  const marker = text.lastIndexOf(' b/')
  if (marker >= 0) return stripGitPrefix(text.slice(marker + 1))

  const quoted = text.match(/\s"b\/(.+)"$/)
  return quoted?.[1] ?? 'Changes'
}

function stripGitPrefix(path: string): string {
  const unquoted = path.replace(/^"|"$/g, '')
  return unquoted.startsWith('a/') || unquoted.startsWith('b/') ? unquoted.slice(2) : unquoted
}
