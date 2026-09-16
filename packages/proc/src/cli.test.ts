import { describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commandVersion, runCli } from './cli.js'

describe.skipIf(process.platform === 'win32')('runCli timeout teardown', () => {
  it('SIGKILLs stubborn descendants before rejecting', async () => {
    // Audit regression: a SIGTERM-only killTree leaves a descendant that
    // ignores SIGTERM heartbeating forever. runCli must escalate through
    // killTree and reject only after bounded cleanup completes.
    const beat = path.join(os.tmpdir(), `harness-runcli-timeout-${Date.now()}-${process.pid}.txt`)
    const grandchild = [
      "process.on('SIGTERM', () => {})",
      "const fs = require('fs')",
      `setInterval(() => fs.writeFileSync(${JSON.stringify(beat)}, String(Date.now())), 100)`,
    ].join(';')
    const parent = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' })`,
      'setInterval(() => {}, 1_000)',
    ].join(';')

    await expect(runCli(process.execPath, ['-e', parent], 400)).rejects.toThrow(/did not respond/)

    // Rejection waits for bounded cleanup, so the heartbeat file must exist
    // (the grandchild had 400ms+ to start) and must already be dead.
    expect(existsSync(beat)).toBe(true)
    const afterTimeout = readFileSync(beat, 'utf8')
    await sleep(600)
    try {
      expect(readFileSync(beat, 'utf8')).toBe(afterTimeout)
    } finally {
      rmSync(beat, { force: true })
    }
  })

  it('still captures fast output without waiting for cleanup', async () => {
    const result = await runCli(process.execPath, ['-e', 'process.stdout.write("ok")'], 2_000)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('ok')
  })

  it('keeps the primary error when teardown fails too', async () => {
    // A killTree failure after the response timeout must not mask the
    // timeout itself. The probe child exits on its own shortly after, so no
    // real process outlives the mocked group signal.
    const realKill = process.kill.bind(process)
    const signal = vi.spyOn(process, 'kill').mockImplementation((pid, value) => {
      if (typeof pid === 'number' && pid < 0) throw new Error('teardown failed')
      return realKill(pid, value)
    })
    try {
      await expect(
        runCli(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], 50),
      ).rejects.toThrow(/did not respond/)
    } finally {
      signal.mockRestore()
    }
  })
})

describe('runCli stdin', () => {
  it('closes stdin so a stdin-reading command can finish', async () => {
    const result = await runCli(
      process.execPath,
      [
        '-e',
        'process.stdin.resume(); process.stdin.once("end", () => process.stdout.write("eof"))',
      ],
      5_000,
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('eof')
  })
})

describe.skipIf(process.platform === 'win32')('commandVersion timeout teardown', () => {
  it('leaves no stubborn descendant behind a hung version probe', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-command-version-timeout-'))
    const beat = path.join(os.tmpdir(), `harness-version-beat-${Date.now()}-${process.pid}.txt`)
    const commandPath = path.join(directory, 'fake-version-hang')
    try {
      const grandchild = [
        "process.on('SIGTERM', () => {})",
        "const fs = require('fs')",
        `setInterval(() => fs.writeFileSync(${JSON.stringify(beat)}, String(Date.now())), 100)`,
      ].join(';')
      const probe = [
        "const { spawn } = require('node:child_process')",
        `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' })`,
        'setInterval(() => {}, 1_000)',
      ].join(';')
      writeFileSync(commandPath, `#!/usr/bin/env node\n${probe}\n`)
      chmodSync(commandPath, 0o755)

      await expect(commandVersion(commandPath, 400)).resolves.toBeUndefined()

      expect(existsSync(beat)).toBe(true)
      const afterTimeout = readFileSync(beat, 'utf8')
      await sleep(600)
      expect(readFileSync(beat, 'utf8')).toBe(afterTimeout)
    } finally {
      rmSync(directory, { recursive: true, force: true })
      rmSync(beat, { force: true })
    }
  })

  it('closes stdin so a version probe that reads it cannot hang', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-command-version-stdin-'))
    const commandPath = path.join(directory, 'fake-version-stdin')
    try {
      writeFileSync(
        commandPath,
        `#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.once('end', () => console.log('tool 1.2.3'))\n`,
      )
      chmodSync(commandPath, 0o755)

      await expect(commandVersion(commandPath, 2_000)).resolves.toBe('tool 1.2.3')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
