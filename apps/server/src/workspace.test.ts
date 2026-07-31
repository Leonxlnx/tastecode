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

  it('rejects revisions that are not local branch names', async () => {
    const repo = repository()
    await expect(switchWorkspaceBranch(repo, 'HEAD~1')).rejects.toThrow('unknown local branch')
  })
})
