import { useMemo } from 'react'

/**
 * Everything the current turn changed, as one unified diff.
 *
 * Collapsed by default and pinned above the composer: "what did it do to my
 * repo" is a different question from "what did it do next", and answering it
 * should never mean scrolling back through a transcript.
 *
 * This is a reading view, not the review surface — accept/reject per hunk is
 * M3. Showing the change now is still worth it, because an agent editing files
 * you cannot see is the thing people distrust most.
 */

type Line = { text: string; kind: 'add' | 'del' | 'meta' | 'hunk' | 'ctx' }

export function Diff({ diff }: { diff: string | undefined }) {
  const parsed = useMemo(() => (diff ? parseDiff(diff) : null), [diff])
  if (!parsed || parsed.lines.length === 0) return null

  return (
    <details className="diff">
      <summary className="diff__head">
        <span className="diff__title">Changes</span>
        <span className="diff__files">
          {parsed.files} file{parsed.files === 1 ? '' : 's'}
        </span>
        <span className="diff__stat">
          <span className="stat stat--add">+{parsed.added}</span>
          <span className="stat stat--del">−{parsed.removed}</span>
        </span>
      </summary>
      <pre className="diff__body">
        {parsed.lines.map((line, index) => (
          <span key={index} className={`dline dline--${line.kind}`}>
            {line.text || ' '}
          </span>
        ))}
      </pre>
    </details>
  )
}

export function parseDiff(diff: string): {
  lines: Line[]
  added: number
  removed: number
  files: number
} {
  const lines: Line[] = []
  let added = 0
  let removed = 0
  let files = 0

  for (const text of diff.split('\n')) {
    // Order matters: `+++`/`---` are file headers, not additions and deletions.
    if (text.startsWith('diff --git')) {
      files += 1
      lines.push({ text, kind: 'meta' })
    } else if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('index ')) {
      lines.push({ text, kind: 'meta' })
    } else if (text.startsWith('@@')) {
      lines.push({ text, kind: 'hunk' })
    } else if (text.startsWith('+')) {
      added += 1
      lines.push({ text, kind: 'add' })
    } else if (text.startsWith('-')) {
      removed += 1
      lines.push({ text, kind: 'del' })
    } else {
      lines.push({ text, kind: 'ctx' })
    }
  }

  return { lines, added, removed, files: Math.max(files, 1) }
}
