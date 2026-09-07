import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants, realpathSync } from 'node:fs'
import path from 'node:path'
import { desktopPath } from './desktop-path.js'
import { ownProcessTree, ownedProcessSpawnOptions, terminateTree } from './kill.js'

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
    stdio: ['pipe', 'pipe', 'pipe'] satisfies Array<'pipe'>,
    windowsHide: true,
    ...ownedProcessSpawnOptions(),
  }

  if (process.platform === 'win32') {
    if (/\.(?:exe|com)$/i.test(command)) {
      return ownProcessTree(spawn(command, args, spawnOptions))
    }
    return ownProcessTree(spawn('cmd.exe', ['/d', '/s', '/c', command, ...args], spawnOptions))
  }
  return ownProcessTree(spawn(command, args, spawnOptions))
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
    const child = spawn('where.exe', [command], {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...environment, PATH: desktopPath(environment.PATH ?? '', { env: environment }) },
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
  env.PATH = desktopPath(env.PATH ?? '', { env })
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
    let output = ''
    // Latched synchronously so a racing close/error cannot overwrite the
    // timeout outcome; the promise settles only after bounded tree cleanup.
    let latched = false
    let settled = false
    const doResolve = (value: string | undefined) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const cleanupAndResolve = (value: string | undefined) => {
      if (latched) return
      latched = true
      clearTimeout(timer)
      // Full-tree shutdown (TERM-to-KILL escalation on Unix, taskkill /T on
      // Windows via terminateTree) so a stubborn descendant cannot survive
      // the probe. A cleanup failure still reports the latched version
      // outcome; this probe never rejects by contract.
      void terminateTree(child)
        .catch(() => undefined)
        .then(() => doResolve(value))
    }

    const timer = setTimeout(() => cleanupAndResolve(undefined), timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.on('error', () => cleanupAndResolve(undefined))
    child.on('close', () => {
      const line = output.split('\n').find((entry) => /\d+\.\d+/.test(entry))
      cleanupAndResolve(line?.trim() || undefined)
    })
  })
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
    let stdout = ''
    let stderr = ''
    // Latch the first outcome synchronously so a timeout cannot be
    // overwritten by a racing close/error. The timeout promise settles only
    // after bounded tree cleanup; normal close/error settle immediately to
    // preserve the output contract.
    let latched = false
    let settled = false
    const doResolve = (result: {
      code: number | null
      stdout: string
      stderr?: string | undefined
    }) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const doReject = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const finishResolve = (result: {
      code: number | null
      stdout: string
      stderr?: string | undefined
    }) => {
      if (latched) return
      latched = true
      clearTimeout(timer)
      doResolve(result)
    }
    const finishReject = (error: Error) => {
      if (latched) return
      latched = true
      clearTimeout(timer)
      doReject(error)
    }
    const finishTimeout = () => {
      if (latched) return
      latched = true
      clearTimeout(timer)
      const timeoutError = new Error(`${command} did not respond`)
      // Full-tree shutdown (TERM-to-KILL escalation on Unix, taskkill /T on
      // Windows via terminateTree) so stubborn descendants cannot survive a
      // hung probe. Cleanup failures are swallowed so the actionable timeout
      // error is what the caller sees.
      void terminateTree(child)
        .catch(() => undefined)
        .then(() => doReject(timeoutError))
    }
    const timer = setTimeout(finishTimeout, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', finishReject)
    child.on('close', (code) => finishResolve({ code, stdout, stderr }))
  })
}
