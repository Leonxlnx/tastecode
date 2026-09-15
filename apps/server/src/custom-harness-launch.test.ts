import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CustomHarness } from '@harness/contracts'
import {
  customHarnessSpawn,
  resolveCustomHarnessLaunch,
  runCustomHarness,
} from './custom-harness-launch.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function harness(input: Partial<CustomHarness> = {}): CustomHarness {
  return {
    id: 'custom-node',
    displayName: 'Custom Node',
    provider: 'pi',
    command: process.execPath,
    args: [],
    ...input,
  }
}

describe('custom harness launch', () => {
  it('resolves PATH commands with the configured environment', () => {
    const command = path.basename(process.execPath)
    const launch = resolveCustomHarnessLaunch(
      harness({ command, environment: { PATH: path.dirname(process.execPath) } }),
      process.cwd(),
    )

    expect(launch.command).toBe(process.execPath)
    expect(launch.environment.HARNESS_WORKSPACE_PATH).toBe(process.cwd())
  })

  it('uses a mod launch directory while preserving the active workspace for wrappers', async () => {
    const launchDirectory = mkdtempSync(path.join(os.tmpdir(), 'harness-mod-source-'))
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-mod-workspace-'))
    roots.push(launchDirectory, workspace)
    const script =
      'process.stdout.write(JSON.stringify({cwd:process.cwd(),workspace:process.env.HARNESS_WORKSPACE_PATH,profile:process.env.MOD_PROFILE,args:process.argv.slice(1)}))'
    const result = await runCustomHarness(
      harness({
        args: ['-e', script],
        workingDirectory: launchDirectory,
        environment: { MOD_PROFILE: 'isolated' },
      }),
      workspace,
      ['protocol-arg'],
    )

    expect(JSON.parse(result.stdout)).toEqual({
      cwd: realpathSync(launchDirectory),
      workspace,
      profile: 'isolated',
      args: ['protocol-arg'],
    })
  })

  it('fails before spawning when a shell-only alias cannot be resolved', () => {
    const spawn = customHarnessSpawn(
      harness({ command: 'only-a-shell-function', environment: { PATH: '' } }),
    )

    expect(() => spawn('ignored', [], {})).toThrow(/Shell aliases and functions are unavailable/)
  })

  it('waits for inherited output pipes to drain before returning', async () => {
    const lateOutput = "setTimeout(() => process.stdout.write('late'), 50)"
    const script = [
      "const { spawn } = require('node:child_process')",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(lateOutput)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] })`,
      'child.unref()',
      "process.stdout.write('early-')",
    ].join(';')

    const result = await runCustomHarness(harness({ args: ['-e', script] }), undefined, [], 2_000)

    expect(result.stdout).toBe('early-late')
  })

  it('redacts configured environment values from child failure details', async () => {
    const secret = 'custom-environment-sentinel'
    const script = 'process.stderr.write(process.env.CUSTOM_SECRET);process.exit(2)'

    await expect(
      runCustomHarness(
        harness({ args: ['-e', script], environment: { CUSTOM_SECRET: secret } }),
        undefined,
        [],
      ),
    ).rejects.toThrow('exited with code 2: [redacted]')
    await expect(
      runCustomHarness(
        harness({ args: ['-e', script], environment: { CUSTOM_SECRET: secret } }),
        undefined,
        [],
      ),
    ).rejects.not.toThrow(secret)
  })

  it.skipIf(process.platform === 'win32')(
    'SIGKILLs stubborn descendants before reporting a timeout',
    async () => {
      // Audit regression: a SIGTERM-only killTree leaves a descendant that
      // ignores SIGTERM heartbeating forever. The timeout latches first so a
      // racing close cannot change it, and rejection waits for bounded
      // full-tree cleanup.
      const beat = path.join(os.tmpdir(), `harness-custom-timeout-${Date.now()}-${process.pid}.txt`)
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

      try {
        await expect(
          runCustomHarness(harness({ args: ['-e', parent] }), undefined, [], 400),
        ).rejects.toThrow(/did not answer within/)
        expect(existsSync(beat)).toBe(true)
        const afterTimeout = readFileSync(beat, 'utf8')
        await new Promise((resolve) => setTimeout(resolve, 600))
        expect(readFileSync(beat, 'utf8')).toBe(afterTimeout)
      } finally {
        rmSync(beat, { force: true })
      }
    },
  )
})
