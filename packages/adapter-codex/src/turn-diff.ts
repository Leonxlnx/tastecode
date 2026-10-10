/**
 * A rollout keeps one patch per edit, while live Codex sends the turn's net
 * diff. Patches that edit the same file are composed into that file's net
 * patch, so the file is listed once with the turn's line counts. A file whose
 * patches cannot be composed keeps them in order, which Git still reverses.
 */
export function turnDiff(patches: readonly string[]): string {
  const files = new Map<string, string[]>()
  for (const patch of patches) {
    const key = patch.split('\n', 1)[0]!
    const edits = files.get(key) ?? []
    // Each patch ends its own last hunk: `git apply --recount` would read a
    // blank separator line as one more context line, and Undo would fail.
    edits.push(patch.endsWith('\n') ? patch : `${patch}\n`)
    files.set(key, edits)
  }
  return [...files.values()]
    .map((edits) => (edits.length === 1 ? edits[0]! : (composeFile(edits) ?? edits.join(''))))
    .join('')
}

type Op =
  { kind: 'keep'; count: number; text?: string } | { kind: 'delete' | 'insert'; text: string }

type Patch = { headers: string[]; ops: Op[] }

const CONTEXT = 3

function composeFile(edits: readonly string[]): string | undefined {
  const parsed = edits.map(parse)
  if (!parsed.every((patch): patch is Patch => patch !== undefined)) return undefined
  let ops = parsed[0]!.ops
  for (const patch of parsed.slice(1)) {
    const next = compose(ops, patch.ops)
    if (!next) return undefined
    ops = next
  }
  const body = hunks(unchanged(ops))
  const first = parsed[0]!.headers
  const last = parsed.at(-1)!.headers
  const created = first.at(-2) === '--- /dev/null'
  const deleted = last.at(-1) === '+++ /dev/null'
  if (created && deleted) return body ? undefined : ''
  if (!body) {
    // A file that ends up created or deleted empty keeps its header-only patch.
    const mode = created ? first.slice(1, -2) : deleted ? last.slice(1, -2) : []
    return mode.length ? [first[0], ...mode, ''].join('\n') : ''
  }
  return [
    first[0],
    ...(created ? first.slice(1, -2) : []),
    ...(deleted ? last.slice(1, -2) : []),
    first.at(-2),
    last.at(-1),
    `${body}\n`,
  ].join('\n')
}

/** A patch as edits of its whole file; `keep` lines outside the hunks have no text. */
function parse(patch: string): Patch | undefined {
  const lines = patch.replace(/\n$/, '').split('\n')
  let index = lines.findIndex((line) => line.startsWith('@@'))
  const headers = lines.slice(0, index)
  if (
    index < 0 ||
    !headers[0]?.startsWith('diff --git ') ||
    !headers.at(-2)?.startsWith('--- ') ||
    !headers.at(-1)?.startsWith('+++ ') ||
    headers.length > 4 ||
    (headers.length === 4 && !/^(?:new|deleted) file mode /.test(headers[1]!))
  )
    return undefined
  const ops: Op[] = []
  let line = 1
  while (index < lines.length) {
    const start = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(lines[index]!)
    if (!start) return undefined
    const rows: string[] = []
    for (index += 1; index < lines.length && !lines[index]!.startsWith('@@'); index += 1)
      rows.push(lines[index]!)
    // `\ No newline at end of file` and blank lines are left to Git.
    if (rows.length === 0 || rows.some((row) => !/^[ +-]/.test(row))) return undefined
    const oldCount = rows.filter((row) => !row.startsWith('+')).length
    const first = oldCount === 0 ? Number(start[1]) + 1 : Number(start[1])
    if (first < line) return undefined
    if (first > line) ops.push({ kind: 'keep', count: first - line })
    for (const row of rows) {
      const text = row.slice(1)
      if (row.startsWith(' ')) ops.push({ kind: 'keep', count: 1, text })
      else ops.push({ kind: row.startsWith('-') ? 'delete' : 'insert', text })
    }
    line = first + oldCount
  }
  ops.push({ kind: 'keep', count: Infinity })
  return { headers, ops }
}

/** Edits from A to B followed by edits from B to C, as edits from A to C. */
function compose(first: readonly Op[], second: readonly Op[]): Op[] | undefined {
  const out: Op[] = []
  let i = 0
  let j = 0
  let a = first[0]!
  let b = second[0]!
  for (;;) {
    if (a.kind === 'delete') {
      out.push(a)
      a = first[++i]!
      continue
    }
    if (b.kind === 'insert') {
      out.push(b)
      b = second[++j]!
      continue
    }
    // `a` produces a line of B and `b` consumes it.
    if (a.kind === 'keep' && b.kind === 'keep' && a.count === Infinity && b.count === Infinity) {
      out.push(a)
      return out
    }
    if (a.text !== undefined && b.text !== undefined && a.text !== b.text) return undefined
    const count = a.kind === 'keep' && b.kind === 'keep' ? Math.min(a.count, b.count) : 1
    if (a.kind === 'keep' && b.kind === 'keep') {
      const text = a.text ?? b.text
      out.push(text === undefined ? { kind: 'keep', count } : { kind: 'keep', count, text })
    } else if (a.kind === 'keep' && b.kind === 'delete') {
      out.push(b)
    } else if (a.kind === 'insert' && b.kind === 'keep') {
      out.push(a)
    }
    a =
      a.kind === 'keep' && a.count > count ? { kind: 'keep', count: a.count - count } : first[++i]!
    b =
      b.kind === 'keep' && b.count > count ? { kind: 'keep', count: b.count - count } : second[++j]!
  }
}

/**
 * A later edit that restores what an earlier one removed leaves the same line
 * deleted and inserted again. Lines that both ends of a change share are kept.
 */
function unchanged(ops: readonly Op[]): Op[] {
  const out: Op[] = []
  for (let index = 0; index < ops.length;) {
    if (ops[index]!.kind === 'keep') {
      out.push(ops[index++]!)
      continue
    }
    const removed: string[] = []
    const added: string[] = []
    for (; index < ops.length && ops[index]!.kind !== 'keep'; index += 1)
      (ops[index]!.kind === 'delete' ? removed : added).push(ops[index]!.text!)
    let start = 0
    while (start < removed.length && start < added.length && removed[start] === added[start])
      start += 1
    let end = 0
    while (
      end < removed.length - start &&
      end < added.length - start &&
      removed.at(-1 - end) === added.at(-1 - end)
    )
      end += 1
    const keep = (text: string): Op => ({ kind: 'keep', count: 1, text })
    out.push(
      ...removed.slice(0, start).map(keep),
      ...removed.slice(start, removed.length - end).map((text): Op => ({ kind: 'delete', text })),
      ...added.slice(start, added.length - end).map((text): Op => ({ kind: 'insert', text })),
      ...removed.slice(removed.length - end).map(keep),
    )
  }
  return out
}

/** Unified hunks with up to three lines of known context around each change. */
function hunks(ops: readonly Op[]): string {
  type Hunk = {
    oldStart: number
    newStart: number
    oldEnd: number
    trailing: number
    rows: string[]
  }
  const out: string[] = []
  let current: Hunk | undefined
  let lead: Array<{ text: string; oldLine: number; newLine: number }> = []
  let oldLine = 1
  let newLine = 1
  const close = () => {
    if (!current) return
    const oldCount = current.rows.filter((row) => !row.startsWith('+')).length
    const newCount = current.rows.filter((row) => !row.startsWith('-')).length
    out.push(
      `@@ -${oldCount ? current.oldStart : current.oldStart - 1},${oldCount} +${newCount ? current.newStart : current.newStart - 1},${newCount} @@`,
      ...current.rows,
    )
  }

  for (const op of ops) {
    if (op.kind === 'keep') {
      if (op.text === undefined) {
        lead = []
      } else if (current && current.oldEnd === oldLine && current.trailing < CONTEXT) {
        current.rows.push(` ${op.text}`)
        current.trailing += 1
        current.oldEnd += 1
      } else {
        lead.push({ text: op.text, oldLine, newLine })
        if (lead.length > CONTEXT) lead.shift()
      }
      if (op.count !== Infinity) {
        oldLine += op.count
        newLine += op.count
      }
      continue
    }
    const start = lead[0] ?? { oldLine, newLine }
    if (!current || current.oldEnd !== start.oldLine) {
      close()
      current = {
        oldStart: start.oldLine,
        newStart: start.newLine,
        oldEnd: start.oldLine,
        trailing: 0,
        rows: [],
      }
    }
    current.rows.push(...lead.map((entry) => ` ${entry.text}`))
    lead = []
    current.rows.push(`${op.kind === 'delete' ? '-' : '+'}${op.text}`)
    if (op.kind === 'delete') oldLine += 1
    else newLine += 1
    current.oldEnd = oldLine
    current.trailing = 0
  }
  close()
  return out.join('\n')
}
