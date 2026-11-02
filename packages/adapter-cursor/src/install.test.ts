import { describe, expect, it } from 'vitest'
import { cursorInstallCommand } from './install.js'

describe('Cursor installer', () => {
  it('runs the Windows installer from cursor.com, downloaded before it runs', () => {
    const command = cursorInstallCommand('win32')
    expect(command).toMatch(/^powershell\.exe .* -EncodedCommand [A-Za-z0-9+/=]+$/)
    const script = Buffer.from(command.split(' ').at(-1)!, 'base64').toString('utf16le')
    // The query string stays inside the quoted URL.
    expect(script).toContain(
      "$installer = Invoke-RestMethod -Uri 'https://cursor.com/install?win32=true'",
    )
    expect(script).toContain('Invoke-Expression $installer')
  })

  it.each(['darwin', 'linux'] as const)(
    'pipes the installer from cursor.com to bash on %s',
    (platform) => {
      const command = cursorInstallCommand(platform)
      expect(command).toContain(
        'installer=$(curl -fsSL --connect-timeout 15 --max-time 60 "https://cursor.com/install") && printf',
      )
      expect(command).toMatch(/\| bash'$/)
    },
  )
})
