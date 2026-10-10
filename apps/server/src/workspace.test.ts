import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listWorkspaceBranches, readWorkspace, switchWorkspaceBranch } from './workspace.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function repository(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'harness-workspace-'))
  git(repo, 'init', '--initial-branch=main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(path.join(repo, 'file.txt'), 'main\n')
  git(repo, 'add', 'file.txt')
  git(repo, 'commit', '-m', 'initial')
  git(repo, 'branch', 'feature/shelf')
  return repo
}

describe('workspace branches', () => {
  it('lists local branches with the current branch first', async () => {
    const repo = repository()
    expect(await listWorkspaceBranches(repo)).toEqual(['main', 'feature/shelf'])
  })

  it('switches to a known local branch and reports the new workspace', async () => {
    const repo = repository()
    expect(await switchWorkspaceBranch(repo, 'feature/shelf')).toEqual({
      branch: 'feature/shelf',
      added: 0,
      removed: 0,
      dirtyFiles: 0,
    })
    expect((await readWorkspace(repo)).branch).toBe('feature/shelf')
  })

  it('lists and switches to a branch that shares its name with a tag', async () => {
    const repo = repository()
    git(repo, 'branch', 'release')
    git(repo, 'tag', 'release')
    expect(await listWorkspaceBranches(repo)).toEqual(['main', 'feature/shelf', 'release'])
    expect((await switchWorkspaceBranch(repo, 'release')).branch).toBe('release')
    expect(await listWorkspaceBranches(repo)).toEqual(['release', 'feature/shelf', 'main'])
  })

  it('rejects revisions that are not local branch names', async () => {
    const repo = repository()
    await expect(switchWorkspaceBranch(repo, 'HEAD~1')).rejects.toThrow('unknown local branch')
  })
})
