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
  ]
  if (platform === 'win32') {
    return [
      env.APPDATA ? join(env.APPDATA, 'npm') : undefined,
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : undefined,
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'pnpm') : undefined,
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
