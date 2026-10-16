import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, bench, describe } from 'vitest'
import { takeSnapshot } from './checkpoint.js'

const OPTIONS = { iterations: 10, time: 0, warmupIterations: 2, warmupTime: 0 }
const FILE_COUNT = 2_000
const FILE_BYTES = 32 * 1024

const repo = mkdtempSync(path.join(os.tmpdir(), 'harness-checkpoint-bench-'))
const legacyIndex = path.join(os.tmpdir(), `${path.basename(repo)}-index`)
const git = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  execFileSync('git', args, { cwd: repo, env, windowsHide: true, maxBuffer: 256 * 1024 * 1024 })

git(['init', '-q', '-b', 'main'])
git(['config', 'user.email', 'bench@example.com'])
git(['config', 'user.name', 'Bench'])
git(['config', 'core.autocrlf', 'false'])
const body = 'x'.repeat(FILE_BYTES)
for (let index = 0; index < FILE_COUNT; index += 1) {
  const directory = path.join(repo, `d${index % 50}`)
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, `f${index}.txt`), `${index}\n${body}`)
}
git(['add', '.'])
git(['commit', '-q', '-m', 'bench'])
// A checkout in use has an index with current stat data.
git(['update-index', '--refresh'])
writeFileSync(path.join(repo, 'd0', 'f0.txt'), 'agent edit\n')

/** The index steps snapshots used before: no stat data, so every file is hashed. */
function stageFromPlainReadTree(): void {
  rmSync(legacyIndex, { force: true })
  const env = { ...process.env, GIT_INDEX_FILE: legacyIndex }
  git(['read-tree', 'HEAD'], env)
  git(['add', '-A'], env)
  git(['write-tree'], env)
}

afterAll(() => {
  rmSync(legacyIndex, { force: true })
  rmSync(repo, { recursive: true, force: true })
})

describe('checkpoint snapshot of a 2,000-file checkout with one edit', () => {
  bench('stages from a plain read-tree (index steps only)', stageFromPlainReadTree, OPTIONS)
  bench(
    'takes the whole snapshot from the checkout index',
    async () => {
      await takeSnapshot(repo)
    },
    OPTIONS,
  )
})
