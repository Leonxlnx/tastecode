import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { desktopPath } from '@harness/proc/desktop-path'

/**
 * Stable per-user directory backing TEMP/TMP/APPDATA for spawned commands.
 *
 * A fixed name inside the world-writable temp dir lets another local user
 * squat the path first; the uid suffix gives each user their own directory.
 */
export function commandRuntimeDirectory(): string {
  if (process.platform === 'win32') return path.join(os.tmpdir(), 'tastecode-project-tools')
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  const leaf = uid === undefined ? 'tastecode-project-tools' : `tastecode-project-tools-${uid}`
  return path.join(os.tmpdir(), leaf)
}

function ensurePrivateDirectory(directory: string): void {
  if (process.platform === 'win32') {
    mkdirSync(directory, { recursive: true })
    return
  }
  // Non-recursive: the parent (os.tmpdir) always exists, and an attacker-owned
  // symlink at the path fails with EEXIST instead of being followed.
  try {
    mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
  }
  // chmodSync follows symlinks, so refuse a symlink (or a non-directory) rather
  // than tightening — or following — someone else's target.
  const stats = lstatSync(directory)
  if (stats.isSymbolicLink()) {
    throw new Error(
      `Refusing to use symlinked command runtime directory at ${directory}. ` +
        `Remove it and retry.`,
    )
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `Refusing to use command runtime directory at ${directory}: not a directory. ` +
        `Remove it and retry.`,
    )
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error(
      `Refusing to use command runtime directory at ${directory}: owned by another user. ` +
        `Remove it and retry.`,
    )
  }
  // Tightens a directory left readable by an older build.
  chmodSync(directory, 0o700)
}

/**
 * PATH for spawned commands: the real user PATH plus the GUI additions
 * (Homebrew, `~/.local/bin`, npm shims) that `desktopPath` applies at every
 * other spawn site. `.` and empty entries resolve inside the command's working
 * directory — letting a checked-in `git` shadow the allowlisted binary — so
 * they are dropped.
 *
 * `process.env`, not the sandbox env, supplies the home and AppData locations
 * the additions are derived from: the sandbox points HOME at the workspace,
 * which would put `workspace/bin` and friends straight onto PATH.
 */
function commandPath(): string {
  return desktopPath(process.env['PATH'] ?? '', { env: process.env })
    .split(path.delimiter)
    .filter((entry) => entry !== '' && entry !== '.')
    .join(path.delimiter)
}

export function safeCommandEnvironment(
  workspace: string,
  runtimeDir = commandRuntimeDirectory(),
): NodeJS.ProcessEnv {
  ensurePrivateDirectory(runtimeDir)
  const runtime = runtimeDir
  const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null'
  const environment: NodeJS.ProcessEnv = {
    PATH: commandPath(),
    PATHEXT: process.env['PATHEXT'],
    SYSTEMROOT: process.env['SYSTEMROOT'],
    WINDIR: process.env['WINDIR'],
    COMSPEC: process.env['COMSPEC'],
    // cmd.exe searches the current directory before PATH unless this is set,
    // so a workspace-shipped `git.cmd` would bypass the executable allowlist.
    NoDefaultCurrentDirectoryInExePath: '1',
    TEMP: runtime,
    TMP: runtime,
    HOME: workspace,
    USERPROFILE: workspace,
    APPDATA: runtime,
    LOCALAPPDATA: runtime,
    CI: '1',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: nullFile,
    NPM_CONFIG_USERCONFIG: nullFile,
  }
  // POSIX tools honor TMPDIR; Windows reads TEMP/TMP above.
  if (process.platform !== 'win32') environment['TMPDIR'] = runtime
  return environment
}
