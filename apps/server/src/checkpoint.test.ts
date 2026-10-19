import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as fsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  changedSince,
  checkpointRepository,
  clearSnapshotRefs,
  NotARepositoryForCheckpoint,
  retainCheckpoint,
  retainCheckpoints,
  restoreSnapshot,
  RestoreSnapshotError,
  takeSnapshot,
} from './checkpoint.js'
import { runHistoryCli } from './history-cli.js'
import { DatabaseSync } from './sqlite.js'
import { Store } from './store.js'

vi.mock('node:fs/promises', { spy: true })

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

  it('snapshots and restores a repository before its first commit', async () => {
    const fresh = mkdtempSync(path.join(os.tmpdir(), 'harness-cp-unborn-'))
    try {
      execFileSync('git', ['init', '-b', 'main', fresh], { windowsHide: true })
      execFileSync('git', ['-C', fresh, 'config', 'core.autocrlf', 'false'], { windowsHide: true })
      expect((await takeSnapshot(fresh)).clean).toBe(true)
      writeFileSync(path.join(fresh, 'first.txt'), 'before the agent\n')
      const snapshot = await takeSnapshot(fresh)
      expect(snapshot.clean).toBe(false)
      writeFileSync(path.join(fresh, 'first.txt'), 'agent edit\n')
      writeFileSync(path.join(fresh, 'agent.txt'), 'new\n')

      await restoreSnapshot(fresh, snapshot.commit)

      expect(readFileSync(path.join(fresh, 'first.txt'), 'utf8')).toBe('before the agent\n')
      expect(existsSync(path.join(fresh, 'agent.txt'))).toBe(false)
      expect(() =>
        execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: fresh, stdio: 'ignore' }),
      ).toThrow()
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })

  it('records a snapshot without a configured Git identity', async () => {
    git('config', 'user.useConfigOnly', 'true')
    git('config', '--unset', 'user.email')
    git('config', '--unset', 'user.name')
    write('tracked.txt', 'changed\n')
    const snapshot = await takeSnapshot(repo)
    expect(git('log', '-1', '--format=%an <%ae>', snapshot.commit).trim()).toBe(
      'TasteCode checkpoint <checkpoint@tastecode.invalid>',
    )
  })
})

describe('takeSnapshot from the checkout index', () => {
  /** Older than any index written here, so no entry is racily clean by accident. */
  const settled = new Date('2020-01-01T00:00:00Z')
  const show = (commit: string, file: string) => git('show', `${commit}:${file}`)

  it
    .skipIf(process.platform === 'win32' || process.getuid?.() === 0)
    .each(['checkout', 'linked worktree'])(
    'does not read a tracked file whose recorded stat is unchanged in a %s',
    async (kind) => {
      const linked = kind === 'linked worktree'
      const checkout = linked ? mkdtempSync(path.join(os.tmpdir(), 'harness-cp-linked-')) : repo
      if (linked) git('worktree', 'add', '--detach', checkout, 'HEAD')
      const inCheckout = (...args: string[]) =>
        execFileSync('git', args, { cwd: checkout, windowsHide: true }).toString()
      const tracked = path.join(checkout, 'tracked.txt')
      // Revoking read access changes ctime, which git would otherwise compare.
      git('config', 'core.trustctime', 'false')
      utimesSync(tracked, settled, settled)
      inCheckout('update-index', '--refresh')
      chmodSync(tracked, 0o000)
      writeFileSync(path.join(checkout, 'agent.txt'), 'agent edit\n')
      try {
        // Hashing every tracked file would have to open this one and fail.
        const snapshot = await takeSnapshot(checkout)
        expect(show(snapshot.commit, 'tracked.txt')).toBe('original\n')
        expect(show(snapshot.commit, 'agent.txt')).toBe('agent edit\n')
      } finally {
        chmodSync(tracked, 0o644)
        if (linked) {
          git('worktree', 'remove', '--force', checkout)
          rmSync(checkout, { recursive: true, force: true })
        }
      }
    },
  )

  it('re-reads a same-size edit written in the tick its index was', async () => {
    // Only the racy-entry check can see this edit: size, mtime and inode all match.
    git('config', 'core.trustctime', 'false')
    const tracked = path.join(repo, 'tracked.txt')
    utimesSync(tracked, settled, settled)
    git('update-index', '--refresh')
    utimesSync(path.join(repo, '.git', 'index'), settled, settled)
    write('tracked.txt', 'changed!\n')
    utimesSync(tracked, settled, settled)

    const snapshot = await takeSnapshot(repo)

    expect(show(snapshot.commit, 'tracked.txt')).toBe('changed!\n')
  })

  it.each(['--assume-unchanged', '--skip-worktree'])(
    'records working edits to a file marked %s and keeps the mark',
    async (mark) => {
      git('update-index', mark, 'tracked.txt')
      const marks = git('ls-files', '-v')
      write('tracked.txt', 'kept out of git status\n')

      const snapshot = await takeSnapshot(repo)

      // Trusting the mark would record HEAD here, and a restore would overwrite the edit.
      expect(show(snapshot.commit, 'tracked.txt')).toBe('kept out of git status\n')
      expect(git('ls-files', '-v')).toBe(marks)
    },
  )

  it('records the working copy of a file staged and then edited again', async () => {
    write('tracked.txt', 'staged\n')
    git('add', 'tracked.txt')
    write('tracked.txt', 'edited after staging\n')

    const snapshot = await takeSnapshot(repo)

    expect(show(snapshot.commit, 'tracked.txt')).toBe('edited after staging\n')
    expect(git('diff', '--cached', '--name-only')).toBe('tracked.txt\n')
  })

  it('records conflict markers while the merge is still unresolved', async () => {
    git('checkout', '-q', '-b', 'side')
    write('tracked.txt', 'side\n')
    git('commit', '-q', '-am', 'side')
    git('checkout', '-q', 'main')
    write('tracked.txt', 'main\n')
    git('commit', '-q', '-am', 'main')
    expect(() =>
      execFileSync('git', ['merge', 'side'], { cwd: repo, stdio: 'ignore', windowsHide: true }),
    ).toThrow()
    const conflicted = read('tracked.txt')

    const snapshot = await takeSnapshot(repo)

    expect(show(snapshot.commit, 'tracked.txt')).toBe(conflicted)
    expect(git('ls-files', '--unmerged')).not.toBe('')
  })
})

describe('takeSnapshot of a checkout that matches HEAD', () => {
  /** The git commands an action runs, from git's own trace; every run inherits this environment. */
  async function gitCommands<T>(
    action: () => Promise<T>,
  ): Promise<{ result: T; commands: string[] }> {
    const traceDir = mkdtempSync(path.join(os.tmpdir(), 'harness-cp-trace-'))
    const trace = path.join(traceDir, 'trace.json')
    vi.stubEnv('GIT_TRACE2_EVENT', trace)
    try {
      const result = await action()
      const commands = existsSync(trace)
        ? readFileSync(trace, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { event: string; sid: string; name?: string })
            // Top-level runs only; a git that starts another git nests its session id.
            .filter((event) => event.event === 'cmd_name' && !event.sid.includes('/'))
            .map((event) => event.name ?? '')
        : []
      return { result, commands }
    } finally {
      vi.unstubAllEnvs()
      rmSync(traceDir, { recursive: true, force: true })
    }
  }
  /**
   * The tree a full snapshot records, built here independently: HEAD in a
   * private index, every working change, and the ignored files the user's own
   * index tracks.
   */
  function fullSnapshotTree(): string {
    const indexDir = mkdtempSync(path.join(os.tmpdir(), 'harness-cp-index-'))
    try {
      const env = { ...process.env, GIT_INDEX_FILE: path.join(indexDir, 'index') }
      const run = (...args: string[]) =>
        execFileSync('git', args, { cwd: repo, env, windowsHide: true }).toString().trim()
      const trackedIgnored = git('ls-files', '--cached', '--ignored', '--exclude-standard', '-z')
        .split('\0')
        .filter(Boolean)
      run('read-tree', 'HEAD')
      run('add', '-A')
      if (trackedIgnored.length) run('add', '-f', '--', ...trackedIgnored)
      return run('write-tree')
    } finally {
      rmSync(indexDir, { recursive: true, force: true })
    }
  }
  const treeOf = (commit: string) => git('rev-parse', `${commit}^{tree}`).trim()
  const FULL_PATH = ['add', 'write-tree']

  it('records HEAD with a status instead of rebuilding the tree', async () => {
    const { result: snapshot, commands } = await gitCommands(() => takeSnapshot(repo))

    expect(snapshot).toEqual({ commit: git('rev-parse', 'HEAD').trim(), clean: true })
    expect(treeOf(snapshot.commit)).toBe(fullSnapshotTree())
    expect(commands).toContain('status')
    expect(commands).not.toEqual(expect.arrayContaining(FULL_PATH))
    // Two HEAD reads, the status, the index mark check and the protecting ref.
    expect(commands).toHaveLength(5)
  })

  it('records HEAD beside ignored files, which no snapshot holds', async () => {
    write('.gitignore', 'build/\n*.log\n')
    git('add', '.gitignore')
    git('commit', '-m', 'ignore build output')
    mkdirSync(path.join(repo, 'build'))
    write(path.join('build', 'out.js'), 'generated\n')
    write('debug.log', 'noise\n')

    const { result: snapshot, commands } = await gitCommands(() => takeSnapshot(repo))

    expect(snapshot.commit).toBe(git('rev-parse', 'HEAD').trim())
    expect(treeOf(snapshot.commit)).toBe(fullSnapshotTree())
    expect(commands).not.toEqual(expect.arrayContaining(FULL_PATH))
  })

  it.each([
    ['a modified file', () => write('tracked.txt', 'changed\n')],
    ['an untracked file', () => write('new.txt', 'new\n')],
    ['a deleted file', () => rmSync(path.join(repo, 'tracked.txt'))],
    [
      'a staged change undone in the working copy',
      () => {
        write('tracked.txt', 'staged\n')
        git('add', 'tracked.txt')
        write('tracked.txt', 'original\n')
      },
    ],
    [
      'a force-added ignored file',
      () => {
        write('.gitignore', 'local.txt\n')
        git('add', '.gitignore')
        git('commit', '-m', 'ignore local file')
        write('local.txt', 'kept on purpose\n')
        git('add', '-f', 'local.txt')
      },
    ],
    [
      'modified, untracked, ignored and deleted files together',
      () => {
        write('gone.txt', 'committed\n')
        write('.gitignore', '*.log\n')
        git('add', '.')
        git('commit', '-m', 'second')
        write('tracked.txt', 'changed\n')
        write('new.txt', 'new\n')
        write('debug.log', 'ignored\n')
        rmSync(path.join(repo, 'gone.txt'))
      },
    ],
  ])('takes the full snapshot of a checkout with %s', async (_, change) => {
    change()

    const { result: snapshot, commands } = await gitCommands(() => takeSnapshot(repo))

    expect(commands).toEqual(expect.arrayContaining(FULL_PATH))
    expect(treeOf(snapshot.commit)).toBe(fullSnapshotTree())
    expect(git('ls-tree', '-r', '--name-only', snapshot.commit)).not.toContain('debug.log')
  })

  it('takes the full snapshot when the index hides an edit from status', async () => {
    git('update-index', '--assume-unchanged', 'tracked.txt')
    write('tracked.txt', 'kept out of git status\n')
    expect(git('status', '--porcelain')).toBe('')

    const { result: snapshot, commands } = await gitCommands(() => takeSnapshot(repo))

    expect(commands).toEqual(expect.arrayContaining(FULL_PATH))
    expect(git('show', `${snapshot.commit}:tracked.txt`)).toBe('kept out of git status\n')
  })

  it.each([
    ['a clean checkout', () => undefined, 5],
    ['a changed checkout', () => write('tracked.txt', 'changed\n'), undefined],
  ])(
    'keeps the checkpoint of %s with the run that protects its snapshot',
    async (_, change, runs) => {
      change()

      const { result: snapshot, commands } = await gitCommands(() =>
        takeSnapshot(repo, { retainIn: 'turns' }),
      )

      expect(commands.filter((command) => command === 'update-ref')).toHaveLength(1)
      if (runs !== undefined) expect(commands).toHaveLength(runs)
      expect(git('for-each-ref', '--format=%(refname)', 'refs/harness/').split('\n')).toEqual(
        expect.arrayContaining([
          `refs/harness/checkpoints/turns/${snapshot.commit}`,
          `refs/harness/snapshots/${snapshot.commit}`,
        ]),
      )
    },
  )

  it('refuses a checkpoint namespace that is not a plain name', async () => {
    await expect(takeSnapshot(repo, { retainIn: '../heads/main' })).rejects.toThrow(
      'invalid checkpoint namespace',
    )
    expect(git('for-each-ref', 'refs/harness/')).toBe('')
  })

  it('restores from a checkpoint taken on a clean checkout', async () => {
    write('gone.txt', 'committed\n')
    git('add', '.')
    git('commit', '-m', 'second')
    const { result: before, commands } = await gitCommands(() => takeSnapshot(repo))
    expect(commands).not.toEqual(expect.arrayContaining(FULL_PATH))
    write('tracked.txt', 'agent edit\n')
    write('agent.txt', 'agent file\n')
    rmSync(path.join(repo, 'gone.txt'))

    await restoreSnapshot(repo, before.commit)

    expect(read('tracked.txt')).toBe('original\n')
    expect(read('gone.txt')).toBe('committed\n')
    expect(existsSync(path.join(repo, 'agent.txt'))).toBe(false)
    expect(git('status', '--porcelain')).toBe('')
  })
})

describe('restoreSnapshot', () => {
  it('preserves leading whitespace in Git paths and leaves ignored lookalikes alone', async () => {
    write('.gitignore', 'victim.txt\n')
    git('add', '.gitignore')
    git('commit', '-m', 'ignore private file')
    const before = await takeSnapshot(repo)
    write(' victim.txt', 'agent file\n')
    write('victim.txt', 'private ignored file\n')
    expect(await changedSince(repo, before.commit)).toEqual([' victim.txt'])
    const replaced = await restoreSnapshot(repo, before.commit)
    expect(existsSync(path.join(repo, ' victim.txt'))).toBe(false)
    expect(read('victim.txt')).toBe('private ignored file\n')
    await restoreSnapshot(repo, replaced.commit)
    expect(read(' victim.txt')).toBe('agent file\n')
  })

  it('backs up working edits to force-staged ignored files without changing their index', async () => {
    write('.gitignore', 'local.txt\n')
    git('add', '.gitignore')
    git('commit', '-m', 'ignore local file')
    const before = await takeSnapshot(repo)
    write('local.txt', 'staged\n')
    git('add', '-f', 'local.txt')
    write('local.txt', 'unstaged latest work\n')
    const index = git('diff', '--cached', '--binary')
    const replaced = await restoreSnapshot(repo, before.commit)
    expect(existsSync(path.join(repo, 'local.txt'))).toBe(false)
    expect(git('show', `${replaced.commit}:local.txt`)).toBe('unstaged latest work\n')
    await restoreSnapshot(repo, replaced.commit)
    expect(read('local.txt')).toBe('unstaged latest work\n')
    expect(git('diff', '--cached', '--binary')).toBe(index)
  })

  it('rolls back earlier deletions when a later restore operation fails', async () => {
    const before = await takeSnapshot(repo)
    write('added-a.txt', 'first\n')
    write('added-b.txt', 'second\n')
    const { rm: originalRm } = await vi.importActual<typeof fsPromises>('node:fs/promises')
    const removal = vi.spyOn(fsPromises, 'rm').mockImplementation(async (target, options) => {
      if (path.basename(String(target)) === 'added-b.txt') throw new Error('file is locked')
      return originalRm(target, options)
    })
    try {
      await expect(restoreSnapshot(repo, before.commit)).rejects.toThrow('file is locked')
      expect(read('added-a.txt')).toBe('first\n')
      expect(read('added-b.txt')).toBe('second\n')
      expect(read('tracked.txt')).toBe('original\n')
    } finally {
      removal.mockRestore()
    }
  })

  it('exposes the protected backup when both restore and rollback fail', async () => {
    write('target-only.txt', 'checkpoint\n')
    const before = await takeSnapshot(repo)
    rmSync(path.join(repo, 'target-only.txt'))
    write('added-a.txt', 'recover this\n')
    write('added-b.txt', 'locked\n')
    const { rm: originalRm } = await vi.importActual<typeof fsPromises>('node:fs/promises')
    const removal = vi.spyOn(fsPromises, 'rm').mockImplementation(async (target, options) => {
      if (['added-b.txt', 'target-only.txt'].includes(path.basename(String(target)))) {
        throw new Error('file is locked')
      }
      return originalRm(target, options)
    })
    try {
      const failure = await restoreSnapshot(repo, before.commit, 'recovery').catch(
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(RestoreSnapshotError)
      if (!(failure instanceof RestoreSnapshotError))
        throw new Error('expected recovery checkpoint')
      expect(failure.errors).toHaveLength(2)
      await clearSnapshotRefs(repo)
      git('gc', '--prune=now')
      expect(git('show', `${failure.snapshot.commit}:added-a.txt`)).toBe('recover this\n')
    } finally {
      removal.mockRestore()
    }
  })

  it.each(['true', 'copies'])(
    'removes renamed files within the project scope with diff.renames=%s',
    async (renameMode) => {
      git('config', 'diff.renames', renameMode)
      git('config', 'core.quotePath', 'true')
      const project = path.join(repo, 'project [draft]')
      mkdirSync(project)
      const original = path.join(project, 'original 文档.ts')
      const renamed = path.join(project, 'renamed 文档.ts')
      writeFileSync(original, 'export const value = 1\n')
      git('add', '.')
      git('commit', '-m', 'nested project')
      const before = await takeSnapshot(project)

      renameSync(original, renamed)
      write('tracked.txt', 'sibling must stay\n')
      const after = await takeSnapshot(project)
      expect(git('diff', '--name-status', before.commit, after.commit)).toMatch(/^R100\t/)

      const replaced = await restoreSnapshot(project, before.commit)

      expect(readFileSync(original, 'utf8')).toBe('export const value = 1\n')
      expect(existsSync(renamed)).toBe(false)
      expect(read('tracked.txt')).toBe('sibling must stay\n')
      expect(await changedSince(project, before.commit)).toEqual([])

      await restoreSnapshot(project, replaced.commit)
      expect(existsSync(original)).toBe(false)
      expect(readFileSync(renamed, 'utf8')).toBe('export const value = 1\n')
      expect(read('tracked.txt')).toBe('sibling must stay\n')
    },
  )

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

  it('lists and removes more generated files than fit in a mebibyte of names', async () => {
    const before = await takeSnapshot(repo)
    mkdirSync(path.join(repo, 'generated'))
    // About 1.2 MiB of NUL-separated paths: past Node's default output buffer
    // for a child process, which an agent scaffolding a project reaches easily.
    const files = Array.from({ length: 7_200 }, (_, index) =>
      path.join('generated', `${String(index).padStart(5, '0')}-${'x'.repeat(144)}.txt`),
    )
    for (const file of files) write(file, '')

    expect(await changedSince(repo, before.commit)).toHaveLength(files.length)
    await restoreSnapshot(repo, before.commit)

    expect(existsSync(path.join(repo, files[0]!))).toBe(false)
    expect(existsSync(path.join(repo, files.at(-1)!))).toBe(false)
  }, 60_000)

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

describe('nested repositories', () => {
  // Agents scaffold apps and run `git init` or `git clone` in subfolders. The
  // outer repository only sees such a folder as a gitlink, so it can neither
  // snapshot its files nor bring them back, and must not break because of it.
  const nestedGit = (...args: string[]) =>
    execFileSync('git', args, { cwd: path.join(repo, 'app'), windowsHide: true }).toString()

  const initNested = (commit: boolean) => {
    mkdirSync(path.join(repo, 'app'))
    nestedGit('init', '-q', '-b', 'main')
    nestedGit('config', 'user.email', 'test@example.com')
    nestedGit('config', 'user.name', 'Test')
    write(path.join('app', 'index.js'), 'x\n')
    if (commit) {
      nestedGit('add', '.')
      nestedGit('commit', '-q', '-m', 'scaffold')
    }
  }

  it('snapshots the rest of the tree when a nested repository has no commit yet', async () => {
    initNested(false)
    write('tracked.txt', 'agent edit\n')
    write('new.txt', 'new\n')

    const snapshot = await takeSnapshot(repo)

    expect(git('show', `${snapshot.commit}:tracked.txt`)).toBe('agent edit\n')
    expect(git('show', `${snapshot.commit}:new.txt`)).toBe('new\n')
    expect(git('ls-tree', '--name-only', snapshot.commit)).not.toContain('app')
  })

  it('restores around a committed nested repository the agent created and leaves it intact', async () => {
    const checkpoint = await takeSnapshot(repo)
    initNested(true)
    write('tracked.txt', 'agent edit\n')

    await restoreSnapshot(repo, checkpoint.commit)

    expect(read('tracked.txt')).toBe('original\n')
    expect(read(path.join('app', 'index.js'))).toBe('x\n')
    expect(nestedGit('log', '--format=%s')).toBe('scaffold\n')
  })

  it('restores past a nested repository committed as a gitlink without deleting it', async () => {
    const checkpoint = await takeSnapshot(repo)
    initNested(true)
    git('add', 'app')
    git('commit', '-q', '-m', 'add app')
    write('tracked.txt', 'agent edit\n')

    await restoreSnapshot(repo, checkpoint.commit)

    expect(read('tracked.txt')).toBe('original\n')
    expect(read(path.join('app', 'index.js'))).toBe('x\n')
    expect(nestedGit('log', '--format=%s')).toBe('scaffold\n')
  })

  it('lists changes beside an uncommitted nested repository', async () => {
    const checkpoint = await takeSnapshot(repo)
    initNested(false)
    write('tracked.txt', 'agent edit\n')

    expect(await changedSince(repo, checkpoint.commit)).toEqual(['tracked.txt'])
  })
})

it('resolves checkpoint storage from checkout, nested directory, and saved Git directory', async () => {
  const nested = path.join(repo, 'nested')
  mkdirSync(nested)
  const common = await checkpointRepository(repo)
  expect(await checkpointRepository(nested)).toBe(common)
  expect(await checkpointRepository(common)).toBe(common)
})

it.runIf(process.platform === 'win32')(
  'shares checkpoint storage across Windows long paths, short aliases, and linked worktrees',
  async (context) => {
    const alias = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); (New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:TASTECODE_CHECKPOINT_ALIAS).ShortPath',
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, TASTECODE_CHECKPOINT_ALIAS: repo },
      },
    ).trim()
    if (alias.toLowerCase() === repo.toLowerCase()) {
      context.skip('The temporary volume does not provide Windows short-path aliases')
    }
    expect(statSync(alias).ino).toBe(statSync(repo).ino)
    const nested = path.join(alias, 'nested')
    mkdirSync(nested)
    const worktree = path.join(repo, 'linked-worktree')
    git('worktree', 'add', '--detach', worktree, 'HEAD')

    const common = await checkpointRepository(repo)
    expect(await checkpointRepository(alias)).toBe(common)
    expect(await checkpointRepository(nested)).toBe(common)
    expect(await checkpointRepository(worktree)).toBe(common)
    expect(await checkpointRepository(path.join(alias, '.git'))).toBe(common)

    const independent = path.join(repo, 'independent')
    git('init', independent)
    expect(await checkpointRepository(independent)).not.toBe(common)
  },
)

it.each(['checkout', 'git-directory'])(
  'prunes history with a saved %s without dropping unsupported-provider checkpoints',
  async (savedPath) => {
    const data = mkdtempSync(path.join(os.tmpdir(), 'harness-prune-checkpoints-'))
    const location = path.join(data, 'tastecode.db')
    let store: Store | undefined
    try {
      store = new Store(location)
      store.addProject(repo)
      for (const id of ['old', 'retained']) {
        store.addThread({ id, projectPath: repo, provider: 'codex', title: id })
        write('tracked.txt', `${id}\n`)
        const snapshot = await takeSnapshot(repo)
        store.addCheckpoint({ threadId: id, seq: 0, commit: snapshot.commit, label: id })
        await retainCheckpoint(repo, store.checkpointNamespace, snapshot.commit)
      }
      store.closeThread('old')
      const retained = store.checkpoints('retained')[0]!.commit
      const removed = store.checkpoints('old')[0]!.commit
      const namespace = store.checkpointNamespace
      store.recordCheckpointRepository(
        savedPath === 'checkout' ? repo : await checkpointRepository(repo),
      )
      store.close()
      store = undefined
      const raw = new DatabaseSync(location)
      try {
        raw.prepare('UPDATE threads SET provider = ? WHERE id = ?').run('nightly-only', 'retained')
      } finally {
        raw.close()
      }
      await runHistoryCli(
        [
          'prune',
          '--before',
          '2099-01-01',
          '--archive',
          path.join(data, 'archive.ndjson'),
          '--apply',
        ],
        { HARNESS_DATA_DIR: data },
        () => undefined,
      )
      expect(
        git('for-each-ref', '--format=%(refname)', `refs/harness/checkpoints/${namespace}`),
      ).toBe(`refs/harness/checkpoints/${namespace}/${retained}\n`)
      expect(
        git(
          'for-each-ref',
          '--format=%(refname)',
          `refs/harness/checkpoints/${namespace}/${removed}`,
        ),
      ).toBe('')
      git('gc', '--prune=now')
      expect(git('show', `${retained}:tracked.txt`)).toBe('retained\n')
    } finally {
      store?.close()
      rmSync(data, { recursive: true, force: true })
    }
  },
)

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
}, 60_000)
