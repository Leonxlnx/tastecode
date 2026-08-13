import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
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
})
