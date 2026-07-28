import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * Spawn a CLI that may have been installed as an npm shim.
 *
 * On Windows, `codex` is `codex.cmd` — a batch file. `spawn('codex')` fails
 * with EINVAL because CreateProcess cannot execute a .cmd directly; it has to
 * go through cmd.exe. This is the single most common way a cross-platform
 * agent wrapper breaks on Windows, so it lives in one place.
 *
 * Arguments are passed as an array rather than a concatenated string, so
 * cmd.exe never sees an unquoted user value.
 */
export function spawnCli(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): ChildProcessWithoutNullStreams {
  const env = { ...process.env, ...options.env }
  const spawnOptions = {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env,
    stdio: ['pipe', 'pipe', 'pipe'] satisfies Array<'pipe'>,
    windowsHide: true,
  }

  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/d', '/s', '/c', command, ...args], spawnOptions)
  }
  return spawn(command, args, spawnOptions)
}
