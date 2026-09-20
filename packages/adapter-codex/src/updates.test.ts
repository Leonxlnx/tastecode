import path from 'node:path'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '@harness/proc/cli'
import { cliPath, latestBrewVersion, latestNpmVersion } from '@harness/proc/updates'
import { CODEX_UPDATES, codexInstallCommand } from './updates.js'

vi.mock('@harness/proc/cli', () => ({ runCli: vi.fn() }))
vi.mock('@harness/proc/updates', () => ({
  cliPath: vi.fn(),
  latestBrewVersion: vi.fn(),
  latestNpmVersion: vi.fn(),
}))
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(latestNpmVersion).mockResolvedValue('0.153.4')
  vi.mocked(latestBrewVersion).mockResolvedValue('0.153.3')
})

describe('Codex update source', () => {
  it.skipIf(process.platform !== 'win32')(
    'runs the Windows installer without npm and propagates download failures',
    async () => {
      let status = 200
      const server = createServer((_request, response) => {
        response.writeHead(status, { 'Content-Type': 'text/plain' })
        response.end(
          `if (Get-Command npm -ErrorAction SilentlyContinue) { throw 'npm should be absent' }; if ($env:CODEX_NON_INTERACTIVE -ne '1') { throw 'Installer must not wait for input' }; Write-Output 'standalone-install-test-ok'`,
        )
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      try {
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Missing installer fixture')
        const original = codexInstallCommand('win32')
        const script = Buffer.from(original.split(' ').at(-1)!, 'base64')
          .toString('utf16le')
          .replace(
            'https://chatgpt.com/codex/install.ps1',
            `http://127.0.0.1:${address.port}/install.ps1`,
          )
        const command = original.replace(/\S+$/, Buffer.from(script, 'utf16le').toString('base64'))
        const env = { ...process.env }
        for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
        const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
        env.PATH = [system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(path.delimiter)
        const run = () =>
          promisify(execFile)(path.join(system, 'cmd.exe'), ['/d', '/s', '/c', command], {
            env,
            windowsHide: true,
            timeout: 15_000,
          })
        expect((await run()).stdout).toContain('standalone-install-test-ok')
        status = 500
        await expect(run()).rejects.toMatchObject({ code: 1 })
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
    30_000,
  )

  it.each(['darwin', 'linux', 'win32'] as const)(
    'installs on %s without requiring a developer package manager',
    (platform) => {
      const command = codexInstallCommand(platform)
      expect(command).not.toMatch(/npm|brew|node /)
      const script =
        platform === 'win32'
          ? Buffer.from(command.split(' ').at(-1)!, 'base64').toString('utf16le')
          : command
      expect(script).toContain('CODEX_NON_INTERACTIVE')
      expect(script).toContain(
        `https://chatgpt.com/codex/install.${platform === 'win32' ? 'ps1' : 'sh'}`,
      )
      if (platform !== 'win32') expect(command).toContain(') && printf')
      else expect(script).toContain("$ErrorActionPreference = 'Stop'")
    },
  )

  it('uses the native updater only when the installed binary advertises it', async () => {
    vi.mocked(cliPath).mockResolvedValue(path.join('local', 'standalone', 'codex'))
    vi.mocked(runCli)
      .mockResolvedValueOnce({ code: 0, stdout: 'Usage: codex update [OPTIONS]' })
      .mockResolvedValueOnce({ code: 2, stdout: '' })
    expect((await CODEX_UPDATES.check('0.152.0')).command).toBe('codex update')
    expect((await CODEX_UPDATES.check('0.100.0')).command).toBeUndefined()
    expect(runCli).toHaveBeenCalledWith('codex', ['update', '--help'])
  })

  it('keeps npm alpha installations on their release channel', async () => {
    vi.mocked(cliPath).mockResolvedValue(
      path.join('prefix', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    )
    expect((await CODEX_UPDATES.check('0.154.0-alpha.1')).command).toBe(
      'npm install -g @openai/codex@alpha',
    )
    expect(latestNpmVersion).toHaveBeenCalledWith('@openai/codex', 'alpha')
    expect(runCli).not.toHaveBeenCalled()
  })

  it('updates the Homebrew cask through Homebrew', async () => {
    vi.mocked(cliPath).mockResolvedValue(
      path.join('prefix', 'Caskroom', 'codex', '0.152.0', 'codex'),
    )
    expect((await CODEX_UPDATES.check('0.152.0')).command).toBe('brew upgrade --cask codex')
    expect(latestBrewVersion).toHaveBeenCalledWith('codex')
    expect(latestNpmVersion).not.toHaveBeenCalled()
  })

  it.each([
    ['.pnpm', 'pnpm add -g'],
    ['.bun', 'bun add -g'],
    ['yarn', 'yarn global add'],
  ])('keeps %s installations in their package manager', async (manager, command) => {
    vi.mocked(cliPath).mockResolvedValue(
      path.join('prefix', manager, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    )
    expect((await CODEX_UPDATES.check('0.152.0')).command).toBe(`${command} @openai/codex@latest`)
  })
})
