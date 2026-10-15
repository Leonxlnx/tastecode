// Run after pnpm build. Exercises the real desktop launch paths without starting
// provider CLIs, opening a window, or touching the user's profile/server.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electron = createRequire(import.meta.url)('electron')
const root = await mkdtemp(path.join(os.tmpdir(), 'tastecode-startup-directory-'))
try {
  const inherited = path.join(root, 'external-launch-directory')
  const renderer = path.join(root, 'blank.html')
  const probe = path.join(root, 'probe.cjs')
  await mkdir(inherited)
  await writeFile(renderer, '<!doctype html><title>Startup directory proof</title>')
  await writeFile(
    probe,
    `if (process.type === 'utility' || process.env.ELECTRON_RUN_AS_NODE === '1') {
      const fs = require('node:fs');
      fs.writeFileSync(process.env.STARTUP_CWD_REPORT, JSON.stringify({ cwd: process.cwd(), pwd: process.env.PWD }));
      // Exit before loading the actual server or any provider CLI.
      process.exit(0);
    }`,
  )
  for (const legacy of ['0', '1']) {
    const profile = path.join(root, `profile-${legacy}`)
    const report = path.join(root, `cwd-${legacy}.json`)
    const env = {
      ...process.env,
      PWD: inherited,
      NODE_OPTIONS: `--require=${JSON.stringify(probe)}`,
      STARTUP_CWD_REPORT: report,
      HARNESS_LEGACY_SERVER_PROCESS: legacy,
      HARNESS_DESKTOP_DATA_DIR: profile,
      HARNESS_DATA_DIR: path.join(profile, 'server'),
      HARNESS_CONFIG_DIR: path.join(profile, 'config'),
      HARNESS_STARTUP_STARTED_AT: String(Date.now()),
      HARNESS_STARTUP_EXIT_AFTER_READY: '1',
      HARNESS_STARTUP_RENDERER: renderer,
      HARNESS_DISABLE_GPU: '1',
    }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.HARNESS_DEV_SERVER
    const child = spawn(electron, [desktop], {
      cwd: inherited,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const closed = once(child, 'close')
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    try {
      let result
      for (let attempt = 0; attempt < 100; attempt++) {
        const contents = await readFile(report, 'utf8').catch(() => undefined)
        if (contents) {
          result = JSON.parse(contents)
          break
        }
        if (child.exitCode !== null) break
        await delay(100)
      }
      assert.ok(result, `Server directory probe did not run (${legacy}): ${output}`)
      assert.equal(await realpath(result.cwd), await realpath(profile))
      assert.equal(await realpath(result.pwd), await realpath(profile))
      console.log(`PASS: ${legacy === '1' ? 'legacy' : 'utility'} server starts in app storage`)
    } finally {
      child.kill()
      await closed
    }
  }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
