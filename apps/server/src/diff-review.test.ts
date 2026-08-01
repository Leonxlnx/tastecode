import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readSessionDiff,
  reviewDiffFile,
  reviewDiffHunk,
  StaleDiffSnapshotError,
} from './diff-review.js'
import { Store } from './store.js'

let repo: string
let store: Store

const lines = (replacements: Record<number, string> = {}) =>
  Array.from({ length: 20 }, (_, index) => replacements[index + 1] ?? `line ${index + 1}`).join(
    '\n',
  ) + '\n'

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'harness-diff-review-'))
  execFileSync('git', ['init', '-b', 'main', repo], { windowsHide: true })
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(path.join(repo, 'file.txt'), lines())
  writeFileSync(path.join(repo, 'staged.txt'), 'original\n')
  git('add', '.')
  git('commit', '-m', 'base')

  store = new Store(':memory:')
  store.addProject(repo)
  store.addThread({ id: 'thread-1', projectPath: repo, provider: 'codex', title: 'Review' })
})

afterEach(() => {
  store.close()
  rmSync(repo, { recursive: true, force: true })
})

describe('structured diff review', () => {
  it('parses separate hunks and remembers accepted work', async () => {
    writeFileSync(path.join(repo, 'file.txt'), lines({ 2: 'accepted change', 18: 'later change' }))

    const initial = await readSessionDiff(repo, 'thread-1', store)
    const file = initial.files.find((entry) => entry.path === 'file.txt')!
    expect(file.status).toBe('modified')
    expect(file.hunks).toHaveLength(2)
    expect(file.hunks[0]?.lines).toContainEqual({
      kind: 'addition',
      newLine: 2,
      text: 'accepted change',
    })

    const reviewed = await reviewDiffHunk(
      repo,
      'thread-1',
      initial.version,
      file.path,
      file.hunks[0]!.id,
      'accept',
      store,
    )

    expect(reviewed.version).toBe(initial.version)
    expect(reviewed.files[0]?.hunks[0]?.decision).toBe('accept')
    expect(readFileSync(path.join(repo, 'file.txt'), 'utf8')).toContain('accepted change')
  })

  it('rejects only one hunk without changing the index or unrelated work', async () => {
    writeFileSync(path.join(repo, 'file.txt'), lines({ 2: 'reject me', 18: 'keep me' }))
    writeFileSync(path.join(repo, 'staged.txt'), 'staged work\n')
    git('add', 'staged.txt')
    const indexBefore = git('diff', '--cached', '--binary')

    const initial = await readSessionDiff(repo, 'thread-1', store)
    const file = initial.files.find((entry) => entry.path === 'file.txt')!
    await reviewDiffHunk(
      repo,
      'thread-1',
      initial.version,
      file.path,
      file.hunks[0]!.id,
      'reject',
      store,
    )

    const content = readFileSync(path.join(repo, 'file.txt'), 'utf8')
    expect(content).toContain('line 2')
    expect(content).toContain('keep me')
    expect(readFileSync(path.join(repo, 'staged.txt'), 'utf8')).toBe('staged work\n')
    expect(git('diff', '--cached', '--binary')).toBe(indexBefore)
  })

  it('rejects a decision made against a stale worktree snapshot', async () => {
    writeFileSync(path.join(repo, 'file.txt'), lines({ 2: 'first change' }))
    const initial = await readSessionDiff(repo, 'thread-1', store)
    const file = initial.files[0]!
    writeFileSync(path.join(repo, 'file.txt'), lines({ 2: 'changed again' }))

    await expect(
      reviewDiffHunk(
        repo,
        'thread-1',
        initial.version,
        file.path,
        file.hunks[0]!.id,
        'reject',
        store,
      ),
    ).rejects.toBeInstanceOf(StaleDiffSnapshotError)
    expect(readFileSync(path.join(repo, 'file.txt'), 'utf8')).toContain('changed again')
  })

  it('preserves CRLF while rejecting a text hunk', async () => {
    writeFileSync(path.join(repo, '.gitattributes'), '*.crlf text eol=crlf\n')
    writeFileSync(path.join(repo, 'windows.crlf'), 'one\r\ntwo\r\nthree\r\n')
    git('add', '.')
    git('commit', '-m', 'add crlf')
    writeFileSync(path.join(repo, 'windows.crlf'), 'one\r\nchanged\r\nthree\r\n')

    const initial = await readSessionDiff(repo, 'thread-1', store)
    const file = initial.files.find((entry) => entry.path === 'windows.crlf')!
    await reviewDiffHunk(
      repo,
      'thread-1',
      initial.version,
      file.path,
      file.hunks[0]!.id,
      'reject',
      store,
    )

    expect(readFileSync(path.join(repo, 'windows.crlf'), 'utf8')).toBe('one\r\ntwo\r\nthree\r\n')
  })

  it('reviews binary changes and renames at file scope', async () => {
    writeFileSync(path.join(repo, 'asset.bin'), Buffer.from([0, 1, 2, 3]))
    writeFileSync(path.join(repo, 'old-name.txt'), lines())
    git('add', '.')
    git('commit', '-m', 'add files')
    writeFileSync(path.join(repo, 'asset.bin'), Buffer.from([0, 9, 2, 3]))
    renameSync(path.join(repo, 'old-name.txt'), path.join(repo, 'new-name.txt'))
    writeFileSync(path.join(repo, 'new-name.txt'), lines({ 10: 'renamed edit' }))

    let diff = await readSessionDiff(repo, 'thread-1', store)
    const binary = diff.files.find((entry) => entry.path === 'asset.bin')!
    expect(binary).toMatchObject({ binary: true, hunks: [] })
    diff = await reviewDiffFile(repo, 'thread-1', diff.version, binary.path, 'reject', store)
    expect(readFileSync(path.join(repo, 'asset.bin'))).toEqual(Buffer.from([0, 1, 2, 3]))

    const renamed = diff.files.find((entry) => entry.path === 'new-name.txt')!
    expect(renamed).toMatchObject({ status: 'renamed', previousPath: 'old-name.txt' })
    await reviewDiffFile(repo, 'thread-1', diff.version, renamed.path, 'reject', store)
    expect(existsSync(path.join(repo, 'old-name.txt'))).toBe(true)
    expect(existsSync(path.join(repo, 'new-name.txt'))).toBe(false)
  })
})
