import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commitCheckout, gitError, pushCheckout } from './workspace-git.js'

const temporary: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  // git on Windows can hold a handle in the folder for a moment after it exits.
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5 })),
  )
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim()
}

async function folder(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-workspace-git-'))
  temporary.push(root)
  // Never discover a repository above the temporary folder.
  vi.stubEnv('GIT_CEILING_DIRECTORIES', path.dirname(root))
  return root
}

/** A checkout on `main` with one commit, cloned from a bare remote on disk. */
async function checkout(): Promise<{ root: string; work: string; remote: string }> {
  const root = await folder()
  const remote = path.join(root, 'remote.git')
  const work = path.join(root, 'work')
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(root, 'init', '-q', '-b', 'main', work)
  git(work, 'config', 'user.email', 'test@example.com')
  git(work, 'config', 'user.name', 'Test')
  git(work, 'config', 'commit.gpgsign', 'false')
  git(work, 'config', 'core.autocrlf', 'false')
  git(work, 'config', 'core.hooksPath', path.join(root, 'no-hooks'))
  await writeFile(path.join(work, 'tracked.txt'), 'one\n')
  git(work, 'add', 'tracked.txt')
  git(work, 'commit', '-q', '-m', 'first')
  git(work, 'remote', 'add', 'origin', remote)
  git(work, 'push', '-q', '-u', 'origin', 'main')
  return { root, work, remote }
}

describe('committing a checkout', () => {
  it('commits tracked and untracked changes with the message from stdin', async () => {
    const { work } = await checkout()
    await writeFile(path.join(work, 'tracked.txt'), 'two\n')
    await writeFile(path.join(work, 'new.txt'), 'new\n')
    const message = 'feat: say "two"\n\nThe body keeps $HOME, %PATH% & `ticks`.\n# not a comment'

    const result = await commitCheckout(work, { message, includeUntracked: true })

    expect(result).toEqual({ commit: git(work, 'rev-parse', 'HEAD'), branch: 'main' })
    expect(git(work, 'log', '-1', '--format=%B')).toBe(message)
    expect(git(work, 'status', '--porcelain')).toBe('')
  })

  it('leaves untracked files out when asked', async () => {
    const { work } = await checkout()
    await writeFile(path.join(work, 'tracked.txt'), 'two\n')
    await writeFile(path.join(work, 'new.txt'), 'new\n')

    await commitCheckout(work, { message: 'fix: tracked only', includeUntracked: false })

    expect(git(work, 'show', '--name-only', '--format=', 'HEAD')).toBe('tracked.txt')
    expect(git(work, 'status', '--porcelain')).toBe('?? new.txt')
  })

  it('commits only the project folder when the project is a repository subfolder', async () => {
    const { work } = await checkout()
    const project = path.join(work, 'apps', 'web')
    await mkdir(project, { recursive: true })
    await writeFile(path.join(project, 'inside.txt'), 'in\n')
    await writeFile(path.join(work, 'outside.txt'), 'out\n')
    await writeFile(path.join(work, 'tracked.txt'), 'staged elsewhere\n')
    git(work, 'add', 'tracked.txt')

    await commitCheckout(project, { message: 'feat(web): inside', includeUntracked: true })

    expect(git(work, 'show', '--name-only', '--format=', 'HEAD')).toBe('apps/web/inside.txt')
    expect(git(work, 'status', '--porcelain').split('\n').sort()).toEqual([
      '?? outside.txt',
      'M  tracked.txt',
    ])
  })

  it('says when there is nothing to commit', async () => {
    const { work } = await checkout()
    await expect(
      commitCheckout(work, { message: 'chore: nothing', includeUntracked: true }),
    ).rejects.toThrow('There is nothing to commit.')
  })

  it('refuses to stage a file that still has merge conflicts', async () => {
    const { work } = await checkout()
    git(work, 'switch', '-q', '-c', 'other')
    await writeFile(path.join(work, 'tracked.txt'), 'other\n')
    git(work, 'commit', '-q', '-am', 'other')
    git(work, 'switch', '-q', 'main')
    await writeFile(path.join(work, 'tracked.txt'), 'main\n')
    git(work, 'commit', '-q', '-am', 'main')
    expect(() => git(work, 'merge', '-q', 'other')).toThrow()

    await expect(
      commitCheckout(work, { message: 'merge', includeUntracked: true }),
    ).rejects.toThrow('Resolve the merge conflicts before committing.')
    expect(git(work, 'diff', '--name-only', '--diff-filter=U')).toBe('tracked.txt')
  })

  it("reports a hook's refusal in its own words", async () => {
    const { root, work } = await checkout()
    const hooks = path.join(root, 'hooks')
    await mkdir(hooks)
    await writeFile(
      path.join(hooks, 'pre-commit'),
      '#!/bin/sh\necho "hint: ignored" >&2\necho "lint failed: tracked.txt" >&2\nexit 1\n',
      { mode: 0o755 },
    )
    git(work, 'config', 'core.hooksPath', hooks)
    await writeFile(path.join(work, 'tracked.txt'), 'two\n')

    await expect(
      commitCheckout(work, { message: 'fix: blocked', includeUntracked: true }),
    ).rejects.toThrow('lint failed: tracked.txt')
  })

  it('refuses a folder that is not a checkout', async () => {
    await expect(
      commitCheckout(await folder(), { message: 'x', includeUntracked: true }),
    ).rejects.toThrow('This folder is not a git checkout.')
  })
  // Every step spawns git, which takes a while on a busy Windows machine.
}, 120_000)

describe('pushing a checkout', () => {
  it('publishes a new branch under its own name and tracks it', async () => {
    const { work, remote } = await checkout()
    git(work, 'switch', '-q', '-c', 'feature/review-push')
    git(work, 'commit', '-q', '--allow-empty', '-m', 'work')

    expect(await pushCheckout(work)).toEqual({ branch: 'feature/review-push', remote: 'origin' })
    expect(git(remote, 'rev-parse', 'refs/heads/feature/review-push')).toBe(
      git(work, 'rev-parse', 'HEAD'),
    )
    expect(git(work, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feature/review-push')
  })

  it('pushes new commits of a tracked branch', async () => {
    const { work, remote } = await checkout()
    git(work, 'commit', '-q', '--allow-empty', '-m', 'second')

    expect(await pushCheckout(work)).toEqual({ branch: 'main', remote: 'origin' })
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(git(work, 'rev-parse', 'HEAD'))
  })

  it('never pushes a branch into the differently named branch it tracks', async () => {
    const { work, remote } = await checkout()
    const main = git(remote, 'rev-parse', 'refs/heads/main')
    git(work, 'switch', '-q', '-c', 'started-from-main', '--track', 'origin/main')
    git(work, 'commit', '-q', '--allow-empty', '-m', 'work')

    await pushCheckout(work)

    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(main)
    expect(git(remote, 'rev-parse', 'refs/heads/started-from-main')).toBe(
      git(work, 'rev-parse', 'HEAD'),
    )
    expect(git(work, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/started-from-main')
  })

  it('never forces over commits the checkout does not have', async () => {
    const { root, work, remote } = await checkout()
    const other = path.join(root, 'other')
    git(root, 'clone', '-q', remote, other)
    git(
      other,
      '-c',
      'user.email=o@example.com',
      '-c',
      'user.name=O',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'theirs',
    )
    git(other, 'push', '-q', 'origin', 'main')
    const theirs = git(remote, 'rev-parse', 'refs/heads/main')
    git(work, 'commit', '-q', '--allow-empty', '-m', 'mine')

    await expect(pushCheckout(work)).rejects.toThrow(
      'origin has commits this branch does not have. Pull them first, then push again.',
    )
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(theirs)
  })

  it('refuses a detached HEAD, an unborn branch and a checkout without a remote', async () => {
    const { work } = await checkout()
    git(work, 'switch', '-q', '--detach')
    await expect(pushCheckout(work)).rejects.toThrow('Check out a branch before pushing.')

    git(work, 'switch', '-q', '--orphan', 'empty')
    await expect(pushCheckout(work)).rejects.toThrow('Commit something before pushing.')

    const local = await folder()
    git(local, 'init', '-q', '-b', 'main')
    git(
      local,
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=T',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    )
    await expect(pushCheckout(local)).rejects.toThrow('This checkout has no remote to push to.')
  })
  // Every step spawns git, which takes a while on a busy Windows machine.
}, 120_000)

describe('git error text', () => {
  it('keeps git explaining itself without hints or credentials', () => {
    const error = gitError(
      {
        code: 128,
        stdout: '',
        stderr: [
          'remote: Permission to team/repo.git denied to someone.',
          "fatal: unable to access 'https://someone:ghp_secret@github.com/team/repo.git/': The requested URL returned error: 403",
          'hint: try again',
        ].join('\n'),
      },
      'fallback',
    )
    expect(error.message).toBe(
      [
        'remote: Permission to team/repo.git denied to someone.',
        "fatal: unable to access 'https://github.com/team/repo.git/': The requested URL returned error: 403",
      ].join('\n'),
    )
    expect(gitError({ code: 1, stdout: '', stderr: 'hint: only a hint' }, 'fallback').message).toBe(
      'fallback',
    )
  })
})
