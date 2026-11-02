import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawnOwned } from '@harness/proc'

/** Resolve the binary: PATH name normally, the installer's fixed Windows home
 *  as a fallback because the installing shell's PATH update needs a restart. */
export function antigravityCommand(): string {
  if (process.platform !== 'win32') return 'agy'
  const localAppData = process.env['LOCALAPPDATA']
  if (!localAppData) return 'agy.exe'
  const installed = path.join(localAppData, 'agy', 'bin', 'agy.exe')
  return existsSync(installed) ? installed : 'agy.exe'
}

/**
 * Variables every agy that TasteCode starts gets on top of the inherited ones.
 *
 * Near the end of a run agy starts its auto-updater (`agy.exe --bg-updater`)
 * when its last check is 15 minutes old. On Windows the updater runs without a
 * console and starts `agy.exe --version`, which therefore opens a visible
 * console window of its own: `windowsHide` on the agy we start does not reach
 * it, so a chat turn or a sign-in check popped up an empty terminal in front
 * of the app (captured with agy 1.4.x, 2026-10-26). agy's own switch keeps the
 * updater off; it takes `true`, and `1` still started the updater. An agy the
 * user starts in a terminal still updates itself.
 */
export const ANTIGRAVITY_ENVIRONMENT = {
  AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
} as const satisfies Record<string, string>

export type AgySpawnOptions = {
  cwd?: string
  /** Only agy's own variables; a spawn lays them over its environment. */
  env: NodeJS.ProcessEnv
  stdio: ['pipe', 'pipe', 'pipe']
  windowsHide: boolean
}

export type AgySpawn = (
  command: string,
  args: string[],
  options: AgySpawnOptions,
) => ChildProcessWithoutNullStreams

/** The built-in spawn: owned for its lifetime, with this process's environment. */
export const spawnAgy: AgySpawn = (command, args, options) =>
  spawnOwned(command, args, { ...options, env: { ...process.env, ...options.env } })
