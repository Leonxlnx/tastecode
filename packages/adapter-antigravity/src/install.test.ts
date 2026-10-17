import { describe, expect, it } from 'vitest'
import { antigravityInstallCommand } from './install.js'

describe('Antigravity installer', () => {
  it('runs install.ps1 from antigravity.google on Windows, downloaded before it runs', () => {
    const command = antigravityInstallCommand('win32')
    expect(command).toMatch(/^powershell\.exe .* -EncodedCommand [A-Za-z0-9+/=]+$/)
    const script = Buffer.from(command.split(' ').at(-1)!, 'base64').toString('utf16le')
    expect(script).toContain(
      "$installer = Invoke-RestMethod -Uri 'https://antigravity.google/cli/install.ps1'",
    )
    expect(script).toContain('Invoke-Expression $installer')
  })

  it.each(['darwin', 'linux'] as const)(
    'pipes install.sh from antigravity.google to bash on %s',
    (platform) => {
      const command = antigravityInstallCommand(platform)
      expect(command).toContain(
        'installer=$(curl -fsSL --connect-timeout 15 --max-time 60 "https://antigravity.google/cli/install.sh") && printf',
      )
      expect(command).toMatch(/\| bash'$/)
    },
  )
})
