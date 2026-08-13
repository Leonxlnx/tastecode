import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { revealablePath } from './reveal-path.js'

describe('revealablePath', () => {
  it('accepts absolute paths and rejects renderer-controlled relative paths', () => {
    const absolute = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project'
    expect(revealablePath(absolute)).toBe(absolute)
    expect(() => revealablePath('../project')).toThrow(/absolute/)
    expect(() => revealablePath(`${absolute}\0.exe`)).toThrow(/absolute/)
  })

  it('expands a stored home-relative project path', () => {
    expect(revealablePath('~/Developer/harness')).toBe(
      path.join(os.homedir(), 'Developer', 'harness'),
    )
  })
})
