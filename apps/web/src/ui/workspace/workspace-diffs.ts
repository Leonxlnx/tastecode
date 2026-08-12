import { parsePatchFiles, type CodeViewDiffItem } from '@pierre/diffs'
import type { DiffFile } from '@harness/contracts'

export type WorkspaceDiffFallback = {
  file: DiffFile
  reason: 'binary' | 'parse-error'
}

export type WorkspaceDiffCollection = {
  items: CodeViewDiffItem[]
  fallbacks: WorkspaceDiffFallback[]
}

export function workspaceDiffCollection(
  version: string,
  files: readonly DiffFile[],
): WorkspaceDiffCollection {
  const items: CodeViewDiffItem[] = []
  const fallbacks: WorkspaceDiffFallback[] = []
  const itemVersion = hashVersion(version)

  for (const file of files) {
    if (file.binary) {
      fallbacks.push({ file, reason: 'binary' })
      continue
    }

    try {
      const patches = parsePatchFiles(workspaceDiffFilePatch(file), `${version}:${file.path}`, true)
      const fileDiff =
        patches.length === 1 && patches[0]?.files.length === 1 ? patches[0].files[0] : undefined

      if (!fileDiff) {
        fallbacks.push({ file, reason: 'parse-error' })
        continue
      }

      if (file.status === 'renamed' && file.previousPath) {
        fileDiff.prevName = file.previousPath
        fileDiff.type = file.hunks.length === 0 ? 'rename-pure' : 'rename-changed'
      }

      items.push({
        id: workspaceDiffItemId(file.path),
        type: 'diff',
        fileDiff,
        version: itemVersion,
      })
    } catch {
      fallbacks.push({ file, reason: 'parse-error' })
    }
  }

  return { items, fallbacks }
}

export function workspaceDiffFilePatch(file: DiffFile): string {
  const previousPath = file.previousPath ?? file.path
  const lines = [`diff --git a/${previousPath} b/${file.path}`]

  if (file.hunks.length === 0) {
    if (file.status === 'added') lines.push('new file mode 100644')
    else if (file.status === 'deleted') lines.push('deleted file mode 100644')
    else if (file.status === 'renamed') {
      lines.push('similarity index 100%', `rename from ${previousPath}`, `rename to ${file.path}`)
    }
  } else {
    const oldPath = file.status === 'added' ? '/dev/null' : `a/${previousPath}`
    const newPath = file.status === 'deleted' ? '/dev/null' : `b/${file.path}`
    lines.push(`--- ${oldPath}`, `+++ ${newPath}`)
  }

  for (const hunk of file.hunks) {
    lines.push(hunk.header)
    for (const line of hunk.lines) {
      const prefix = line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '-' : ' '
      lines.push(`${prefix}${line.text}`)
      if (line.noNewlineAtEnd) lines.push('\\ No newline at end of file')
    }
  }

  return `${lines.join('\n')}\n`
}

export function workspaceDiffItemId(path: string): string {
  return `workspace-diff:${path}`
}

function hashVersion(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}
