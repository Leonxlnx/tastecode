import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createWorktree,
  hasUncommittedChanges,
  isRepository,
  NotARepository,
  removeWorktree,
  WorktreeDirty,
} from './worktree.js'

/**
 * Against a real repository in a temp directory.
 *
 * Mocking git here would test that we can spell its arguments, which is not
 * the part that goes wrong. What goes wrong is worktrees left behind by a
 * crash, and removals that quietly discard an agent's work.
 */

let repo: string
let root: string

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, windowsHide: true }).toString()

beforeEach(() => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'harness-wt-'))
  repo = path.join(base, 'repo')
  root = path.join(base, 'worktrees')

  execFileSync('git', ['init', '-b', 'main', repo], { windowsHide: true })
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(path.join(repo, 'file.txt'), 'original\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'first')
})

afterEach(() => {
  rmSync(path.dirname(repo), { recursive: true, force: true })
})

describe('createWorktree', () => {
  it('starts from a named branch without switching the shared checkout', async () => {
    git(repo, 'branch', 'chosen')
    writeFileSync(path.join(repo, 'file.txt'), 'main advanced\n')
    git(repo, 'commit', '-am', 'advance main')
    const before = git(repo, 'rev-parse', 'HEAD')
    const worktree = await createWorktree(repo, 'thread-from-chosen', root, 'chosen')
    expect(git(worktree.path, 'show', 'HEAD:file.txt')).toBe('original\n')
    expect(git(repo, 'branch', '--show-current').trim()).toBe('main')
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before)
    await expect(createWorktree(repo, 'thread-invalid-ref', root, '--orphan')).rejects.toThrow(
      /unknown local branch/,
    )
  })
  it('gives the session a checkout of its own on its own branch', async () => {
    const worktree = await createWorktree(repo, 'codex-aaaa-bbbb-cccc', root)

    expect(existsSync(path.join(worktree.path, 'file.txt'))).toBe(true)
    expect(worktree.branch).toMatch(/^harness\//)
    // Edits in the worktree must not appear in the main checkout — that is the
    // entire point of isolating a session.
    writeFileSync(path.join(worktree.path, 'file.txt'), 'changed by agent\n')
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })

  it('gives two sessions separate checkouts and separate branches', async () => {
    const a = await createWorktree(repo, 'thread-aaaaaaaaaaaa', root)
    const b = await createWorktree(repo, 'thread-bbbbbbbbbbbb', root)

    expect(a.path).not.toBe(b.path)
    expect(a.branch).not.toBe(b.branch)
  })

  it('refuses a folder that is not a repository, in words that say why', async () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), 'harness-plain-'))
    await expect(createWorktree(plain, 'thread-1', root)).rejects.toBeInstanceOf(NotARepository)
    rmSync(plain, { recursive: true, force: true })
  })

  it('recovers from a worktree that a crash left registered but gone', async () => {
    const worktree = await createWorktree(repo, 'thread-cccccccccccc', root)
    // Simulate the crash: directory deleted, git still believes in it.
    rmSync(worktree.path, { recursive: true, force: true })

    // Starting a session on that path again must work rather than failing with
    // an error about our own leftovers.
    const again = await createWorktree(repo, 'thread-dddddddddddd', root)
    expect(existsSync(again.path)).toBe(true)
  })
})

describe('removeWorktree', () => {
  it('refuses when the agent left uncommitted work', async () => {
    const worktree = await createWorktree(repo, 'thread-eeeeeeeeeeee', root)
    writeFileSync(path.join(worktree.path, 'file.txt'), 'work nobody has seen\n')

    await expect(removeWorktree(worktree)).rejects.toBeInstanceOf(WorktreeDirty)
    // Refusing has to actually leave it alone.
    expect(existsSync(worktree.path)).toBe(true)
  })

  it('discards it only when explicitly told to', async () => {
    const worktree = await createWorktree(repo, 'thread-ffffffffffff', root)
    writeFileSync(path.join(worktree.path, 'file.txt'), 'work nobody has seen\n')

    await removeWorktree(worktree, true)
    expect(existsSync(worktree.path)).toBe(false)
  })

  it('removes a clean worktree without being asked twice', async () => {
    const worktree = await createWorktree(repo, 'thread-111111111111', root)
    await removeWorktree(worktree)
    expect(existsSync(worktree.path)).toBe(false)
  })

  it('keeps the branch, because it holds what the agent committed', async () => {
    const worktree = await createWorktree(repo, 'thread-222222222222', root)
    writeFileSync(path.join(worktree.path, 'file.txt'), 'a real change\n')
    git(worktree.path, 'add', '.')
    git(worktree.path, 'commit', '-m', 'agent work')

    await removeWorktree(worktree)

    // Removing the scaffolding must not throw away the work.
    expect(git(repo, 'branch', '--list', worktree.branch).trim()).toContain(worktree.branch)
  })

  it('never deletes the checkout when git refuses for a reason other than absence', async () => {
    // git refuses `worktree remove` for two very different reasons: the
    // directory is gone (fine, the caller's goal already holds) and the
    // checkout still holds work (absolutely not fine). Treating every failure
    // as the first one meant a user who declined to discard lost the work
    // anyway. Simulated here by removing the repo's registration so the
    // command fails while the directory — and its contents — still exist.
    const worktree = await createWorktree(repo, 'thread-555555555555', root)
    const keepMe = path.join(worktree.path, 'unsaved.txt')
    writeFileSync(keepMe, 'work nobody has seen\n')
    rmSync(path.join(repo, '.git', 'worktrees'), { recursive: true, force: true })

    await expect(removeWorktree(worktree, true)).rejects.toThrow()
    expect(existsSync(keepMe)).toBe(true)
  })

  it('succeeds when the directory is already gone', async () => {
    const worktree = await createWorktree(repo, 'thread-333333333333', root)
    rmSync(worktree.path, { recursive: true, force: true })

    // The outcome the caller wanted is already true; erroring would be pedantry.
    await expect(removeWorktree(worktree, true)).resolves.toBeUndefined()
  })
})

describe('hasUncommittedChanges', () => {
  it('is false for a fresh checkout and true once something is written', async () => {
    const worktree = await createWorktree(repo, 'thread-444444444444', root)
    expect(await hasUncommittedChanges(worktree.path)).toBe(false)

    writeFileSync(path.join(worktree.path, 'new.txt'), 'hello\n')
    expect(await hasUncommittedChanges(worktree.path)).toBe(true)
  })

  it('reports nothing to lose for a checkout that is not there', async () => {
    // Not "unknown, so assume dirty": a directory that does not exist holds
    // no work, and warning about losing it would be a lie.
    const worktree = await createWorktree(repo, 'thread-666666666666', root)
    rmSync(worktree.path, { recursive: true, force: true })
    expect(await hasUncommittedChanges(worktree.path)).toBe(false)
  })

  it('assumes work is at risk when git cannot answer', async () => {
    // A plain directory is not a repository, so status fails. Anything that
    // gates a destructive step must not read a failure as "clean".
    const plain = mkdtempSync(path.join(os.tmpdir(), 'harness-notrepo-'))
    try {
      expect(await hasUncommittedChanges(plain)).toBe(true)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('isRepository', () => {
  it('tells a repository from an ordinary folder', async () => {
    expect(await isRepository(repo)).toBe(true)
    const plain = mkdtempSync(path.join(os.tmpdir(), 'harness-plain-'))
    expect(await isRepository(plain)).toBe(false)
    rmSync(plain, { recursive: true, force: true })
  })
})
