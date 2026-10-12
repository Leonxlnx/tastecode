import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { CRASH_AGENT_PROMPT, terminalLaunch } from './crash-agent.js'

const run = promisify(execFile)
let root: string | undefined

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Runs the generated launcher itself, minus the terminal window, against a stub
 * agent: on Windows that stub is a `.cmd` shim like npm's, on macOS and Linux a
 * plain executable. The crash folder name carries a space, an apostrophe and a
 * non-ASCII letter so each shell's quoting and the script encoding are exercised.
 */
describe('crash agent launcher', () => {
  it('starts the agent in the crash folder with the bypass flag and the prompt', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'crash-launch-'))
    const bin = path.join(root, 'bin')
    const directory = path.join(root, "crash ł'o")
    const record = path.join(root, 'record.json')
    await mkdir(bin)
    await mkdir(directory)
    await writeFile(path.join(directory, 'prompt.txt'), CRASH_AGENT_PROMPT)
    const recorder = path.join(bin, 'record.cjs')
    await writeFile(
      recorder,
      `require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }))`,
    )
    const windows = process.platform === 'win32'
    const agentPath = path.join(bin, windows ? 'stub-agent.cmd' : 'stub-agent')
    await writeFile(
      agentPath,
      windows
        ? `@echo off\r\nnode "%~dp0record.cjs" %*\r\n`
        : `#!/bin/sh\nexec node ${JSON.stringify(recorder)} "$@"\n`,
    )
    if (!windows) await chmod(agentPath, 0o755)

    const launch = terminalLaunch(
      process.platform,
      directory,
      { command: agentPath, args: ['--dangerously-skip-permissions'] },
      { command: 'unused', prefix: [] },
      process.env.PATH,
    )
    const script = path.join(directory, launch.script.name)
    await writeFile(script, launch.script.contents)
    if (windows) {
      await run(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { timeout: 60_000 },
      )
    } else {
      const shell = run(process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash', [script], {
        env: { ...process.env, SHELL: '/bin/sh' },
        timeout: 60_000,
      })
      // The trailing login shell reads its closed input and exits at once.
      shell.child.stdin?.end()
      await shell
    }

    const recorded = JSON.parse(await readFile(record, 'utf8')) as { cwd: string; args: string[] }
    expect(path.basename(recorded.cwd)).toBe("crash ł'o")
    expect(recorded.args).toEqual(['--dangerously-skip-permissions', CRASH_AGENT_PROMPT])
  }, 90_000)
})
