import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalCheckoutRoot, CheckoutAccess } from './checkout-access.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function repo() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'harness-access-'))
  dirs.push(base)
  const root = path.join(base, 'repo')
  mkdirSync(root)
  execFileSync('git', ['init', '-q', root])
  const nested = path.join(root, 'nested')
  mkdirSync(nested)
  return { base, root, nested }
}
describe('checkout access', () => {
  it('blocks restore through a nested path or symlink while another task writes', async () => {
    const { base, root, nested } = repo()
    const alias = path.join(base, 'alias')
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const access = new CheckoutAccess()
    access.beginTurn(nested, 'working')
    expect(canonicalCheckoutRoot(alias)).toBe(canonicalCheckoutRoot(root))
    for (const directory of [root, nested, alias]) {
      await expect(access.exclusive(directory, async () => 'unsafe')).rejects.toThrow(
        /Chats are still working/,
      )
    }
    access.endTurn('working')
    await expect(access.exclusive(alias, async () => 'safe')).resolves.toBe('safe')
  })
  it('blocks new turns and second restores for the entire async restore', async () => {
    const { root, nested } = repo()
    const access = new CheckoutAccess()
    let finish!: () => void
    const hold = access.exclusive(
      root,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    expect(() => access.beginTurn(nested, 'new')).toThrow(/restored or switched/)
    await expect(access.exclusive(nested, async () => {})).rejects.toThrow(/another restore/)
    finish()
    await hold
    expect(() => access.beginTurn(root, 'new')).not.toThrow()
  })
  it('allows independent worktrees that share a Git object database', async () => {
    const { base, root } = repo()
    const worktree = path.join(base, 'isolated')
    execFileSync(
      'git',
      [
        '-c',
        'user.email=test@example.com',
        '-c',
        'user.name=Test',
        'commit',
        '--allow-empty',
        '-qm',
        'base',
      ],
      { cwd: root },
    )
    execFileSync('git', ['worktree', 'add', '--detach', worktree], { cwd: root, stdio: 'ignore' })
    const access = new CheckoutAccess()
    access.beginTurn(root, 'working')
    await expect(access.exclusive(worktree, async () => 'independent')).resolves.toBe('independent')
  })
})
