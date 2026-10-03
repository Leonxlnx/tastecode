import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { applyDesktopPath, desktopPath } from './desktop-path.js'
import { killTree, spawnOwned } from './kill.js'

/**
 * Spawn a CLI that may have been installed as an npm shim.
 *
 * On Windows, `codex` is `codex.cmd` and `claude` is `claude.cmd` — batch
 * files. `spawn('codex')` fails with EINVAL because CreateProcess cannot
 * execute a .cmd directly; it has to go through cmd.exe. This is the single
 * most common way a cross-platform agent wrapper breaks on Windows, so every
 * adapter shares this one implementation rather than each rediscovering it.
 *
 * Native executables bypass the shell. Batch shims need both Windows argv
 * quoting and cmd escaping; Node's default argv quoting alone is not enough.
 */
export function spawnCli(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; replaceEnv?: boolean } = {},
): ChildProcessWithoutNullStreams {
  const spawnOptions = {
    ...(!(options.cwd === undefined) ? { cwd: options.cwd } : {}),
    env: childEnvironment(options),
    stdio: ['pipe', 'pipe', 'pipe'] satisfies ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }

  if (process.platform === 'win32') {
    if (/\.(?:exe|com)$/i.test(command)) return spawnOwned(command, args, spawnOptions)
    const executable = resolveWindowsExecutable(command, spawnOptions.env, options.cwd) ?? command
    if (/\.(?:exe|com)$/i.test(executable)) return spawnOwned(executable, args, spawnOptions)
    const batch = /\.(?:cmd|bat)$/i.test(executable)
    const shellCommand = [
      escapeCmdToken(path.win32.normalize(executable)),
      ...args.map((argument) => quoteCmdArgument(argument, batch)),
    ].join(' ')
    return spawnOwned('cmd.exe', ['/d', '/s', '/v:off', '/c', `"${shellCommand}"`], {
      ...spawnOptions,
      windowsVerbatimArguments: true,
    })
  }
  return spawnOwned(command, args, spawnOptions)
}

const CMD_META = /([()[\]%!^"`<>&|;, *?\t\v\f])/g

function escapeCmdToken(value: string): string {
  // cmd cannot carry literal line breaks safely. Multiline CLI bodies belong on stdin.
  if (/[\r\n\0]/.test(value)) {
    throw new Error('Windows batch commands cannot contain line breaks or NUL bytes')
  }
  return value.replace(CMD_META, '^$1')
}

export function quoteCmdArgument(value: string, batch = false): string {
  if (value && !/[\s()[\]%!^"`<>&|;,*?\0]/.test(value)) return value
  let quoted = '"'
  let backslashes = 0
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    quoted += '\\'.repeat(character === '"' ? backslashes * 2 + 1 : backslashes) + character
    backslashes = 0
  }
  quoted += '\\'.repeat(backslashes * 2) + '"'
  const escaped = escapeCmdToken(quoted)
  // A forwarding .cmd shim parses %* a second time before starting its executable.
  return batch ? escapeCmdToken(escaped) : escaped
}

function resolveWindowsExecutable(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string | undefined {
  const envValue = (name: string) =>
    Object.entries(environment).find(([key]) => key.toUpperCase() === name)?.[1]
  const extensions = path.win32.extname(command)
    ? ['']
    : (envValue('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';')
  const directories = /[\\/]/.test(command) ? [cwd] : [cwd, ...(envValue('PATH') ?? '').split(';')]
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.win32.resolve(
        cwd,
        directory.replace(/^"|"$/g, ''),
        command + extension,
      )
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // Match Windows PATH/PATHEXT order without launching the candidate.
      }
    }
  }
  return undefined
}

/**
 * Whether a command exists on PATH.
 *
 * Asked with the platform's own lookup rather than by running the thing: agent
 * CLIs open browsers, start sessions, and print banners on first launch, none
 * of which is an acceptable side effect of drawing a list.
 */
export function isInstalled(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (process.platform !== 'win32') {
    return Promise.resolve(resolveExecutable(command, environment) !== undefined)
  }

  return new Promise((resolve) => {
    const env = { ...environment }
    applyDesktopPath(env)
    const child = spawn('where.exe', [command], {
      stdio: 'ignore',
      windowsHide: true,
      env,
    })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}

function childEnvironment(options: {
  env?: NodeJS.ProcessEnv
  replaceEnv?: boolean
}): NodeJS.ProcessEnv | undefined {
  if (options.replaceEnv) return options.env
  const env = { ...process.env, ...options.env }
  applyDesktopPath(env)
  return env
}

/**
 * A CLI's own version string, or undefined if it will not say.
 *
 * Every vendor formats this differently and some print startup noise first, so
 * this takes the first line that contains a version-looking number rather than
 * trusting position. Reporting nothing beats reporting a deprecation warning as
 * if it were a version.
 */
export async function commandVersion(
  command: string,
  timeoutMs = 5000,
): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    const executable = resolveExecutable(command)
    if (executable) {
      try {
        const target = path.basename(realpathSync(executable))
        const linkedVersion = /^v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)$/.exec(target)?.[1]
        if (linkedVersion) return linkedVersion
      } catch {
        // The command can disappear between PATH lookup and realpath. Let the
        // normal process fallback report that race as an unavailable version.
      }
    }
  }

  return spawnCommandVersion(command, timeoutMs)
}

async function spawnCommandVersion(
  command: string,
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    const { stdout } = await captureCli(spawnCli(command, ['--version']), timeoutMs, 64 * 1024)
    return (
      stdout
        .split('\n')
        .find((entry) => /\d+\.\d+/.test(entry))
        ?.trim() || undefined
    )
  } catch {
    return undefined
  }
}

function resolveExecutable(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const candidates = command.includes(path.sep)
    ? [command]
    : desktopPath(environment.PATH ?? '', { env: environment })
        .split(path.delimiter)
        .map((directory) => path.join(directory || '.', command))

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue in PATH order, matching normal command resolution.
    }
  }
  return undefined
}

/** Run a short, non-interactive CLI command and capture its public output. */
export function runCli(
  command: string,
  args: string[],
  timeoutMs = 5000,
): Promise<{ code: number | null; stdout: string; stderr?: string | undefined }> {
  return captureCli(spawnCli(command, args), timeoutMs)
}

/** Bound combined stdout/stderr before retaining bytes; settle only after owned cleanup. */
export function captureCli(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 5000,
  maxBytes = 1024 * 1024,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let settled = false
    const finish = (result: { code: number | null; stdout: string; stderr: string } | Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Handlers keep draining pipes but cannot retain more output after failure.
      stdout = ''
      stderr = ''
      void killTree(child).then(() => {
        if (result instanceof Error) reject(result)
        else resolve(result)
      }, reject)
    }
    const timer = setTimeout(() => {
      finish(new Error('CLI did not respond within the time limit'))
    }, timeoutMs)
    const append = (chunk: string, stream: 'stdout' | 'stderr') => {
      if (settled) return
      const size = Buffer.byteLength(chunk)
      if (size > maxBytes - bytes) {
        finish(new Error('CLI output exceeded the size limit. Reduce command output and retry.'))
        return
      }
      bytes += size
      if (stream === 'stdout') stdout += chunk
      else stderr += chunk
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => append(chunk, 'stdout'))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => append(chunk, 'stderr'))
    child.on('error', () =>
      finish(new Error('CLI could not start. Check the executable and permissions.')),
    )
    // Exit can precede the final bytes in inherited pipes.
    child.on('close', (code) => finish({ code, stdout, stderr }))
  })
}
