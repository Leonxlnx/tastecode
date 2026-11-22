import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { desktopPath } from './desktop-path.js'
import { commandOverride, locateCommand } from './cli.js'

export type CliUpdateSource = {
  command: string
  url: string
  check(currentVersion: string): Promise<{ latestVersion: string; command?: string | undefined }>
}

const VERSION = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?(?=\s|$)/

export function cliVersion(value: string): string | undefined {
  return VERSION.exec(value)?.[1]
}

/** Compare numeric release parts and SemVer prereleases, never display strings. */
export function isNewerVersion(current: string, latest: string): boolean {
  const a = cliVersion(current)
  const b = cliVersion(latest)
  if (!a || !b) return false
  const parts = (value: string) => {
    const [release, ...pre] = value.split('-')
    return { release: release!.split('.').map(Number), pre: pre.join('-') }
  }
  const left = parts(a)
  const right = parts(b)
  for (let i = 0; i < 3; i++) {
    if (left.release[i] !== right.release[i]) return right.release[i]! > left.release[i]!
  }
  if (!left.pre || !right.pre) return Boolean(left.pre && !right.pre)
  const l = left.pre.split('.')
  const r = right.pre.split('.')
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    if (l[i] === r[i]) continue
    if (l[i] === undefined) return true
    if (r[i] === undefined) return false
    const ln = /^\d+$/.test(l[i]!)
    const rn = /^\d+$/.test(r[i]!)
    if (ln !== rn) return ln
    return ln ? Number(r[i]) > Number(l[i]) : r[i]! > l[i]!
  }
  return false
}

/** Where a vendor publishes its own install scripts, as its docs give them. */
export type VendorInstaller = {
  /** The PowerShell script the docs run as `irm <url> | iex`. */
  windows: string
  /** The bash script the docs run as `curl -fsSL <url> | bash`. */
  posix: string
}

/**
 * The command that runs a vendor's official installer the way its docs do,
 * except that the script is downloaded completely before any of it runs: a
 * failed or cut-off download exits non-zero instead of running half a script
 * or passing for a finished install. Only the download is held to strict
 * errors on Windows; the script itself then runs under PowerShell's defaults,
 * as it would under `irm | iex`. The server runs the result through cmd.exe
 * on Windows and through the user's shell elsewhere.
 */
export function vendorInstallCommand(
  installer: VendorInstaller,
  platform: NodeJS.Platform = process.platform,
): string {
  const url = platform === 'win32' ? installer.windows : installer.posix
  // The URL is spliced into quoted shell text, so it may not carry any quoting.
  if (!/^https:\/\/[\w.-]+(?:\/[\w./?=&%-]*)?$/.test(url)) {
    throw new Error(`Not an installer URL: ${url}`)
  }
  if (platform === 'win32') {
    const script = `$ErrorActionPreference = 'Stop'; $installer = Invoke-RestMethod -Uri '${url}'; $ErrorActionPreference = 'Continue'; Invoke-Expression $installer`
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
  }
  // The vendors' scripts use bash syntax, so they run in bash as documented.
  return `/bin/sh -c 'installer=$(curl -fsSL --connect-timeout 15 --max-time 60 "${url}") && printf "%s" "$installer" | bash'`
}

export async function latestNpmVersion(packageName: string, tag = 'latest'): Promise<string> {
  return releaseVersion(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(tag)}`,
  )
}

export async function latestBrewVersion(cask: string): Promise<string> {
  return releaseVersion(`https://formulae.brew.sh/api/cask/${encodeURIComponent(cask)}.json`)
}

async function releaseVersion(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5_000),
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error('The release service is unavailable. Try again later.')
  const data: unknown = await response.json()
  const version =
    data && typeof data === 'object' && 'version' in data && typeof data.version === 'string'
      ? cliVersion(data.version)
      : undefined
  if (!version) throw new Error('The release service returned an invalid version.')
  return version
}

/**
 * Resolve the binary actually used by the desktop, including Windows package-manager shims.
 * Callers read the install method from this path, as a POSIX global install's symlink
 * resolves into `node_modules`.
 */
export async function cliPath(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const override = commandOverride(command)
  if (override) return realpath(override).catch(() => undefined)
  if (process.platform === 'win32') return windowsCliPath(command, environment)
  for (const directory of desktopPath(environment['PATH'] ?? '').split(path.delimiter)) {
    try {
      return await realpath(path.join(directory, command))
    } catch {
      // Continue in PATH order.
    }
  }
  return undefined
}

/** The first quoted `%dp0%`-relative path into `node_modules` that a cmd shim starts. */
const NPM_SHIM_TARGET = /"%~?dp0%?\\([^"%\r\n]*node_modules\\[^"%\r\n]+)"/i

/**
 * On Windows a package manager's global entry is a shim file, not a symlink, so its own
 * path names only the bin folder (`%APPDATA%\npm\claude`) and says nothing about how the
 * CLI was installed. The command is found as the launcher finds it (PATH × PATHEXT, so
 * `claude.cmd` rather than the extension-less sh shim beside it), and an npm `.cmd` shim
 * is followed to the file it starts inside `node_modules`.
 */
async function windowsCliPath(
  command: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const located = await locateCommand(command, environment)
  if (!located) return undefined
  if (/\.cmd$/i.test(located)) {
    const text = await readFile(located, 'utf8').catch(() => '')
    const target = NPM_SHIM_TARGET.exec(text)?.[1]
    const resolved = target
      ? await realpath(path.win32.join(path.win32.dirname(located), target)).catch(() => undefined)
      : undefined
    if (resolved) return resolved
  }
  return realpath(located).catch(() => undefined)
}
