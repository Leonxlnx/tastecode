import type { DiffDecision, DiffFile, DiffHunk, DiffLine, SessionDiff } from '@harness/contracts'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { takeSnapshot } from './checkpoint.js'
import type { Store } from './store.js'

const run = promisify(execFile)

type ParsedHunk = { value: DiffHunk; patch: string }
type ParsedFile = { value: DiffFile; patch: string; targetId: string; hunks: ParsedHunk[] }
type ParsedDiff = { value: SessionDiff; files: ParsedFile[] }
type DecisionReader = Pick<Store, 'diffDecision'>

const NO_DECISIONS: DecisionReader = { diffDecision: () => undefined }

export class StaleDiffSnapshotError extends Error {
  constructor() {
    super('Refresh the diff and try again.')
    this.name = 'StaleDiffSnapshotError'
  }
}

export async function readSessionDiff(
  repoPath: string,
  threadId: string,
  store: Store,
): Promise<SessionDiff> {
  return (await parseDiff(repoPath, threadId, store)).value
}

/** Read the current checkout against HEAD without enabling destructive review actions. */
export async function readWorkspaceDiff(repoPath: string): Promise<SessionDiff> {
  return (await parseDiff(repoPath, `workspace-${digest(repoPath)}`, NO_DECISIONS)).value
}

export async function reviewDiffHunk(
  repoPath: string,
  threadId: string,
  version: string,
  filePath: string,
  hunkId: string,
  decision: DiffDecision,
  store: Store,
): Promise<SessionDiff> {
  const diff = await currentDiff(repoPath, threadId, version, store)
  const file = diff.files.find((entry) => entry.value.path === filePath)
  const hunk = file?.hunks.find((entry) => entry.value.id === hunkId)
  if (!file || !hunk) throw new Error('diff hunk not found')

  if (decision === 'reject') await reverseUnifiedDiff(repoPath, hunk.patch)
  store.setDiffDecision(threadId, hunkTarget(hunkId), decision)
  return readSessionDiff(repoPath, threadId, store)
}

export async function reviewDiffFile(
  repoPath: string,
  threadId: string,
  version: string,
  filePath: string,
  decision: DiffDecision,
  store: Store,
): Promise<SessionDiff> {
  const diff = await currentDiff(repoPath, threadId, version, store)
  const file = diff.files.find((entry) => entry.value.path === filePath)
  if (!file) throw new Error('diff file not found')

  if (decision === 'reject') await reverseUnifiedDiff(repoPath, file.patch)
  store.setDiffDecision(threadId, fileTarget(file.targetId), decision)
  return readSessionDiff(repoPath, threadId, store)
}

async function currentDiff(
  repoPath: string,
  threadId: string,
  version: string,
  store: Store,
): Promise<ParsedDiff> {
  const diff = await parseDiff(repoPath, threadId, store)
  if (diff.value.version !== version) throw new StaleDiffSnapshotError()
  return diff
}

async function parseDiff(
  repoPath: string,
  threadId: string,
  store: DecisionReader,
): Promise<ParsedDiff> {
  const snapshot = await takeSnapshot(repoPath)
  const version = (await git(repoPath, ['rev-parse', `${snapshot.commit}^{tree}`])).trim()
  const files = await changedFiles(repoPath, snapshot.commit)
  // Bounded fan-out: a formatter sweep can touch thousands of files, and one
  // git process per file all at once hits Windows process-creation limits.
  const parsed: ParsedFile[] = []
  const batch = 8
  for (let offset = 0; offset < files.length; offset += batch) {
    parsed.push(...(await Promise.all(files.slice(offset, offset + batch).map(parseFile))))
  }

  async function parseFile(
    file: Awaited<ReturnType<typeof changedFiles>>[number],
  ): Promise<ParsedFile> {
    const paths = file.previousPath ? [file.previousPath, file.path] : [file.path]
    const patch = await git(repoPath, [
      'diff',
      '--binary',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--find-renames',
      '--unified=3',
      'HEAD',
      snapshot.commit,
      '--',
      ...paths,
    ])
    const hunks = parseHunks(file.path, patch, file.status === 'renamed')
    const targetId = digest(`file\0${file.path}\0${patch}`)
    const fileDecision = store.diffDecision(threadId, fileTarget(targetId))
    const value: DiffFile = {
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      status: file.status,
      binary: patch.includes('GIT binary patch') || patch.includes('Binary files '),
      hunks: hunks.map((hunk) => {
        const decision = store.diffDecision(threadId, hunkTarget(hunk.value.id))
        return { ...hunk.value, ...(decision ? { decision } : {}) }
      }),
      ...(fileDecision ? { decision: fileDecision } : {}),
    }
    return { value, patch, targetId, hunks }
  }

  return {
    value: { threadId, version, files: parsed.map((file) => file.value) },
    files: parsed,
  }
}

async function changedFiles(
  repoPath: string,
  commit: string,
): Promise<
  Array<{
    path: string
    previousPath?: string | undefined
    status: DiffFile['status']
  }>
> {
  const fields = (
    await git(repoPath, ['diff', '--name-status', '-z', '--find-renames', 'HEAD', commit])
  )
    .split('\0')
    .filter(Boolean)
  const files: Array<{
    path: string
    previousPath?: string | undefined
    status: DiffFile['status']
  }> = []

  for (let index = 0; index < fields.length;) {
    const code = fields[index++] ?? ''
    if (code.startsWith('R')) {
      const previousPath = fields[index++]
      const path = fields[index++]
      if (previousPath && path) files.push({ path, previousPath, status: 'renamed' })
      continue
    }
    const path = fields[index++]
    if (!path) continue
    const status = code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified'
    files.push({ path, status })
  }
  return files
}

function parseHunks(filePath: string, patch: string, renamed: boolean): ParsedHunk[] {
  const lines = patch.split('\n')
  const starts = lines
    .map((line, index) => (line.startsWith('@@ ') ? index : -1))
    .filter((index) => index >= 0)
  const oldHeader = lines.find((line) => line.startsWith('--- '))
  const newHeader = lines.find((line) => line.startsWith('+++ '))
  if (!oldHeader || !newHeader) return []

  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length
    const rawLines = lines.slice(start, end)
    while (rawLines.at(-1) === '') rawLines.pop()
    const raw = `${rawLines.join('\n')}\n`
    const header = rawLines[0] ?? ''
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header)
    if (!match) throw new Error(`could not parse diff hunk: ${header}`)

    let oldLine = Number(match[1])
    let newLine = Number(match[3])
    const values: DiffLine[] = []
    for (const line of rawLines.slice(1)) {
      if (line === '\\ No newline at end of file') {
        const previous = values.at(-1)
        if (previous) previous.noNewlineAtEnd = true
      } else if (line.startsWith(' ')) {
        values.push({
          kind: 'context',
          oldLine: oldLine++,
          newLine: newLine++,
          text: line.slice(1),
        })
      } else if (line.startsWith('+')) {
        values.push({ kind: 'addition', newLine: newLine++, text: line.slice(1) })
      } else if (line.startsWith('-')) {
        values.push({ kind: 'deletion', oldLine: oldLine++, text: line.slice(1) })
      }
    }

    const body = `${rawLines.slice(1).join('\n')}\n`
    const id = digest(`hunk\0${filePath}\0${match[1]}\0${body}`)
    const applyOldHeader = renamed ? `--- ${newHeader.slice(4)}` : oldHeader
    return {
      value: {
        id,
        header,
        oldStart: Number(match[1]),
        oldLines: Number(match[2] ?? 1),
        newStart: Number(match[3]),
        newLines: Number(match[4] ?? 1),
        lines: values,
      },
      patch: `${applyOldHeader}\n${newHeader}\n${raw}`,
    }
  })
}

/** Reverse one provider or Git-generated patch without touching unrelated work. */
export async function reverseUnifiedDiff(repoPath: string, patch: string): Promise<void> {
  const roots = new Set([gitPath(path.resolve(repoPath)), gitPath(await realpath(repoPath))])
  let insideContent = false
  const relative = patch
    .split('\n')
    .map((line) => {
      if (line.startsWith('diff --git ')) {
        insideContent = false
        return relativePatchPath(line, roots)
      }
      if (line.startsWith('@@ ') || line === 'GIT binary patch') insideContent = true
      if (insideContent) return line
      if (
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('rename from ') ||
        line.startsWith('rename to ') ||
        line.startsWith('copy from ') ||
        line.startsWith('copy to ') ||
        line.startsWith('Binary files ')
      ) {
        return relativePatchPath(line, roots)
      }
      return line
    })
    .join('\n')

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'git',
      ['apply', '--reverse', '--binary', '--recount', '--whitespace=nowarn', '-'],
      { cwd: repoPath, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] },
    )
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.once('error', reject)
    // stdin is a Socket; an unhandled EPIPE/ENOENT on it is an uncaught
    // exception that takes the whole server down. The child's error/close
    // path already reports the failure.
    child.stdin.on('error', () => {})
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || 'could not apply diff decision'))
    })
    child.stdin.end(relative)
  })
}

function gitPath(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

function relativePatchPath(line: string, roots: ReadonlySet<string>): string {
  for (const root of roots) {
    if (root === '/' || /^[A-Za-z]:$/.test(root)) continue
    line = line.replaceAll(`${root}/`, '')
  }
  return line
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    // Sessions that touch a lot of code produce diffs well past Node's 1 MiB
    // default, and ENOBUFS would break review for exactly those sessions.
    const { stdout } = await run('git', args, {
      cwd,
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    const parsed = z.object({ stderr: z.string().optional() }).safeParse(error)
    const stderr = parsed.success ? parsed.data.stderr : undefined
    throw new Error(stderr?.trim() || (error instanceof Error ? error.message : String(error)))
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, 22)
}

function hunkTarget(id: string): string {
  return `hunk:${id}`
}

function fileTarget(id: string): string {
  return `file:${id}`
}
