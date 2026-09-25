import { describe, expect, it } from 'vitest'
import { cursorInstallCommand } from './updates.js'

describe('Cursor install command', () => {
  it.each(['darwin', 'linux'] as const)(
    'fetches the official installer before running it on %s',
    (platform) => {
      const command = cursorInstallCommand(platform)
      expect(command).toContain('https://cursor.com/install')
      expect(command).toContain(') && printf')
      expect(command).toContain('/usr/bin/env bash')
    },
  )

  it('uses the official Windows installer without an interactive prompt', () => {
    const command = cursorInstallCommand('win32')
    const script = Buffer.from(command.split(' ').at(-1)!, 'base64').toString('utf16le')
    expect(script).toContain("$ErrorActionPreference = 'Stop'")
    expect(script).toContain('https://cursor.com/install?win32=true')
  })
})
