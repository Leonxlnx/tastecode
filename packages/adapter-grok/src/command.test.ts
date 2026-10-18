import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { grokCommand } from './adapter.js'

const windows = process.platform === 'win32'

describe('Grok binary resolution', () => {
  const originalPath = process.env.PATH
  let folder: string | undefined

  afterEach(() => {
    process.env.PATH = originalPath
    if (folder) rmSync(folder, { recursive: true, force: true })
    folder = undefined
  })

  function pathWith(file: string): string {
    folder = mkdtempSync(path.join(tmpdir(), 'grok-command-'))
    const target = path.join(folder, file)
    // Only located, never started.
    writeFileSync(target, '', { mode: 0o755 })
    process.env.PATH = folder
    return target
  }

  it('starts the grok the PATH finds first, the one detection reports', () => {
    const onPath = pathWith(windows ? 'grok.exe' : 'grok')
    expect(grokCommand()).toBe(onPath)
  })

  it.runIf(windows)('passes over a .cmd shim that a native spawn cannot start', () => {
    const shim = pathWith('grok.cmd')
    expect(grokCommand()).not.toBe(shim)
    expect(grokCommand()).not.toMatch(/\.cmd$/i)
  })
})
