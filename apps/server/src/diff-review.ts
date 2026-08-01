import type { DiffDecision, DiffFile, DiffHunk, DiffLine, SessionDiff } from '@harness/contracts'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { takeSnapshot } from './checkpoint.js'
import type { Store } from './store.js'

const run = promisify(execFile)

type ParsedHunk = { value: DiffHunk; patch: string }
type ParsedFile = { value: DiffFile; patch: string; targetId: string; hunks: ParsedHunk[] }
type ParsedDiff = { value: SessionDiff; files: ParsedFile[] }

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

  if (decision === 'reject') await applyReverse(repoPath, hunk.patch)
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

  if (decision === 'reject') await applyReverse(repoPath, file.patch)
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

async function parseDiff(repoPath: string, threadId: string, store: Store): Promise<ParsedDiff> {
  const snapshot = await takeSnapshot(repoPath)
  const version = (await git(repoPath, ['rev-parse', `${snapshot.commit}^{tree}`])).trim()
  const files = await changedFiles(repoPath, snapshot.commit)
  const parsed = await Promise.all(
    files.map(async (file) => {
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
    }),
  )

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

async function applyReverse(repoPath: string, patch: string): Promise<void> {
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
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || 'could not apply diff decision'))
    })
    child.stdin.end(patch)
  })
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, windowsHide: true, timeout: 20_000 })
    return stdout
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr
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
