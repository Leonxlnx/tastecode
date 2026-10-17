import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  expireWindowsPath,
  parseRegistryPath,
  refreshWindowsPath,
  resetWindowsPathForTests,
  type RegistryExport,
} from './desktop-path.js'
import { applyDesktopPath, desktopPath, isInstalled, spawnCli } from './index.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  resetWindowsPathForTests()
})

/** An Environment key exported the way reg.exe writes it: UTF-16LE, wrapped hex. */
function exportedKey(value: string | undefined, kind: 'expand' | 'string' = 'expand'): Buffer {
  let pathLine = ''
  if (value !== undefined && kind === 'string') {
    pathLine = `"Path"="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\r\n`
  } else if (value !== undefined) {
    const bytes = [...Buffer.from(`${value}\0`, 'utf16le')].map((byte) =>
      byte.toString(16).padStart(2, '0'),
    )
    const rows: string[] = []
    for (let index = 0; index < bytes.length; index += 25) {
      rows.push(bytes.slice(index, index + 25).join(','))
    }
    pathLine = `"Path"=hex(2):${rows.join(',\\\r\n  ')}\r\n`
  }
  const text = [
    'Windows Registry Editor Version 5.00\r\n\r\n',
    '[HKEY_CURRENT_USER\\Environment]\r\n',
    '"TEMP"=hex(2):25,00,54,00,25,00,00,00\r\n',
    pathLine,
    '"OneDrive"="C:\\\\Users\\\\tester\\\\OneDrive"\r\n\r\n',
  ].join('')
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
}

/** A reg.exe stand-in that exports the given Path value for each key. */
function registry(values: { machine?: string; user?: string }) {
  return vi.fn<RegistryExport>(async (key, file) => {
    const value = key.startsWith('HKCU') ? values.user : values.machine
    writeFileSync(file, exportedKey(value))
  })
}

describe('desktopPath', () => {
  it('reads the Windows Path spelling from a copied environment', () => {
    const result = desktopPath(undefined, {
      platform: 'win32',
      env: { Path: 'C:\\Windows\\System32;C:\\tools' },
    })
    expect(result.split(';').slice(0, 2)).toEqual(['C:\\Windows\\System32', 'C:\\tools'])
  })

  it.skipIf(process.platform !== 'win32')(
    'normalizes Windows PATH aliases and preserves an explicit override',
    () => {
      const env = { Path: 'C:\\inherited', PATH: 'C:\\override' }
      applyDesktopPath(env)
      expect(Object.keys(env).filter((key) => key.toLowerCase() === 'path')).toEqual(['PATH'])
      expect(env.PATH.split(';')[0]).toBe('C:\\override')
    },
  )

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

  it('finds a fresh standalone Codex install before Windows refreshes the process PATH', () => {
    const local = 'C:\\Users\\tester\\AppData\\Local'
    const result = desktopPath('C:\\Windows\\System32', {
      platform: 'win32',
      home: 'C:\\Users\\tester',
      env: { LOCALAPPDATA: local },
    })
    expect(result.split(';')).toContain(
      path.win32.join(local, 'Programs', 'OpenAI', 'Codex', 'bin'),
    )
  })

  it.each([
    ['darwin', '/usr/bin', '/Users/tester', path.posix],
    ['win32', 'C:\\Windows\\System32', 'C:\\Users\\tester', path.win32],
  ] as const)(
    'finds the official Grok install on %s, which a stale PATH misses',
    (platform, current, home, flavor) => {
      const result = desktopPath(current, { platform, home, env: {} })
      expect(result.split(flavor.delimiter)).toContain(flavor.join(home, '.grok', 'bin'))
    },
  )

  it('finds a fresh Antigravity install before Windows refreshes the process PATH', () => {
    const local = 'C:\\Users\\tester\\AppData\\Local'
    const result = desktopPath('C:\\Windows\\System32', {
      platform: 'win32',
      home: 'C:\\Users\\tester',
      env: { LOCALAPPDATA: local },
    })
    expect(result.split(';')).toContain(path.win32.join(local, 'agy', 'bin'))
  })

  it('finds a winget-installed CLI before Windows refreshes the process PATH', () => {
    const local = 'C:\\Users\\tester\\AppData\\Local'
    const result = desktopPath('C:\\Windows\\System32', {
      platform: 'win32',
      home: 'C:\\Users\\tester',
      env: { LOCALAPPDATA: local },
    })
    expect(result.split(';')).toContain(path.win32.join(local, 'Microsoft', 'WinGet', 'Links'))
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

describe('registry PATH', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }
  const options = { platform: 'win32', home: 'C:\\Users\\tester', env } as const

  it('reads an expandable PATH that reg.exe wrapped over several lines', () => {
    const value = '%LOCALAPPDATA%\\agy\\bin;C:\\Users\\Jürgen\\tools;C:\\Program Files\\Vendor CLI'
    expect(parseRegistryPath(exportedKey(value))).toBe(value)
  })

  it('reads a plain string PATH and undoes its escapes', () => {
    expect(parseRegistryPath(exportedKey('C:\\tools;D:\\a "b"', 'string'))).toBe(
      'C:\\tools;D:\\a "b"',
    )
  })

  it('reports a key without a Path value as having none', () => {
    expect(parseRegistryPath(exportedKey(undefined))).toBeUndefined()
  })

  it('adds a folder an installer put on the PATH after launch, after the inherited PATH', async () => {
    const run = registry({
      machine: 'C:\\Windows\\System32;C:\\machine-tools',
      user: '%LOCALAPPDATA%\\fresh-cli\\bin;%NOT_SET%\\bin',
    })
    await refreshWindowsPath({ platform: 'win32', env, run })
    const entries = desktopPath('C:\\Windows\\System32', options).split(';')

    expect(entries[0]).toBe('C:\\Windows\\System32')
    expect(entries.filter((entry) => entry === 'C:\\Windows\\System32')).toHaveLength(1)
    const machine = entries.indexOf('C:\\machine-tools')
    const user = entries.indexOf('C:\\Users\\tester\\AppData\\Local\\fresh-cli\\bin')
    expect(machine).toBeGreaterThan(0)
    expect(user).toBeGreaterThan(machine)
    expect(entries.some((entry) => entry.includes('%'))).toBe(false)
  })

  it('keeps the last answer when reg.exe fails, and never throws', async () => {
    await refreshWindowsPath({ platform: 'win32', env, run: registry({ user: 'C:\\fresh' }) })
    expireWindowsPath()
    const failing = vi.fn<RegistryExport>(async () => {
      throw new Error('reg.exe timed out')
    })
    await expect(refreshWindowsPath({ platform: 'win32', env, run: failing })).resolves.toBe(
      undefined,
    )
    expect(failing).toHaveBeenCalledTimes(2)
    expect(desktopPath('C:\\Windows', options).split(';')).toContain('C:\\fresh')
  })

  it('reads the registry at most once per burst of scans', async () => {
    const run = registry({ user: 'C:\\fresh' })
    await Promise.all([
      refreshWindowsPath({ platform: 'win32', env, run }),
      refreshWindowsPath({ platform: 'win32', env, run }),
    ])
    await refreshWindowsPath({ platform: 'win32', env, run })
    expect(run).toHaveBeenCalledTimes(2)
    expireWindowsPath()
    await refreshWindowsPath({ platform: 'win32', env, run })
    expect(run).toHaveBeenCalledTimes(4)
  })

  it('leaves other platforms alone', async () => {
    const run = registry({ user: 'C:\\fresh' })
    await refreshWindowsPath({ platform: 'darwin', env, run })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('isInstalled', () => {
  it.skipIf(process.platform !== 'win32')(
    'finds and launches a program from an Explorer-style Path environment',
    async () => {
      const home = mkdtempSync(path.join(os.tmpdir(), 'harness-windows-path-'))
      roots.push(home)
      const command = `harness-path-proof-${process.pid}`
      writeFileSync(path.join(home, `${command}.cmd`), '@echo off\r\necho WINDOWS_PATH_OK\r\n')
      const env = { ...process.env }
      for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
      env.Path = `${home};${path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')}`
      await expect(isInstalled(command, env)).resolves.toBe(true)
      const child = spawnCli(command, [], { env })
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += String(chunk)
      })
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', resolve)
      })
      expect(code).toBe(0)
      expect(output.trim()).toBe('WINDOWS_PATH_OK')
    },
  )
  it.skipIf(process.platform !== 'win32')(
    'does not count a same-named shim in the working directory',
    async () => {
      // where.exe searched the working directory first, so detection could
      // report a CLI that spawnCli would never launch from there.
      const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-cwd-shim-'))
      roots.push(workspace)
      const command = `harness-cwd-only-${process.pid}`
      writeFileSync(path.join(workspace, `${command}.cmd`), '@echo off\r\nexit /b 0\r\n')
      const previous = process.cwd()
      process.chdir(workspace)
      try {
        await expect(isInstalled(command)).resolves.toBe(false)
      } finally {
        process.chdir(previous)
      }
    },
  )

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

  it.skipIf(process.platform === 'win32')(
    'does not take a directory named like the command for an installed CLI',
    async () => {
      const home = mkdtempSync(path.join(os.tmpdir(), 'harness-directory-cli-'))
      roots.push(home)
      const command = `harness-directory-cli-${process.pid}`
      mkdirSync(path.join(home, 'bin', command), { recursive: true })
      const env: NodeJS.ProcessEnv = { HOME: home, PATH: path.join(home, 'bin') }

      await expect(isInstalled(command, env)).resolves.toBe(false)
    },
  )
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
