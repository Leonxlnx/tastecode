import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-preview-proof-'))
const report = path.resolve(process.argv[2] ?? path.join(here, '../preview-results'))
try {
  await import('./build-preload.js')
  const executable = path.join(directory, 'proof.cjs')
  await build({
    entryPoints: [path.join(here, 'preview-proof.ts')],
    outfile: executable,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  })
  const child = spawn(require('electron'), [executable], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      HARNESS_PREVIEW_PROOF_DATA: directory,
      HARNESS_PREVIEW_PROOF_REPORT: report,
      HARNESS_PREVIEW_PROOF_PRELOAD: path.resolve(here, '../dist/preload.cjs'),
    },
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000)
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`Preview proof exited ${code}`)),
      )
    })
  } finally {
    clearTimeout(timeout)
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
