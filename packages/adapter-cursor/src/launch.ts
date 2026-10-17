import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { spawnCli } from '@harness/proc'
import { captureCli, type CapturedCli } from '@harness/proc/cli'

/**
 * How cursor-agent really starts on Windows.
 *
 * The installer puts `%LOCALAPPDATA%\cursor-agent\cursor-agent.cmd` on PATH.
 * That batch shim runs `cursor-agent.ps1`, which starts the newest
 * `versions\<version>\node.exe` with that version's `index.js`. Through the
 * shim every argument lands on a cmd.exe command line, which cannot carry a
 * line break, and the prompt is an argument that usually has one: the first
 * turn of every chat always does. Starting the same node.exe directly passes
 * the prompt through native argv quoting instead.
 */
export type CursorWindowsLauncher = {
  node: string
  script: string
  env: Record<string, string>
}

// Both version directory forms cursor-agent.ps1 accepts:
// YYYY.MM.DD-commit and YYYY.MM.DD-HH-MM-SS-commit.
const VERSION_DIRECTORY = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/

export function findCursorWindowsLauncher(
  env: NodeJS.ProcessEnv = process.env,
): CursorWindowsLauncher | undefined {
  const localAppData = env['LOCALAPPDATA']
  if (!localAppData) return undefined
  const home = path.join(localAppData, 'cursor-agent')
  for (const directory of [home, ...versionDirectories(path.join(home, 'versions'))]) {
    const node = path.join(directory, 'node.exe')
    const script = path.join(directory, 'index.js')
    if (!existsSync(node) || !existsSync(script)) continue
    return {
      node,
      script,
      // What the shim and its PowerShell script set before they start node.
      env: {
        CURSOR_INVOKED_AS: 'cursor-agent.cmd',
        NODE_COMPILE_CACHE:
          env['NODE_COMPILE_CACHE'] || path.join(localAppData, 'cursor-compile-cache'),
      },
    }
  }
  return undefined
}

/** Newest first, by the date the shim sorts on, with the build time breaking ties. */
function versionDirectories(root: string): string[] {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .flatMap((entry) => {
      const match = entry.isDirectory() ? VERSION_DIRECTORY.exec(entry.name) : null
      if (!match) return []
      const [, year = '', month = '', day = '', hour = '00', minute = '00', second = '00'] = match
      const order = Number(
        `${year}${month.padStart(2, '0')}${day.padStart(2, '0')}${hour}${minute}${second}`,
      )
      return [{ order, directory: path.join(root, entry.name) }]
    })
    .sort((left, right) => right.order - left.order)
    .map(({ directory }) => directory)
}

/**
 * spawnCli for cursor-agent. On Windows the bundled node.exe is started
 * directly when the standard install is present; otherwise the shim on PATH
 * is used as before.
 */
export function spawnCursorAgent(
  command: string,
  args: string[],
  options: NonNullable<Parameters<typeof spawnCli>[2]> = {},
): ChildProcessWithoutNullStreams {
  const launcher = process.platform === 'win32' ? findCursorWindowsLauncher() : undefined
  if (!launcher) return spawnCli(command, args, options)
  return spawnCli(launcher.node, [launcher.script, ...args], {
    ...options,
    env: { ...launcher.env, ...options.env },
  })
}

/**
 * How long a short cursor-agent command may take. Each one starts node and
 * most go online: on a busy Windows machine `status` took 3.5–12.8 s and
 * `models` 9–14.5 s, so the general five-second CLI limit failed them.
 */
export const CURSOR_COMMAND_TIMEOUT_MS = 30_000

/**
 * runCli for cursor-agent: the same start as a turn, so `status`, `models`
 * and `logout` skip the cmd.exe and PowerShell hops on Windows as well.
 */
export function runCursorAgent(
  command: string,
  args: string[],
  timeoutMs = CURSOR_COMMAND_TIMEOUT_MS,
): Promise<CapturedCli> {
  const child = spawnCursorAgent(command, args)
  const captured = captureCli(child, timeoutMs)
  // Nothing is sent; EOF keeps a command that reads stdin from waiting.
  child.stdin.on('error', () => undefined)
  child.stdin.end()
  return captured
}
