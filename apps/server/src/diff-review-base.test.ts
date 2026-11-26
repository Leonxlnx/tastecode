import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import * as checkpoint from './checkpoint.js'
import { readWorkspaceDiff } from './diff-review.js'
import { gitRepositoryTemplate, removeTestFolder } from './git-fixture.test-support.js'

const template = gitRepositoryTemplate('review-base-', { 'tracked.txt': 'original\n' })
let repo: string
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim()
const digest = (input: string) =>
  createHash('sha256').update(input).digest('base64url').slice(0, 22)
beforeAll(() => {
  template.build()
}, 30_000)
afterAll(() => template.dispose())
beforeEach(() => {
  repo = template.create()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  removeTestFolder(repo)
})

it.each(['ordinary', 'clean', 'detached', 'unborn', 'moving'])(
  'resolves the snapshot base once (%s HEAD)',
  async (state) => {
    if (state === 'detached') git('checkout', '--detach', '--quiet')
    if (state === 'unborn') {
      git('checkout', '--orphan', 'unborn', '--quiet')
      git('rm', '-rf', '--quiet', '.')
    }
    const emptyTree = () =>
      execFileSync('git', ['hash-object', '-t', 'tree', '--stdin'], {
        cwd: repo,
        windowsHide: true,
        input: '',
        encoding: 'utf8',
      }).trim()
    let base = state === 'unborn' ? emptyTree() : git('rev-parse', 'HEAD')
    if (state === 'moving') {
      const old = base
      writeFileSync(path.join(repo, 'tracked.txt'), 'committed on the new HEAD\n')
      git('add', 'tracked.txt')
      git('commit', '-qm', 'advance HEAD')
      base = git('rev-parse', 'HEAD')
      git('update-ref', 'HEAD', old)
      const capture = checkpoint.takeSnapshotWithBase
      vi.spyOn(checkpoint, 'takeSnapshotWithBase').mockImplementationOnce((...args) => {
        git('update-ref', 'HEAD', base)
        return capture(...args)
      })
    }
    if (state !== 'clean') {
      writeFileSync(path.join(repo, 'new.txt'), 'content\n')
      git('add', 'new.txt')
    }
    const tree = git('write-tree')
    const trace = path.join(repo, '.git', 'review.trace')
    vi.stubEnv('GIT_TRACE2_EVENT', trace)
    const diff = await readWorkspaceDiff(repo)
    expect(diff).toEqual({
      threadId: `workspace-${digest(repo)}`,
      version: digest(`${base}\0${tree}`),
      files:
        state === 'clean'
          ? []
          : [
              {
                path: 'new.txt',
                status: 'added',
                binary: false,
                hunks: [
                  {
                    id: digest(['hunk', 'new.txt', '0', '+content\n'].join('\0')),
                    header: '@@ -0,0 +1 @@',
                    oldStart: 0,
                    oldLines: 0,
                    newStart: 1,
                    newLines: 1,
                    lines: [{ kind: 'addition', newLine: 1, text: 'content' }],
                  },
                ],
              },
            ],
    })
    const starts = readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; argv?: string[] })
      .filter((event) => event.event === 'start')
      .map((event) => event.argv ?? [])
    expect(starts.filter((args) => args.includes('HEAD^{commit}'))).toHaveLength(1)
    expect(starts.filter((args) => args.includes(`${base}^{tree}`))).toHaveLength(
      state === 'unborn' ? 0 : 1,
    )
    if (state === 'unborn') {
      expect(starts.filter((args) => args.includes('hash-object'))).toHaveLength(1)
    }
  },
)
