import type { DiffDecision, DiffFile, DiffHunk, DiffLine, SessionDiff } from '@harness/contracts'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { captureCli, spawnCli } from '@harness/proc/cli'
import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { snapshotBase, takeSnapshot } from './checkpoint.js'
import { canonicalCheckoutRoot } from './checkout-access.js'
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
  const root = canonicalCheckoutRoot(repoPath)
  const scope = path.relative(root, realpathSync(repoPath)) || '.'
  // Before the first commit, changes are shown against the empty tree.
  const snapshotFrom = await snapshotBase(root)
  const base = snapshotFrom.head ?? snapshotFrom.tree
  const snapshot = await takeSnapshot(repoPath)
  repoPath = root
  const tree = (await git(repoPath, ['rev-parse', `${snapshot.commit}^{tree}`])).trim()
  const version = digest(`${base}\0${tree}`)
  const files = await changedFiles(repoPath, base, snapshot.commit, scope)
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
      base,
      snapshot.commit,
      '--',
      ...paths.map((file) => `:(top,literal)${file}`),
    ])
    const hunks = parseHunks(file.path, patch, file.status === 'renamed')
    const targetId = digest(`file\0${file.path}\0${patch}`)
    const fileDecision = store.diffDecision(threadId, fileTarget(targetId))
    const value: DiffFile = {
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      status: file.status,
      binary: isBinaryPatch(patch),
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

/** Only the header can say a file is binary; its own text may quote these markers. */
function isBinaryPatch(patch: string): boolean {
  const firstHunk = patch.indexOf('\n@@ ')
  return (firstHunk < 0 ? patch : patch.slice(0, firstHunk))
    .split('\n')
    .some((line) => line === 'GIT binary patch' || line.startsWith('Binary files '))
}

async function changedFiles(
  repoPath: string,
  base: string,
  commit: string,
  scope = '.',
): Promise<
  Array<{
    path: string
    previousPath?: string | undefined
    status: DiffFile['status']
  }>
> {
  const fields = (
    await git(repoPath, [
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      base,
      commit,
      '--',
      ...(scope === '.' ? [] : [`:(top,literal)${scope}`]),
    ])
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
  let binary = false
  let missingMode = false
  // Lines the current hunk's header still counts.
  let oldLeft = 0
  let newLeft = 0
  const lines = patch.split('\n')
  const relative = lines
    .flatMap((line, index) => {
      if (line.startsWith('diff --git ')) {
        insideContent = false
        binary = false
        missingMode = true
        oldLeft = newLeft = 0
        return relativePatchPath(line, roots)
      }
      // Older imported Codex turns joined files with a blank line, which
      // `--recount` would read as one more context line of the previous hunk.
      // A blank line the hunk still counts is an empty context line, and a
      // binary patch needs its blank line.
      if (
        line === '' &&
        !binary &&
        oldLeft <= 0 &&
        newLeft <= 0 &&
        lines[index + 1]?.startsWith('diff --git ')
      )
        return []
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line)
      if (hunk) {
        insideContent = true
        oldLeft = Number(hunk[1] ?? 1)
        newLeft = Number(hunk[2] ?? 1)
      } else if (insideContent && !binary) {
        if (line === '' || line.startsWith(' ')) {
          oldLeft -= 1
          newLeft -= 1
        } else if (line.startsWith('-')) oldLeft -= 1
        else if (line.startsWith('+')) newLeft -= 1
      }
      if (line === 'GIT binary patch') insideContent = binary = true
      if (insideContent) return line
      if (line.startsWith('new file mode ') || line.startsWith('deleted file mode '))
        missingMode = false
      // Older imported Codex turns also left out a created or deleted file's
      // mode line, so Git read `/dev/null` as a path and moved the file there.
      if (missingMode && (line === '--- /dev/null' || line === '+++ /dev/null')) {
        missingMode = false
        return [line.startsWith('-') ? 'new file mode 100644' : 'deleted file mode 100644', line]
      }
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

  const child = spawnCli(
    'git',
    ['apply', '--reverse', '--binary', '--recount', '--whitespace=nowarn', '-'],
    { cwd: repoPath },
  )
  const captured = captureCli(child, 30_000)
  child.stdin.on('error', () => undefined)
  child.stdin.end(relative)
  const result = await captured
  if (result.code !== 0)
    throw new Error('Could not apply diff decision. Check the working tree and retry.')
}

function gitPath(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

function relativePatchPath(line: string, roots: ReadonlySet<string>): string {
  const relative = (value: string): string => {
    const quoted = value.startsWith('"')
    const start = quoted ? '"' : ''
    for (const root of roots) {
      if (root === '/' || /^[A-Za-z]:$/.test(root)) continue
      const spellings = quoted
        ? [quoteGitPathContent(root), quoteGitPathContent(root, false)]
        : [root]
      for (const spelling of spellings) {
        for (const prefix of ['a/', 'b/', '']) {
          const absolute = `${start}${prefix}${spelling}/`
          if (value.startsWith(absolute)) return `${start}${prefix}${value.slice(absolute.length)}`
        }
      }
    }
    return value
  }
  const diff = /^diff --git ("(?:\\.|[^"\\])*"|a\/.*?) ("(?:\\.|[^"\\])*"|b\/.*)$/.exec(line)
  if (diff) return `diff --git ${relative(diff[1]!)} ${relative(diff[2]!)}`
  const binary = /^Binary files (.+) and (.+) differ$/.exec(line)
  if (binary) return `Binary files ${relative(binary[1]!)} and ${relative(binary[2]!)} differ`
  const header = /^(--- |\+\+\+ |rename from |rename to |copy from |copy to )(.*)$/.exec(line)
  if (header) return `${header[1]}${relative(header[2]!)}`
  return line
}

function quoteGitPathContent(value: string, quoteUnicode = true): string {
  const codes = new Map([
    ['\\', '\\\\'],
    ['"', '\\"'],
    ['\t', '\\t'],
    ['\n', '\\n'],
    ['\r', '\\r'],
    ['\b', '\\b'],
    ['\f', '\\f'],
    ['\v', '\\v'],
  ])
  const escaped = value.replace(/[\\"\t\n\r\b\f\v]/g, (character) => codes.get(character)!)
  if (!quoteUnicode) return escaped
  return escaped.replace(/[^\x20-\x7e]/gu, (character) =>
    [...Buffer.from(character)].map((byte) => `\\${byte.toString(8).padStart(3, '0')}`).join(''),
  )
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
