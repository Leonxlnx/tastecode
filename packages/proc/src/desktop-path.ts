import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export type DesktopPathOptions = {
  platform?: NodeJS.Platform
  home?: string
  env?: NodeJS.ProcessEnv
}

/**
 * PATH a GUI-launched desktop process can actually use.
 *
 * Finder, Explorer and Electron do not load a login shell, so user CLI shims
 * in `~/.local/bin`, Homebrew and npm global bins are missing even when the
 * same machine's terminal has them. Provider detection, `spawnCli` and the
 * PTY all read this PATH.
 */
export function desktopPath(
  current: string | undefined = undefined,
  options: DesktopPathOptions = {},
): string {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  // A copied Windows environment is case-sensitive JavaScript even though the OS is not.
  current ??=
    platform === 'win32'
      ? (Object.entries(env).findLast(([key]) => key.toLowerCase() === 'path')?.[1] ?? '')
      : (env.PATH ?? '')
  const home = options.home ?? homedir(platform, env)
  const { join, delimiter } = platform === 'win32' ? path.win32 : path.posix
  const seen = new Set<string>()
  const entries = [...current.split(delimiter), ...extraDirectories(platform, home, env, join)]
    .filter((entry): entry is string => Boolean(entry))
    .filter((entry) => {
      const key = platform === 'win32' ? entry.toLowerCase() : entry
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  return entries.join(delimiter)
}

/** Put the desktop-safe PATH on an environment object, defaulting to this process. */
export function applyDesktopPath(env: NodeJS.ProcessEnv = process.env): string {
  const next = desktopPath(undefined, { env })
  if (process.platform === 'win32') {
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  }
  env.PATH = next
  return next
}

/** Exports one registry key to a .reg file, the way `reg.exe export` does. */
export type RegistryExport = (key: string, file: string) => Promise<void>

const ENVIRONMENT_KEYS = [
  // Windows builds a new process's PATH as the machine PATH, then the user's.
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
]
const REGISTRY_PATH_TTL_MS = 10_000
const REGISTRY_EXPORT_TIMEOUT_MS = 2_000

let registryPath: string[] = []
let registryRead: { at: number; done: Promise<void> } | undefined

const exportRegistryKey: RegistryExport = (key, file) =>
  new Promise((resolve, reject) => {
    // The full path: a reg.exe earlier on PATH must not answer instead.
    const reg = path.win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'reg.exe')
    execFile(
      reg,
      ['export', key, file, '/y'],
      { windowsHide: true, timeout: REGISTRY_EXPORT_TIMEOUT_MS },
      (error) => (error ? reject(error) : resolve()),
    )
  })

/**
 * Re-read the PATH Windows would give a process started now.
 *
 * The desktop's PATH is fixed when it launches, and an installer that runs
 * later (agy, Grok, Cursor, winget) adds its folder to the PATH in the
 * registry, so a fresh install stayed invisible until a restart. desktopPath()
 * appends what this finds after the inherited PATH. `reg.exe export` writes
 * UTF-16, which keeps non-ASCII folder names that `reg query` would garble.
 * Runs at most every 10 s, never throws, and keeps the last answer on failure.
 */
export function refreshWindowsPath(
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: RegistryExport } = {},
): Promise<void> {
  if ((options.platform ?? process.platform) !== 'win32') return Promise.resolve()
  if (registryRead && Date.now() - registryRead.at < REGISTRY_PATH_TTL_MS) return registryRead.done
  const done = readRegistryPath(options.run ?? exportRegistryKey, options.env ?? process.env).then(
    (entries) => {
      if (entries) registryPath = entries
    },
    () => undefined,
  )
  registryRead = { at: Date.now(), done }
  return done
}

/** Make the next refreshWindowsPath() read the registry again. */
export function expireWindowsPath(): void {
  registryRead = undefined
}

/** Forget what the registry said; tests only. */
export function resetWindowsPathForTests(): void {
  registryRead = undefined
  registryPath = []
}

async function readRegistryPath(
  run: RegistryExport,
  env: NodeJS.ProcessEnv,
): Promise<string[] | undefined> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'tastecode-path-'))
  try {
    const values = await Promise.all(
      ENVIRONMENT_KEYS.map(async (key, index) => {
        const file = path.join(folder, `${index}.reg`)
        try {
          await run(key, file)
          return parseRegistryPath(await readFile(file))
        } catch {
          return undefined
        }
      }),
    )
    if (values.every((value) => value === undefined)) return undefined
    return values
      .flatMap((value) => (value ?? '').split(';'))
      .map((entry) => expandVariables(entry.trim().replace(/^"|"$/g, ''), env))
      .filter((entry) => entry !== '' && !entry.includes('%'))
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** The `Path` value of one exported Environment key, as text. */
export function parseRegistryPath(content: Buffer): string | undefined {
  const utf16 = content[0] === 0xff && content[1] === 0xfe
  const text = content.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '')
  // A long hex value wraps: a line ends in `,\` and the next one is indented.
  const lines = text.replace(/,\\\r?\n\s*/g, ',').split(/\r?\n/)
  const line = lines.find((entry) => /^"path"=/i.test(entry))
  if (!line) return undefined
  const value = line.slice(line.indexOf('=') + 1)
  // REG_SZ: a quoted string with `\\` and `\"` escapes.
  if (value.startsWith('"')) return value.slice(1, -1).replace(/\\(["\\])/g, '$1')
  // REG_EXPAND_SZ: hex(2) bytes of NUL-terminated UTF-16LE.
  const hex = /^hex\(2\):([0-9a-f,]*)$/i.exec(value)?.[1]
  if (hex === undefined) return undefined
  const bytes = hex
    .split(',')
    .filter(Boolean)
    .map((byte) => Number.parseInt(byte, 16))
  return Buffer.from(bytes).toString('utf16le').replace(/\0+$/, '')
}

function expandVariables(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => {
    const match = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())
    return match?.[1] ?? whole
  })
}

function homedir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32') return env.USERPROFILE ?? env.HOME ?? os.homedir()
  return env.HOME ?? os.homedir()
}

function extraDirectories(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
  join: (...parts: string[]) => string,
): Array<string | undefined> {
  const userBins = [
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.deno', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.asdf', 'shims'),
    // Grok's official installer, whose PATH change a running shell never sees.
    join(home, '.grok', 'bin'),
  ]
  if (platform === 'win32') {
    return [
      // The PATH Windows would give a process started now, read from the
      // registry: installers add their folder there, after the app started.
      ...registryPath,
      env.APPDATA ? join(env.APPDATA, 'npm') : undefined,
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : undefined,
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'pnpm') : undefined,
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin') : undefined,
      // Antigravity's installer, whose PATH change a running shell never sees.
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'agy', 'bin') : undefined,
      // winget's links for command-line packages such as Claude Code.
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : undefined,
      ...userBins,
      join(home, 'scoop', 'shims'),
      env.ProgramData ? join(env.ProgramData, 'chocolatey', 'bin') : undefined,
    ]
  }
  return [
    ...userBins,
    platform === 'darwin' ? join(home, 'Library', 'pnpm', 'bin') : undefined,
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
}
