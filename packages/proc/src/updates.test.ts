import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cliVersion,
  isNewerVersion,
  latestBrewVersion,
  latestNpmVersion,
  vendorInstallCommand,
} from './updates.js'

afterEach(() => vi.unstubAllGlobals())

describe('CLI release versions', () => {
  it.each([
    ['codex-cli 0.9.0', '0.10.0', true],
    ['2.1.226 (Claude Code)', '2.1.263', true],
    ['v1.0.13', '1.0.13', false],
    ['1.1.0', '1.0.99', false],
    ['1.0.0-alpha.9', '1.0.0-alpha.10', true],
    ['1.0.0-alpha.10', '1.0.0-alpha.9', false],
    ['1.0.0-alpha.1', '1.0.0', true],
    ['1.0.0', '1.0.0-alpha.1', false],
    ['1.0.0+build', '1.0.0+new-build', false],
    ['unknown', '2.0.0', false],
    ['1.0.0', 'bad-release', false],
  ])('compares %s against %s', (current, latest, expected) => {
    expect(isNewerVersion(current, latest)).toBe(expected)
  })

  it('does not parse version-shaped command text', () => {
    expect(cliVersion('1.0.0; echo bad')).toBeUndefined()
  })

  it('uses a fixed release host and bounds the network check', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ version: '2.1.236' }))
    vi.stubGlobal('fetch', fetch)
    await expect(latestNpmVersion('@anthropic-ai/claude-code', 'stable')).resolves.toBe('2.1.236')
    expect(fetch).toHaveBeenCalledWith(
      'https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code/stable',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('refuses failed and malformed release responses', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ version: '; bad' }))
    vi.stubGlobal('fetch', fetch)
    await expect(latestNpmVersion('@openai/codex')).rejects.toThrow('unavailable')
    await expect(latestNpmVersion('@openai/codex')).rejects.toThrow('invalid version')
  })

  it('uses the release actually available in Homebrew for a cask install', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ version: '0.153.3' }))
    vi.stubGlobal('fetch', fetch)
    await expect(latestBrewVersion('codex')).resolves.toBe('0.153.3')
    expect(fetch).toHaveBeenCalledWith(
      'https://formulae.brew.sh/api/cask/codex.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })
})

const INSTALLER = {
  windows: 'https://vendor.example/install.ps1',
  posix: 'https://vendor.example/install.sh',
}

/** The same command, fetching from a local stand-in for the vendor host. */
function withInstallerUrl(command: string, platform: NodeJS.Platform, url: string): string {
  if (platform !== 'win32') return command.replace(INSTALLER.posix, url)
  const script = Buffer.from(command.split(' ').at(-1)!, 'base64')
    .toString('utf16le')
    .replace(INSTALLER.windows, url)
  return command.replace(/\S+$/, Buffer.from(script, 'utf16le').toString('base64'))
}

describe('vendor installers', () => {
  it('fetches the whole PowerShell script before running it, as `irm | iex` would', () => {
    const command = vendorInstallCommand(INSTALLER, 'win32')
    expect(command).toMatch(
      /^powershell\.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/,
    )
    const script = Buffer.from(command.split(' ').at(-1)!, 'base64').toString('utf16le')
    expect(script).toBe(
      "$ErrorActionPreference = 'Stop'; $installer = Invoke-RestMethod -Uri 'https://vendor.example/install.ps1'; $ErrorActionPreference = 'Continue'; Invoke-Expression $installer",
    )
  })

  it.each(['darwin', 'linux'] as const)(
    'pipes the fetched bash script to bash on %s',
    (platform) => {
      expect(vendorInstallCommand(INSTALLER, platform)).toBe(
        `/bin/sh -c 'installer=$(curl -fsSL --connect-timeout 15 --max-time 60 "https://vendor.example/install.sh") && printf "%s" "$installer" | bash'`,
      )
    },
  )

  it.each([
    "https://vendor.example/install'; calc; '",
    'https://vendor.example/$(id)',
    'https://vendor.example/install "x"',
    'http://vendor.example/install.sh',
    'file:///tmp/install.sh',
  ])('refuses %s, which could break out of the quoted command', (url) => {
    expect(() => vendorInstallCommand({ windows: url, posix: url }, 'win32')).toThrow(
      'Not an installer URL',
    )
    expect(() => vendorInstallCommand({ windows: url, posix: url }, 'linux')).toThrow(
      'Not an installer URL',
    )
  })

  it('keeps a query string inside the quotes', () => {
    const query = { windows: 'https://vendor.example/install?win32=true', posix: INSTALLER.posix }
    const script = Buffer.from(
      vendorInstallCommand(query, 'win32').split(' ').at(-1)!,
      'base64',
    ).toString('utf16le')
    expect(script).toContain("-Uri 'https://vendor.example/install?win32=true'")
  })

  const platform = process.platform
  it.skipIf(!['win32', 'darwin', 'linux'].includes(platform))(
    'runs the downloaded script and reports download and script failures as exit codes',
    async () => {
      const windows = platform === 'win32'
      const scripts: Record<string, string> = windows
        ? {
            '/ok': `if ($ErrorActionPreference -ne 'Continue') { throw 'strict' }; Write-Output 'vendor-installer-ran'`,
            '/exit': `Write-Output 'vendor-installer-started'; exit 7`,
          }
        : {
            '/ok': `[[ -n "$BASH_VERSION" ]] && echo vendor-installer-ran`,
            '/exit': `echo vendor-installer-started; exit 7`,
          }
      const server = createServer((request, response) => {
        const body = scripts[request.url ?? '']
        // Anthropic serves its PowerShell installer as application/octet-stream.
        response.writeHead(body ? 200 : 500, { 'Content-Type': 'application/octet-stream' })
        response.end(body ?? 'echo vendor-error-page-ran')
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      try {
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Missing installer fixture')
        const run = (route: string) => {
          const command = withInstallerUrl(
            vendorInstallCommand(INSTALLER, platform),
            platform,
            `http://127.0.0.1:${address.port}${route}`,
          )
          if (!windows) return promisify(execFile)('/bin/sh', ['-c', command], { timeout: 15_000 })
          const system = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')
          // What the server's terminal does: cmd.exe /d /s /c <command>.
          return promisify(execFile)(path.join(system, 'cmd.exe'), ['/d', '/s', '/c', command], {
            windowsHide: true,
            timeout: 15_000,
          })
        }
        expect((await run('/ok')).stdout).toContain('vendor-installer-ran')
        const failed = await run('/missing').then(
          () => undefined,
          (error: { code?: number; stdout?: string }) => error,
        )
        expect(failed?.code).not.toBe(0)
        expect(failed?.stdout ?? '').not.toContain('vendor-error-page-ran')
        await expect(run('/exit')).rejects.toMatchObject({ code: 7 })
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
    45_000,
  )
})
