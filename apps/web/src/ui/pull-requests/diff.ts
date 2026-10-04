type PullRequestDiffLine = {
  id: string
  kind: 'context' | 'addition' | 'deletion' | 'meta'
  text: string
  oldLine?: number | undefined
  newLine?: number | undefined
}

export type PullRequestDiffHunk = {
  id: string
  header: string
  lines: PullRequestDiffLine[]
}

/** Parse GitHub's per-file unified patch without copying or re-tokenizing it in render. */
export function parsePullRequestPatch(patch: string): PullRequestDiffHunk[] {
  const hunks: PullRequestDiffHunk[] = []
  let current: PullRequestDiffHunk | undefined
  let oldLine = 0
  let newLine = 0

  for (const rawLine of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(rawLine)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      current = {
        id: `${hunks.length}:${oldLine}:${newLine}`,
        header: rawLine,
        lines: [],
      }
      hunks.push(current)
      continue
    }

    if (!current) continue
    const id = `${current.id}:${current.lines.length}`
    if (rawLine.startsWith('+')) {
      current.lines.push({ id, kind: 'addition', text: rawLine.slice(1), newLine })
      newLine += 1
    } else if (rawLine.startsWith('-')) {
      current.lines.push({ id, kind: 'deletion', text: rawLine.slice(1), oldLine })
      oldLine += 1
    } else if (rawLine.startsWith('\\')) {
      current.lines.push({ id, kind: 'meta', text: rawLine })
    } else {
      current.lines.push({
        id,
        kind: 'context',
        text: rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine,
        oldLine,
        newLine,
      })
      oldLine += 1
      newLine += 1
    }
  }

  return hunks
}
