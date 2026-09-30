import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { desktopPath, spawnCli, spawnOwned } from '@harness/proc'

/**
 * The Windows installer launches `node.exe index.js` from cursor-agent.ps1.
 * `cursor-agent.cmd` only forwards into that script through `cmd.exe`, which
 * treats `<` in an argument as redirection. Turns spawn node directly.
 *
 * Version directories match the installer's own pattern, including the
 * YYYY.MM.DD-HH-MM-SS-commit form. The installer sorts by the date prefix;
 * equal dates are otherwise unordered, so the name breaks the tie.
 */
const VERSION_DIRECTORY = /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/

export type CursorLaunchFs = {
  exists: (file: string) => boolean
  list: (directory: string) => string[]
}

export type CursorAgentLaunch = {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export function planCursorLaunch(
  command: string,
  args: string[],
  options: {
    platform: NodeJS.Platform
    env: NodeJS.ProcessEnv
    fs: CursorLaunchFs
  },
): CursorAgentLaunch | undefined {
  if (options.platform !== 'win32' || command !== 'cursor-agent') return undefined
  const env = withWindowsPath(options.env)
  const directory = findCursorAgentDirectory(env, options.fs.exists)
  if (!directory) return undefined
  const launch = resolveWindowsCursorLaunch(directory, options.fs)
  if (!launch) return undefined
  if (!env.CURSOR_INVOKED_AS) env.CURSOR_INVOKED_AS = 'cursor-agent'
  if (!env.NODE_COMPILE_CACHE && env.LOCALAPPDATA) {
    env.NODE_COMPILE_CACHE = path.win32.join(env.LOCALAPPDATA, 'cursor-compile-cache')
  }
  return { command: launch.nodePath, args: [launch.indexPath, ...args], env }
}

/** Install root that contains cursor-agent.cmd, searching the desktop PATH. */
export function findCursorAgentDirectory(
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean,
): string | undefined {
  const pathValue = env.PATH ?? ''
  for (const directory of pathValue.split(path.win32.delimiter)) {
    if (!directory) continue
    if (exists(path.win32.join(directory, 'cursor-agent.cmd'))) return directory
  }
  return undefined
}

export function resolveWindowsCursorLaunch(
  agentDirectory: string,
  fs: CursorLaunchFs,
): { nodePath: string; indexPath: string } | undefined {
  const besideNode = path.win32.join(agentDirectory, 'node.exe')
  const besideIndex = path.win32.join(agentDirectory, 'index.js')
  if (fs.exists(besideNode) && fs.exists(besideIndex)) {
    return { nodePath: besideNode, indexPath: besideIndex }
  }
  const version = latestVersion(agentDirectory, fs)
  if (!version) return undefined
  const nodePath = path.win32.join(agentDirectory, 'versions', version, 'node.exe')
  const indexPath = path.win32.join(agentDirectory, 'versions', version, 'index.js')
  if (!fs.exists(nodePath) || !fs.exists(indexPath)) return undefined
  return { nodePath, indexPath }
}

/** Same spawn signature as `spawnCli`. Windows turns skip cmd.exe. */
export function spawnCursorAgent(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; replaceEnv?: boolean } = {},
): ChildProcessWithoutNullStreams {
  const env = options.replaceEnv ? { ...options.env } : { ...process.env, ...options.env }
  const planned = planCursorLaunch(command, args, {
    platform: process.platform,
    env,
    fs: { exists: existsSync, list: (directory) => readdirSync(directory) },
  })
  if (!planned) return spawnCli(command, args, options)
  return spawnOwned(planned.command, planned.args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: planned.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

function withWindowsPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  const value = desktopPath(undefined, { platform: 'win32', env: next })
  for (const key of Object.keys(next)) if (key.toLowerCase() === 'path') delete next[key]
  next.PATH = value
  return next
}

function latestVersion(agentDirectory: string, fs: CursorLaunchFs): string | undefined {
  let names: string[]
  try {
    names = fs.list(path.win32.join(agentDirectory, 'versions'))
  } catch {
    return undefined
  }
  const versions = names.filter((name) => VERSION_DIRECTORY.test(name))
  versions.sort((left, right) => {
    const byDate = versionDateKey(right) - versionDateKey(left)
    if (byDate !== 0) return byDate
    return right.localeCompare(left)
  })
  return versions[0]
}

/** YYYYMMDD from the installer's Parse-VersionString. */
function versionDateKey(name: string): number {
  const [year, month, day] = (name.split('-')[0] ?? '').split('.')
  if (!year || !month || !day) return 0
  const key = Number(year + month.padStart(2, '0') + day.padStart(2, '0'))
  return Number.isFinite(key) ? key : 0
}
