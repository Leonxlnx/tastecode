import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants, realpathSync } from 'node:fs'
import path from 'node:path'
import { applyDesktopPath, desktopPath } from './desktop-path.js'
import { killTree, spawnOwned } from './kill.js'

const IS_INSTALLED_TIMEOUT_MS = 5_000

/**
 * Spawn a CLI that may have been installed as an npm shim.
 *
 * On Windows, `codex` is `codex.cmd` and `claude` is `claude.cmd` — batch
 * files. `spawn('codex')` fails with EINVAL because CreateProcess cannot
 * execute a .cmd directly; it has to go through cmd.exe. This is the single
 * most common way a cross-platform agent wrapper breaks on Windows, so every
 * adapter shares this one implementation rather than each rediscovering it.
 *
 * Arguments are passed as an array, so cmd.exe never sees an unquoted value.
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
    return spawnOwned('cmd.exe', ['/d', '/s', '/c', command, ...args], spawnOptions)
  }
  return spawnOwned(command, args, spawnOptions)
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
    // where.exe itself can stall on a broken PATH entry; a hung lookup must
    // answer "not installed" rather than block the caller forever.
    const timer = setTimeout(() => {
      child.kill()
      resolve(false)
    }, IS_INSTALLED_TIMEOUT_MS)
    const finish = (installed: boolean) => {
      clearTimeout(timer)
      resolve(installed)
    }
    child.on('error', () => finish(false))
    child.on('exit', (code) => finish(code === 0))
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

function spawnCommandVersion(command: string, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawnCli(command, ['--version'])
    // A version probe that reads stdin would wait for input until the
    // timeout; no probe gets any.
    endStdin(child)
    let output = ''
    let settled = false
    const finish = (value: string | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // A teardown failure must not throw away a version that was captured.
      void killTree(child).finally(() => resolve(value))
    }

    const timer = setTimeout(() => finish(undefined), timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.on('error', () => finish(undefined))
    child.on('close', () => {
      const line = output.split('\n').find((entry) => /\d+\.\d+/.test(entry))
      finish(line?.trim() || undefined)
    })
  })
}

/**
 * Close a probe child's stdin so a command that reads it cannot hang, and
 * swallow the EPIPE a race with an already-exited child would otherwise
 * raise as an unhandled stream error.
 */
function endStdin(child: ChildProcessWithoutNullStreams): void {
  child.stdin.on('error', () => undefined)
  child.stdin.end()
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
  return new Promise((resolve, reject) => {
    const child = spawnCli(command, args)
    // A command that reads stdin would wait for input until the timeout;
    // runCli never provides any.
    endStdin(child)
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (
      result: { code: number | null; stdout: string; stderr?: string | undefined } | Error,
    ) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void killTree(child).then(
        () => {
          if (result instanceof Error) reject(result)
          else resolve(result)
        },
        (killError: unknown) => {
          // The command's own outcome is the answer: a teardown failure must
          // not mask a primary error such as the response timeout.
          if (result instanceof Error) reject(result)
          else if (killError instanceof Error) reject(killError)
          else reject(new Error(String(killError)))
        },
      )
    }
    const timer = setTimeout(() => {
      finish(new Error(`${command} did not respond`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', finish)
    child.on('close', (code) => finish({ code, stdout, stderr }))
  })
}
