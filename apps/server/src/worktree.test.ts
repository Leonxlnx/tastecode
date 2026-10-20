import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  carryUncommittedChanges,
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
  it('starts from a branch that shares its name with a tag', async () => {
    git(repo, 'branch', 'release')
    git(repo, 'tag', 'release')
    const worktree = await createWorktree(repo, 'thread-from-release', root, 'release')
    expect(git(worktree.path, 'show', 'HEAD:file.txt')).toBe('original\n')
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

  it('keeps a nested project folder as the work path inside the checkout', async () => {
    const nested = path.join(repo, 'apps', 'web')
    mkdirSync(nested, { recursive: true })
    writeFileSync(path.join(nested, 'index.ts'), 'export {}\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'nested')
    mkdirSync(path.join(repo, 'untracked'))

    const worktree = await createWorktree(nested, 'thread-nested-1111', root)
    const missing = await createWorktree(path.join(repo, 'untracked'), 'thread-nested-2222', root)

    expect(worktree.workPath).toBe(path.join(worktree.path, 'apps', 'web'))
    expect(existsSync(path.join(worktree.workPath!, 'index.ts'))).toBe(true)
    expect(missing.workPath).toBe(missing.path)
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

describe('carryUncommittedChanges', () => {
  // Bytes no line-ending conversion may touch: a NUL, a lone CR, CRLF, high bytes.
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00])
  const logo = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff, 0x0d, 0x00, 0x0a, 0x80])
  /** Text as git checks it out here; autocrlf may have added CRs. */
  const text = (file: string) => readFileSync(file, 'utf8').replaceAll('\r\n', '\n')

  beforeEach(() => {
    writeFileSync(path.join(repo, 'gone.txt'), 'delete me\n')
    writeFileSync(path.join(repo, 'image.bin'), image)
    writeFileSync(path.join(repo, '.gitignore'), '*.log\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'second')
  })

  it('copies modified, added, deleted, untracked and binary files into the new checkout', async () => {
    const earlier = await createWorktree(repo, 'thread-earlier-0001', root)
    writeFileSync(path.join(earlier.path, 'file.txt'), 'edited\n')
    writeFileSync(path.join(earlier.path, 'staged.txt'), 'staged before the limit\n')
    git(earlier.path, 'add', 'staged.txt')
    rmSync(path.join(earlier.path, 'gone.txt'))
    mkdirSync(path.join(earlier.path, 'notes'))
    writeFileSync(path.join(earlier.path, 'notes', 'todo.md'), 'not tracked yet\n')
    writeFileSync(path.join(earlier.path, 'Größe.txt'), 'non-ASCII name\n')
    writeFileSync(path.join(earlier.path, 'image.bin'), Buffer.concat([image, logo]))
    writeFileSync(path.join(earlier.path, 'logo.bin'), logo)
    writeFileSync(path.join(earlier.path, 'debug.log'), 'ignored\n')
    const earlierStatus = git(earlier.path, 'status', '--porcelain')

    const next = await createWorktree(repo, 'thread-next-0001', root, earlier.branch)
    expect(await carryUncommittedChanges(earlier.path, next)).toEqual({ carried: true })

    expect(text(path.join(next.path, 'file.txt'))).toBe('edited\n')
    expect(text(path.join(next.path, 'staged.txt'))).toBe('staged before the limit\n')
    expect(existsSync(path.join(next.path, 'gone.txt'))).toBe(false)
    expect(text(path.join(next.path, 'notes', 'todo.md'))).toBe('not tracked yet\n')
    expect(text(path.join(next.path, 'Größe.txt'))).toBe('non-ASCII name\n')
    expect(readFileSync(path.join(next.path, 'image.bin'))).toEqual(Buffer.concat([image, logo]))
    expect(readFileSync(path.join(next.path, 'logo.bin'))).toEqual(logo)
    // Ignored files are not the chat's work.
    expect(existsSync(path.join(next.path, 'debug.log'))).toBe(false)
    // Nothing committed or staged in the new checkout; the branch is where it was.
    expect(git(next.path, 'rev-parse', 'HEAD')).toBe(git(earlier.path, 'rev-parse', 'HEAD'))
    expect(git(next.path, 'diff', '--cached', '--name-only')).toBe('')
    // The earlier checkout is only read.
    expect(git(earlier.path, 'status', '--porcelain')).toBe(earlierStatus)
    expect(text(path.join(earlier.path, 'file.txt'))).toBe('edited\n')
  })

  it('leaves both checkouts as they were when the changes do not apply', async () => {
    const earlier = await createWorktree(repo, 'thread-earlier-0002', root)
    // The earlier chat committed on another branch, so its edits sit on a base
    // the new checkout does not have.
    git(earlier.path, 'switch', '-c', 'elsewhere')
    writeFileSync(path.join(earlier.path, 'file.txt'), 'committed elsewhere\n')
    git(earlier.path, 'commit', '-am', 'elsewhere')
    writeFileSync(path.join(earlier.path, 'file.txt'), 'edited elsewhere\n')
    writeFileSync(path.join(earlier.path, 'new.txt'), 'would apply on its own\n')
    const earlierStatus = git(earlier.path, 'status', '--porcelain')

    const next = await createWorktree(repo, 'thread-next-0002', root, earlier.branch)
    expect(await carryUncommittedChanges(earlier.path, next)).toMatchObject({ carried: false })

    expect(git(next.path, 'status', '--porcelain')).toBe('')
    expect(text(path.join(next.path, 'file.txt'))).toBe('original\n')
    expect(git(earlier.path, 'status', '--porcelain')).toBe(earlierStatus)
    expect(text(path.join(earlier.path, 'file.txt'))).toBe('edited elsewhere\n')
  })

  it('leaves changes larger than the limit where they are', async () => {
    const earlier = await createWorktree(repo, 'thread-earlier-0003', root)
    writeFileSync(path.join(earlier.path, 'large.txt'), 'x'.repeat(8_192))
    const next = await createWorktree(repo, 'thread-next-0003', root, earlier.branch)

    expect(await carryUncommittedChanges(earlier.path, next, 1_024)).toEqual({
      carried: false,
      reason: 'the changes are larger than 1024 bytes',
    })
    expect(git(next.path, 'status', '--porcelain')).toBe('')
    expect(existsSync(path.join(earlier.path, 'large.txt'))).toBe(true)
  })

  it('has nothing to carry from a clean checkout or one that is gone', async () => {
    const clean = await createWorktree(repo, 'thread-earlier-0004', root)
    const gone = await createWorktree(repo, 'thread-earlier-0005', root)
    writeFileSync(path.join(gone.path, 'file.txt'), 'lost with its folder\n')
    rmSync(gone.path, { recursive: true, force: true })
    const next = await createWorktree(repo, 'thread-next-0004', root)

    expect(await carryUncommittedChanges(clean.path, next)).toBeUndefined()
    expect(await carryUncommittedChanges(gone.path, next)).toBeUndefined()
    expect(git(next.path, 'status', '--porcelain')).toBe('')
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
