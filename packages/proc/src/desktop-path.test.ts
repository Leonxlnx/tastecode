import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyDesktopPath, desktopPath, isInstalled } from './index.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktopPath', () => {
  it('keeps inherited entries first and adds the user-local bin directory', () => {
    const home = '/Users/harness-desktop-path-home'
    const current = ['/system/bin', '/opt/app/bin'].join(path.posix.delimiter)
    const result = desktopPath(current, { platform: 'darwin', home, env: {} })

    expect(result.split(path.posix.delimiter).slice(0, 2)).toEqual(['/system/bin', '/opt/app/bin'])
    expect(result.split(path.posix.delimiter)).toContain(path.posix.join(home, '.local', 'bin'))
    expect(result.split(path.posix.delimiter)).toContain('/opt/homebrew/bin')
  })

  it('does not duplicate a user bin that is already on PATH', () => {
    const home = '/Users/tester'
    const local = path.posix.join(home, '.local', 'bin')
    const current = ['/usr/bin', local].join(path.posix.delimiter)
    const result = desktopPath(current, { platform: 'darwin', home, env: {} })

    expect(result.split(path.posix.delimiter).filter((entry) => entry === local)).toHaveLength(1)
  })

  it('adds the per-user npm shim directory on Windows', () => {
    const home = 'C:\\Users\\tester'
    const result = desktopPath('C:\\Windows\\System32', {
      platform: 'win32',
      home,
      env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
    })

    expect(result.split(path.win32.delimiter)).toContain(
      path.win32.join('C:\\Users\\tester\\AppData\\Roaming', 'npm'),
    )
    expect(result.split(path.win32.delimiter)).toContain(path.win32.join(home, '.local', 'bin'))
  })

  it('writes the desktop-safe PATH back onto the given environment', () => {
    const home = process.platform === 'win32' ? 'C:\\Users\\tester' : '/Users/tester'
    const env: NodeJS.ProcessEnv = {
      PATH: process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin',
      HOME: home,
      USERPROFILE: home,
    }
    const next = applyDesktopPath(env)
    expect(env.PATH).toBe(next)
    expect(next.split(path.delimiter)).toContain(path.join(home, '.local', 'bin'))
  })
})

describe('isInstalled', () => {
  it('finds a user-local shim that a GUI PATH would miss', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'harness-desktop-path-'))
    roots.push(home)
    const bin = path.join(home, '.local', 'bin')
    mkdirSync(bin, { recursive: true })
    const command = `harness-gui-path-${process.pid}`
    const file = process.platform === 'win32' ? `${command}.cmd` : command
    writeFileSync(
      path.join(bin, file),
      process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n',
      { mode: 0o755 },
    )

    const guiPath =
      process.platform === 'win32'
        ? path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
        : '/usr/bin:/bin'
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: guiPath,
    }

    await expect(commandOnPath(command, guiPath, env)).resolves.toBe(false)
    await expect(isInstalled(command, env)).resolves.toBe(true)
  })
})

function commandOnPath(
  command: string,
  searchPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  const [lookup, args] =
    process.platform === 'win32' ? ['where.exe', [command]] : ['/usr/bin/which', [command]]
  return new Promise((resolve) => {
    const child = spawn(lookup, args, {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...environment, PATH: searchPath },
    })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}
