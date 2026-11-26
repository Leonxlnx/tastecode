import { execFile, execFileSync } from 'node:child_process'
import { renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { takeSnapshot } from './checkpoint.js'
import * as cli from '@harness/proc/cli'
import * as index from './checkpoint-index.js'
import { gitRepositoryTemplate, removeTestFolder } from './git-fixture.test-support.js'

vi.mock('./checkpoint-index.js', { spy: true })
const run = promisify(execFile)
const template = gitRepositoryTemplate('index-flags-', {
  'dir/Tracked ü.txt': 'initial\n',
  'sparse/file': 'sparse\n',
  '.gitignore': 'ignored\n',
})
let repo: string
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8' })
const save = (file: string, content: string) => writeFileSync(path.join(repo, file), content)
const tracked = 'dir/Tracked ü.txt'

beforeAll(() => {
  template.build()
}, 30_000)
beforeEach(() => {
  repo = template.create()
})
afterEach(() => {
  vi.restoreAllMocks()
  removeTestFolder(repo)
})
afterAll(() => template.dispose())

async function oldTrust(
  cwd: string,
  timeout = 20000,
  command = 'git',
  args = ['ls-files', '-v', '-z'],
) {
  try {
    const { stdout } = await run(command, args, {
      cwd,
      windowsHide: true,
      timeout,
      maxBuffer: 256 * 1024 * 1024,
    })
    return stdout.split('\0').every((entry) => entry === '' || entry.startsWith('H '))
  } catch {
    return false
  }
}

async function compare(
  cwd = repo,
  options: Parameters<typeof takeSnapshot>[1] = {},
  plain = false,
) {
  expect(await index.indexTrustsWorkingTree(cwd)).toBe(await oldTrust(cwd))
  const result = () =>
    takeSnapshot(cwd, options).catch((error: Error) => ({
      name: error.name,
      message: error.message,
    }))
  const original = vi.spyOn(index, 'indexTrustsWorkingTree').mockImplementation(oldTrust)
  let expected
  try {
    expected = await result()
  } finally {
    original.mockRestore()
  }
  if (plain) expect(expected).toHaveProperty('name', 'NotARepositoryForCheckpoint')
  else expect(expected).toHaveProperty('commit', expect.stringMatching(/^[0-9a-f]{40,64}$/))
  expect(await result()).toStrictEqual(expected)
}

it.each([
  'clean',
  'dirty',
  'staged',
  'untracked',
  'ignored',
  'assume-unchanged',
  'skip-worktree',
  'sparse',
  'case rename',
  'requested ignored',
  'scoped',
  'nonrepository',
  'submodule',
  'merge',
  'rebase',
])(
  'matches the buffered trust decision and checkpoint for %s',
  async (state) => {
    switch (state) {
      case 'dirty':
        save(tracked, 'changed')
        break
      case 'staged':
        save(tracked, 'staged')
        git('add', tracked)
        save(tracked, 'working')
        break
      case 'untracked':
      case 'ignored':
        save(state, 'new')
        break
      case 'assume-unchanged':
      case 'skip-worktree':
        git('update-index', '--' + state, tracked)
        save(tracked, 'hidden edit')
        break
      case 'sparse':
        git('update-index', '--refresh')
        git('sparse-checkout', 'set', 'dir')
        expect(git('ls-files', '-v', '-z')).toContain('S sparse/file\0')
        break
      case 'case rename':
        renameSync(path.join(repo, tracked), path.join(repo, 'intermediate'))
        renameSync(path.join(repo, 'intermediate'), path.join(repo, 'dir/tracked ü.txt'))
        break
      case 'requested ignored':
        save('ignored', 'explicitly included')
        await compare(repo, { ignoredFiles: ['ignored'] })
        return
      case 'scoped':
        git('update-index', '--assume-unchanged', tracked)
        save(tracked, 'outside scope')
        await compare(path.join(repo, 'sparse'))
        return
      case 'nonrepository':
        renameSync(path.join(repo, '.git'), path.join(repo, 'disabled-git-dir'))
        await compare(repo, {}, true)
        return
      case 'submodule':
        git('-c', 'protocol.file.allow=always', 'submodule', 'add', template.build(), 'module')
        git('commit', '-qm', 'module')
        await compare()
        save('module/' + tracked, 'submodule edit')
        break
      case 'merge':
      case 'rebase':
        git('switch', '-qc', 'side')
        save(tracked, 'side')
        git('commit', '-qam', 'side')
        git('switch', '-q', 'main')
        save(tracked, 'main')
        git('commit', '-qam', 'main')
        expect(() => git(state, 'side')).toThrow()
        expect(git('ls-files', '-u')).not.toBe('')
        break
    }
    await compare()
  },
  120_000,
)

it('handles quoted names and newlines in a real index even on Windows', async () => {
  const blob = git('rev-parse', 'HEAD:' + tracked).trim()
  const file = 'quotes " and\nnewline ü'
  execFileSync('git', ['-c', 'core.protectNTFS=false', 'update-index', '-z', '--index-info'], {
    cwd: repo,
    windowsHide: true,
    input: '100644 ' + blob + '\t' + file + '\0',
  })
  expect(git('ls-files', '-v', '-z')).toContain('H ' + file + '\0')
  await compare()
})

it('preserves the record predicate across every possible chunk boundary', () => {
  for (const value of [
    '',
    '\0',
    'H',
    'H ',
    'H name\0\0',
    'H ü\n"\0H next',
    'H\0',
    'S path\0',
    'h path\0',
  ]) {
    for (let i = 0; i <= value.length; i++) {
      const flags = new index.IndexFlags()
      flags.push(value.slice(0, i))
      flags.push(value.slice(i))
      expect(flags.trusted()).toBe(
        value.split('\0').every((entry) => entry === '' || entry.startsWith('H ')),
      )
    }
  }
})

it('refuses a failed or timed out git even if ordinary entries were expected', async () => {
  const invalidIndex = path.join(repo, 'invalid-index')
  writeFileSync(invalidIndex, 'invalid')
  vi.stubEnv('GIT_INDEX_FILE', invalidIndex)
  try {
    expect(await oldTrust(repo)).toBe(false)
    expect(await index.indexTrustsWorkingTree(repo)).toBe(false)
  } finally {
    vi.unstubAllEnvs()
  }
  const args = ['-e', "process.stdout.write('H trusted\\0'); setInterval(() => {}, 1000)"]
  const spawn = cli.spawnCli
  const hung = vi
    .spyOn(cli, 'spawnCli')
    .mockImplementationOnce((_command, _args, options) => spawn(process.execPath, args, options))
  try {
    expect(await oldTrust(repo, 250, process.execPath, args)).toBe(false)
    expect(await index.indexTrustsWorkingTree(repo, 250)).toBe(false)
    expect(hung).toHaveBeenCalledOnce()
  } finally {
    hung.mockRestore()
  }
})

it('reads a clean index without materializing its path list', async () => {
  for (let i = 0; i < 128; i++) save('count-' + i, 'tracked')
  git('add', '.')
  git('commit', '-qm', 'count fixture')
  const countPaths = async (action: () => Promise<boolean>) => {
    let count = 0
    const original = String.prototype.split
    const split = vi.spyOn(String.prototype, 'split').mockImplementation(function (
      this: string,
      ...args
    ) {
      const result = Reflect.apply(original, this, args) as string[]
      if (args[0] === '\0' && this.startsWith('H .gitignore\0')) count += result.length - 1
      return result
    })
    try {
      expect(await action()).toBe(true)
      return count
    } finally {
      split.mockRestore()
    }
  }
  expect(await countPaths(() => oldTrust(repo))).toBe(131)
  expect(await countPaths(() => index.indexTrustsWorkingTree(repo))).toBe(0)
})
