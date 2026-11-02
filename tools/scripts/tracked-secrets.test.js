import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// A Trecko feedback key is `fb_` and 36 hex characters. The pattern is built
// from parts so this file never matches itself.
const FEEDBACK_KEY = ['fb', '_[0-9a-f]{20,}'].join('')

test('no feedback inbox key is tracked in the repository', (context) => {
  // Working-tree contents of tracked files, so a staged or unstaged key fails too.
  const result = spawnSync('git', ['grep', '-I', '-l', '-E', FEEDBACK_KEY, '--', '.'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    context.skip('git is not available in this checkout')
    return
  }
  assert.deepEqual(
    result.stdout.split('\n').filter(Boolean),
    [],
    'Remove the feedback key from these files; it is injected at build time only.',
  )
})
