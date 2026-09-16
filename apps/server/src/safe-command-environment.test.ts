import { chmodSync, lstatSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { commandRuntimeDirectory, safeCommandEnvironment } from './safe-command-environment.js'

const scratch: string[] = []

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** Isolated runtime path; never the shared live directory. */
function isolatedRuntime(): string {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'tastecode-env-test-'))
  scratch.push(parent)
  return path.join(parent, 'runtime')
}

describe('safe command environment', () => {
  it('isolates a workspace from user-level tool config', () => {
    const runtime = isolatedRuntime()
    const env = safeCommandEnvironment('/repo', runtime)

    expect(env['HOME']).toBe('/repo')
    expect(env['USERPROFILE']).toBe('/repo')
    expect(env['GIT_CONFIG_NOSYSTEM']).toBe('1')
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0')
    expect(env['CI']).toBe('1')
    expect(env['TEMP']).toBe(runtime)
    expect(env['TMP']).toBe(runtime)
    expect(env['APPDATA']).toBe(runtime)
    expect(env['NoDefaultCurrentDirectoryInExePath']).toBe('1')
  })

  it('uses a per-user runtime directory instead of one shared name', () => {
    expect(commandRuntimeDirectory()).toBe(commandRuntimeDirectory())
    if (process.platform === 'win32' || typeof process.getuid !== 'function') return
    expect(path.basename(commandRuntimeDirectory())).toBe(
      `tastecode-project-tools-${process.getuid()}`,
    )
  })

  it('creates the runtime directory with user-only access', () => {
    if (process.platform === 'win32') return
    const runtime = isolatedRuntime()

    safeCommandEnvironment('/repo', runtime)

    expect(statSync(runtime).mode & 0o777).toBe(0o700)
  })

  it('tightens a runtime directory left readable by an older build', () => {
    if (process.platform === 'win32') return
    const runtime = isolatedRuntime()
    safeCommandEnvironment('/repo', runtime)
    chmodSync(runtime, 0o755)

    safeCommandEnvironment('/repo', runtime)

    expect(statSync(runtime).mode & 0o777).toBe(0o700)
  })

  it('refuses a symlinked runtime directory without touching its target', () => {
    if (process.platform === 'win32') return
    const parent = mkdtempSync(path.join(os.tmpdir(), 'tastecode-env-link-test-'))
    scratch.push(parent)
    const target = path.join(parent, 'target')
    const link = path.join(parent, 'runtime')
    safeCommandEnvironment('/repo', target)
    chmodSync(target, 0o755)
    symlinkSync(target, link)

    expect(() => safeCommandEnvironment('/repo', link)).toThrow(/symlink/)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(statSync(target).mode & 0o777).toBe(0o755)
  })
})
