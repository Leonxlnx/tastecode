import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { takeSnapshot } from './checkpoint.js'
import { parseReviewFiles, readWorkspaceDiff } from './diff-review.js'
import { gitRepositoryTemplate, removeTestFolder } from './git-fixture.test-support.js'
import * as patches from './review-patches.js'

const original = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join('')
const template = gitRepositoryTemplate('review-patches-', { 'original.txt': original })
let repo: string
const git = (args: string[], input?: string) =>
  execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8', input }).trim()
const write = (file: string, value: string | Buffer) => writeFileSync(path.join(repo, file), value)
async function compare(base: string, commit: string, scope = '.') {
  const read = () =>
    parseReviewFiles(repo, 'thread', { diffDecision: () => 'accept' }, base, commit, scope)
  vi.spyOn(patches, 'readReviewPatches').mockResolvedValueOnce(new Map())
  const legacy = await read()
  const current = await read()
  expect(current).toEqual(legacy)
  return current
}
beforeAll(() => {
  template.build()
}, 30_000)
afterAll(() => template.dispose())
beforeEach(() => {
  repo = template.create()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  removeTestFolder(repo)
})

it.each(['true', 'false'])('matches individual patches with core.quotePath=%s', async (quote) => {
  git(['config', 'core.quotePath', quote])
  const renameBody = original.replaceAll('line', 'rename fixture line')
  write('rename me', renameBody + 'distinct rename source\n')
  write('old pure name', 'pure rename with unchanged content\n')
  write('deleted', 'gone\n')
  write('second deletion', quote === 'true' ? 'previous content\n' : '')
  write('collision', 'directory replaces this\n')
  write('crlf', 'one\r\ntwo')
  git(['add', '.'])
  git(['commit', '-qm', 'fixture'])
  renameSync(path.join(repo, 'old pure name'), path.join(repo, 'new pure name'))
  renameSync(path.join(repo, 'rename me'), path.join(repo, 'renamed file'))
  write('renamed file', renameBody + 'edited after rename\n')
  write('copy', original)
  write('original.txt', 'staged version\n')
  git(['add', 'original.txt'])
  write('original.txt', 'unstaged version\n')
  for (const file of ['deleted', 'second deletion', 'collision']) rmSync(path.join(repo, file))
  mkdirSync(path.join(repo, 'collision'))
  write('collision/child', 'new child\n')
  write('crlf', 'three\r\nfour')
  write('empty added', quote === 'true' ? '' : 'nonempty addition\n')
  write('image', Buffer.from([0, 4, 9, 0, 255]))
  write('-leading', 'diff --git a/foo b/foo\n@@ -3 +4 @@\n')
  write("apostrophe's name", 'untracked\n')
  write('新 file', 'no final newline')
  mkdirSync(path.join(repo, 'space b'))
  write('space b/second', 'sibling in scope\n')
  write('space b/after', 'space and slash in the header\n')
  write('large', 'x'.repeat(1024 * 1024 + 100))
  const base = git(['rev-parse', 'HEAD'])
  const { commit } = await takeSnapshot(repo)
  const individual = vi.spyOn(patches, 'readFilePatch')
  // The oracle read sends every file through readFilePatch; whatever the second read sends
  // there is a fallback. Everything else must have come from the combined patch.
  const fallbacks = (skip: number) =>
    individual.mock.calls
      .slice(skip)
      .map((args) => args[4].path)
      .sort()
  const result = await compare(base, commit)
  expect(result).toHaveLength(17)
  expect(individual).toHaveBeenCalledTimes(17 + fallbacks(17).length)
  expect(fallbacks(17)).toEqual(
    quote === 'true'
      ? ['new pure name', 'renamed file', '新 file']
      : ['new pure name', 'renamed file'],
  )
  expect(result.find((file) => file.value.path === 'new pure name')?.value).toMatchObject({
    previousPath: 'old pure name',
    status: 'renamed',
    hunks: [],
  })
  const callsBeforeNested = individual.mock.calls.length
  const nested = await compare(base, commit, 'space b')
  expect(nested.map((f) => f.value.path)).toEqual(['space b/after', 'space b/second'])
  expect(individual).toHaveBeenCalledTimes(callsBeforeNested + 2)
  expect(result.find((file) => file.value.path === 'renamed file')?.value).toMatchObject({
    previousPath: 'rename me',
    status: 'renamed',
  })
  expect(result.find((file) => file.value.path === 'copy')?.value.status).toBe('added')
  expect(result.find((f) => f.value.path === 'image')?.patch).toContain('GIT binary patch')
})

// Tree objects can contain names and modes that Windows cannot check out.
it('matches mode-only, quoted, symbolic link and submodule entries in real Git trees', async () => {
  git(['config', 'diff.submodule', 'log'])
  const oldBlob = git(['hash-object', '-w', '--stdin'], 'old\n')
  const newBlob = git(['hash-object', '-w', '--stdin'], 'new\n')
  const oldHead = git(['rev-parse', 'HEAD'])
  const newHead = git(['commit-tree', 'HEAD^{tree}', '-p', oldHead, '-m', 'gitlink'])
  const tree = (changed: boolean) =>
    git(
      ['mktree', '-z'],
      [
        `${changed ? '100755' : '100644'} blob ${oldBlob}\tmode-only`,
        `120000 blob ${changed ? newBlob : oldBlob}\tlink`,
        `${changed ? '120000' : '100644'} blob ${newBlob}\ttype-change`,
        `100644 blob ${changed ? newBlob : oldBlob}\ta"quote`,
        `160000 commit ${changed ? newHead : oldHead}\tsub`,
      ].join('\0') + '\0',
    )
  const base = git(['commit-tree', tree(false), '-m', 'base'])
  const commit = git(['commit-tree', tree(true), '-p', base, '-m', 'captured'])
  const individual = vi.spyOn(patches, 'readFilePatch')
  const result = await compare(base, commit)
  expect(individual.mock.calls.slice(5).map((args) => args[4].path)).toEqual([
    'a"quote',
    'sub',
    'type-change',
  ])
  expect(result.map((f) => f.value.path)).toEqual([
    'a"quote',
    'link',
    'mode-only',
    'sub',
    'type-change',
  ])
  expect(result.find((f) => f.value.path === 'mode-only')?.patch).toContain('new mode 100755')
})

it('reads 200 modified files with a single patch process', async () => {
  const names = Array.from({ length: 200 }, (_, i) => `file-${i}.txt`)
  for (const name of names) write(name, 'before\n')
  git(['add', '.'])
  git(['commit', '-qm', '200 files'])
  for (const name of names) write(name, 'after\n')

  // Give both traced refreshes an existing snapshot of the same working tree.
  await takeSnapshot(repo)
  const trace = path.join(repo, '.git', 'patch.trace')
  vi.stubEnv('GIT_TRACE2_EVENT', trace)
  const commands = () =>
    readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; sid: string; argv?: string[] })
      .filter(({ event, sid }) => event === 'start' && !sid.includes('/'))
      .map(({ argv }) => argv ?? [])
  const patchCount = (starts: string[][]) =>
    starts.filter((args) => args.includes('diff') && args.includes('--binary')).length
  vi.spyOn(patches, 'readReviewPatches').mockResolvedValueOnce(new Map())
  const oldStart = performance.now()
  const before = await readWorkspaceDiff(repo)
  const oldMs = Math.round(performance.now() - oldStart)
  const oldCommands = commands()
  expect(patchCount(oldCommands)).toBe(200)
  writeFileSync(trace, '')
  const newStart = performance.now()
  const after = await readWorkspaceDiff(repo)
  const newMs = Math.round(performance.now() - newStart)
  expect(after).toEqual(before)
  expect(after.files).toHaveLength(200)
  const newCommands = commands()
  expect(patchCount(newCommands)).toBe(1)
  expect(newCommands.length).toBeLessThan(30)
  console.info('200-file Review refresh with Git tracing', {
    individual: { processes: oldCommands.length, ms: oldMs },
    batched: { processes: newCommands.length, ms: newMs },
  })
}, 150_000)

it('recovers all files when the combined patch exceeds the real 64 MiB buffer', async () => {
  // One compressed blob in the object store; each of its sixteen patches fits individually.
  const blob = git(['hash-object', '-w', '--stdin'], 'x'.repeat(4 * 1024 * 1024) + '\n')
  const base = git(['mktree'], '')
  const names = Array.from({ length: 16 }, (_, i) => `large-${i}`)
  const tree = git(['mktree', '-z'], names.map((name) => `100644 blob ${blob}\t${name}\0`).join(''))
  const decisions = { diffDecision: () => undefined }
  const bulk = patches.readReviewPatches
  let failure: unknown
  vi.spyOn(patches, 'readReviewPatches').mockImplementation((runGit, ...args) =>
    bulk(
      async (cwd, params) => {
        try {
          return await runGit(cwd, params)
        } catch (error) {
          failure = error
          throw error
        }
      },
      ...args,
    ),
  )
  const individual = vi.spyOn(patches, 'readFilePatch')
  const actual = await parseReviewFiles(repo, 'thread', decisions, base, tree)
  expect(String(failure)).toMatch(/maxBuffer/i)
  expect(individual).toHaveBeenCalledTimes(names.length)
  individual.mockRestore()
  expect(actual).toHaveLength(names.length)
  // Compare one legacy file at a time to avoid retaining a second 64 MiB Review.
  for (const file of actual) {
    const oracle = await parseReviewFiles(repo, 'thread', decisions, base, tree, file.value.path)
    expect(file).toEqual(oracle[0])
  }
}, 120_000)
