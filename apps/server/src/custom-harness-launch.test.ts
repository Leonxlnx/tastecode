import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CustomHarness } from '@harness/contracts'
import {
  customHarnessSpawn,
  mergeLaunchEnvironment,
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
    provider: 'codex',
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

  it.skipIf(process.platform === 'win32')(
    'reports a probe killed by a signal instead of accepting its partial output',
    async () => {
      const script = "process.stdout.write('stream-json'); process.kill(process.pid, 'SIGTERM')"
      await expect(
        runCustomHarness(harness({ args: ['-e', script] }), undefined, [], 2_000),
      ).rejects.toThrow(/stopped by SIGTERM/)
    },
  )

  it('resolves relative PATH entries against the launch directory', () => {
    const launchDirectory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'harness-mod-path-')))
    roots.push(launchDirectory)
    mkdirSync(path.join(launchDirectory, 'bin'))
    const executable = path.join(
      launchDirectory,
      'bin',
      process.platform === 'win32' ? 'my-agent.cmd' : 'my-agent',
    )
    writeFileSync(executable, '#!/bin/sh\n')
    chmodSync(executable, 0o755)

    const launch = resolveCustomHarnessLaunch(
      harness({
        command: 'my-agent',
        workingDirectory: launchDirectory,
        environment: { PATH: `.${path.sep}bin` },
      }),
      os.tmpdir(),
    )

    expect(launch.command).toBe(executable)
  })

  it('treats Windows variable names case-insensitively with later layers winning', () => {
    const merged = mergeLaunchEnvironment(
      [
        { PATH: 'C:\\inherited', USERPROFILE: 'C:\\Users\\me' },
        { Path: 'C:\\custom-agent-bin', Mode: 'custom' },
        { MODE: 'adapter' },
      ],
      'win32',
    )

    expect(Object.keys(merged).filter((key) => key.toLowerCase() === 'path')).toEqual(['PATH'])
    expect(merged.PATH?.split(';')[0]).toBe('C:\\custom-agent-bin')
    expect(merged.PATH).not.toContain('C:\\inherited')
    expect(Object.keys(merged).filter((key) => key.toLowerCase() === 'mode')).toEqual(['MODE'])
    expect(merged.MODE).toBe('adapter')
  })

  it('keeps differently cased variable names apart outside Windows', () => {
    const merged = mergeLaunchEnvironment(
      [{ PATH: '/usr/bin', HOME: '/home/me' }, { Path: 'not-a-search-path' }],
      'linux',
    )

    expect(merged.Path).toBe('not-a-search-path')
    expect(merged.PATH?.split(':')[0]).toBe('/usr/bin')
  })
})
