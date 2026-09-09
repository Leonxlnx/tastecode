import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  changedSince,
  clearSnapshotRefs,
  NotARepositoryForCheckpoint,
  retainCheckpoint,
  retainCheckpoints,
  restoreSnapshot,
  takeSnapshot,
} from './checkpoint.js'

/**
 * Against a real repository, because the thing that matters is whether the
 * user's files are actually where they were — not whether we can spell git's
 * arguments.
 */

let repo: string

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, windowsHide: true }).toString()

const read = (file: string) => readFileSync(path.join(repo, file), 'utf8')
const write = (file: string, text: string) => writeFileSync(path.join(repo, file), text)

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'harness-cp-'))
  execFileSync('git', ['init', '-b', 'main', repo], { windowsHide: true })
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  // Otherwise git rewrites line endings on checkout and these assertions
  // would pass on macOS and fail on Windows for a reason unrelated to them.
  git('config', 'core.autocrlf', 'false')
  write('tracked.txt', 'original\n')
  git('add', '.')
  git('commit', '-m', 'first')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('takeSnapshot', () => {
  it('reports a clean tree as having nothing to record', async () => {
    const snapshot = await takeSnapshot(repo)
    expect(snapshot.clean).toBe(true)
  })

  it('captures a modified file', async () => {
    write('tracked.txt', 'changed\n')
    const snapshot = await takeSnapshot(repo)
    expect(snapshot.clean).toBe(false)
  })

  it('captures files git is not tracking yet', async () => {
    write('brand-new.txt', 'written by the agent\n')
    const snapshot = await takeSnapshot(repo)

    // An agent's first act is often creating a file. A snapshot that skipped
    // untracked files would not be able to remove it on rollback.
    expect(snapshot.clean).toBe(false)
    const listed = execFileSync('git', ['ls-tree', '-r', '--name-only', snapshot.commit], {
      cwd: repo,
      windowsHide: true,
    }).toString()
    expect(listed).toContain('brand-new.txt')
  })

  it('leaves the user staging area exactly as it was', async () => {
    write('tracked.txt', 'changed\n')
    write('staged.txt', 'deliberately staged\n')
    git('add', 'staged.txt')
    const before = git('status', '--porcelain')

    await takeSnapshot(repo)

    // Staging the user's work as a side effect of taking a backup would leave
    // them with a rearranged index they did not touch.
    expect(git('status', '--porcelain')).toBe(before)
  })

  it('does not put the snapshot on a branch or in the log', async () => {
    write('tracked.txt', 'changed\n')
    await takeSnapshot(repo)

    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1)
    expect(git('status', '--porcelain')).toContain('tracked.txt')
  })

  it('refuses a folder that is not a repository', async () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), 'harness-plain-'))
    await expect(takeSnapshot(plain)).rejects.toBeInstanceOf(NotARepositoryForCheckpoint)
    rmSync(plain, { recursive: true, force: true })
  })

  it('keeps a snapshot reachable during Git garbage collection', async () => {
    write('tracked.txt', 'saved before cleanup\n')
    const snapshot = await takeSnapshot(repo)
    git('gc', '--prune=now')
    expect(git('show', `${snapshot.commit}:tracked.txt`)).toBe('saved before cleanup\n')
    expect((await takeSnapshot(repo)).commit).toBe(snapshot.commit)
  })
})

describe('restoreSnapshot', () => {
  it('restores nested project files and removes new Unicode names without changing its sibling', async () => {
    const nested = path.join(repo, 'project with spaces')
    mkdirSync(nested)
    writeFileSync(path.join(nested, 'app.txt'), 'before\n')
    git('add', '.')
    git('commit', '-m', 'nested project')
    writeFileSync(path.join(nested, 'app.txt'), 'saved edit\n')
    const snapshot = await takeSnapshot(nested)
    write('tracked.txt', 'sibling must stay\n')
    writeFileSync(path.join(nested, 'app.txt'), 'after\n')
    writeFileSync(path.join(nested, '新 file.txt'), 'remove me\n')
    const replaced = await restoreSnapshot(nested, snapshot.commit)
    expect(readFileSync(path.join(nested, 'app.txt'), 'utf8')).toBe('saved edit\n')
    expect(existsSync(path.join(nested, '新 file.txt'))).toBe(false)
    expect(read('tracked.txt')).toBe('sibling must stay\n')
    await restoreSnapshot(nested, replaced.commit)
    expect(readFileSync(path.join(nested, '新 file.txt'), 'utf8')).toBe('remove me\n')
  })
  it('puts a modified file back to what it held', async () => {
    const before = await takeSnapshot(repo)
    write('tracked.txt', 'the agent went the wrong way\n')

    await restoreSnapshot(repo, before.commit)

    expect(read('tracked.txt')).toBe('original\n')
  })

  it('removes a file the agent created after the checkpoint', async () => {
    const before = await takeSnapshot(repo)
    write('agent-made-this.txt', 'noise\n')

    await restoreSnapshot(repo, before.commit)

    expect(existsSync(path.join(repo, 'agent-made-this.txt'))).toBe(false)
  })

  it('brings back a file the agent deleted', async () => {
    write('will-be-deleted.txt', 'precious\n')
    git('add', '.')
    git('commit', '-m', 'second')
    const before = await takeSnapshot(repo)
    rmSync(path.join(repo, 'will-be-deleted.txt'))

    await restoreSnapshot(repo, before.commit)

    expect(read('will-be-deleted.txt')).toBe('precious\n')
  })

  it('hands back what it replaced, so the undo can itself be undone', async () => {
    const before = await takeSnapshot(repo)
    write('tracked.txt', 'work the user might actually want\n')

    const replaced = await restoreSnapshot(repo, before.commit)
    expect(read('tracked.txt')).toBe('original\n')

    // No sequence of restores can reach a state nobody can get back to.
    await restoreSnapshot(repo, replaced.commit)
    expect(read('tracked.txt')).toBe('work the user might actually want\n')
  })

  it('does not move the branch or invent a commit', async () => {
    const headBefore = git('rev-parse', 'HEAD').trim()
    const snapshot = await takeSnapshot(repo)
    write('tracked.txt', 'changed\n')

    await restoreSnapshot(repo, snapshot.commit)

    // A rollback restores files. It is not a commit, and it must not move the
    // user's branch under them.
    expect(git('rev-parse', 'HEAD').trim()).toBe(headBefore)
    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1)
  })

  it('leaves the staging area as the user arranged it', async () => {
    write('staged.txt', 'the user staged this\n')
    git('add', 'staged.txt')
    const before = git('status', '--porcelain')

    const snapshot = await takeSnapshot(repo)
    write('tracked.txt', 'the agent went the wrong way\n')
    await restoreSnapshot(repo, snapshot.commit)

    // `git checkout <commit> -- .` would stage everything it touched and hand
    // back a staging area the user did not arrange.
    expect(git('status', '--porcelain')).toBe(before)
  })

  it('restores a file inside a directory the agent created', async () => {
    write('tracked.txt', 'original\n')
    const before = await takeSnapshot(repo)
    mkdirSync(path.join(repo, 'nested'))
    write(path.join('nested', 'thing.txt'), 'new\n')

    await restoreSnapshot(repo, before.commit)

    expect(existsSync(path.join(repo, 'nested', 'thing.txt'))).toBe(false)
  })
})

describe('changedSince', () => {
  it('lists nothing when the agent has not written', async () => {
    const snapshot = await takeSnapshot(repo)
    expect(await changedSince(repo, snapshot.commit)).toEqual([])
  })

  it('names what changed since the checkpoint', async () => {
    const snapshot = await takeSnapshot(repo)
    write('tracked.txt', 'changed\n')
    write('added.txt', 'new\n')

    const changed = await changedSince(repo, snapshot.commit)
    expect(changed.sort()).toEqual(['added.txt', 'tracked.txt'])
  })
})

it('keeps legacy checkpoint batches after cache removal and Git garbage collection', async () => {
  const tree = git('rev-parse', 'HEAD^{tree}').trim()
  const commits = new Set(
    Array.from({ length: 257 }, (_, index) =>
      git('commit-tree', tree, '-m', `Legacy checkpoint ${index}`).trim(),
    ),
  )
  const [first, second] = [...commits]
  await retainCheckpoint(repo, 'legacy-data', first!)
  // Repair a stale ref as well as creating the missing refs in multiple batches.
  git('update-ref', `refs/harness/checkpoints/legacy-data/${second}`, first!)
  await retainCheckpoints(repo, 'legacy-data', commits)
  await clearSnapshotRefs(repo)
  git('gc', '--prune=now')
  const references = git(
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/harness/checkpoints/legacy-data/',
  )
    .trim()
    .split('\n')
  expect(new Set(references)).toEqual(
    new Set(
      [...commits].map((commit) => `refs/harness/checkpoints/legacy-data/${commit} ${commit}`),
    ),
  )
  const objects = execFileSync('git', ['cat-file', '--batch-check=%(objecttype)'], {
    cwd: repo,
    input: [...commits].join('\n') + '\n',
    windowsHide: true,
  }).toString()
  expect(objects.trim().split('\n')).toEqual(Array.from(commits, () => 'commit'))
}, 20_000)
