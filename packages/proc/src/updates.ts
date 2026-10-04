import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { desktopPath } from './desktop-path.js'

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

/** Resolve the binary actually used by the desktop, including Windows package-manager shims. */
export async function cliPath(command: string): Promise<string | undefined> {
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const directory of desktopPath(process.env['PATH'] ?? '').split(path.delimiter)) {
    for (const extension of extensions) {
      try {
        return await realpath(path.join(directory, command + extension))
      } catch {
        // Continue in PATH order.
      }
    }
  }
  return undefined
}
