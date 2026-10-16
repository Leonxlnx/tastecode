import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findCursorWindowsLauncher } from './launch.js'

describe('Cursor Windows launcher', () => {
  let localAppData = ''

  beforeEach(() => {
    localAppData = mkdtempSync(path.join(tmpdir(), 'cursor-launch-'))
  })
  afterEach(() => {
    rmSync(localAppData, { recursive: true, force: true })
  })

  const install = (version: string, files = ['node.exe', 'index.js']) => {
    const directory = path.join(localAppData, 'cursor-agent', 'versions', version)
    mkdirSync(directory, { recursive: true })
    for (const file of files) writeFileSync(path.join(directory, file), '')
    return directory
  }

  it('picks the newest complete version the way cursor-agent.ps1 does', () => {
    // 2026.7.9 sorts after 2026.07.23 as text; the shim compares dates.
    install('2026.7.9-0a1b2c')
    install('2026.07.23-e383d2b')
    const newest = install('2026.07.23-14-05-09-ff00aa')
    install('2026.08.01-dead01', ['index.js'])
    install('latest')

    expect(findCursorWindowsLauncher({ LOCALAPPDATA: localAppData })).toEqual({
      node: path.join(newest, 'node.exe'),
      script: path.join(newest, 'index.js'),
      env: {
        CURSOR_INVOKED_AS: 'cursor-agent.cmd',
        NODE_COMPILE_CACHE: path.join(localAppData, 'cursor-compile-cache'),
      },
    })
  })

  it('finds nothing when cursor-agent is not installed in the standard place', () => {
    expect(findCursorWindowsLauncher({})).toBeUndefined()
    expect(findCursorWindowsLauncher({ LOCALAPPDATA: localAppData })).toBeUndefined()
  })
})
