import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CustomHarness } from '@harness/contracts'
import { spawnCli } from '@harness/proc/cli'
import { desktopPath } from '@harness/proc/desktop-path'
import { killTree } from '@harness/proc/kill'
import { z } from 'zod'

type SpawnOptions = NonNullable<Parameters<typeof spawnCli>[2]>

export type ResolvedCustomHarnessLaunch = {
  command: string
  cwd: string
  environment: NodeJS.ProcessEnv
  workspacePath: string
}

/**
 * Resolve a custom executable exactly as the desktop server will launch it.
 * Electron apps do not inherit an interactive login shell, so the PATH also
 * includes the conventional per-user locations where CLI shims are installed.
 */
export function resolveCustomHarnessLaunch(
  harness: CustomHarness,
  workspacePath = process.cwd(),
  adapterEnvironment: NodeJS.ProcessEnv = {},
): ResolvedCustomHarnessLaunch {
  const workspace = absolutePath(expandHome(workspacePath), process.cwd())
  assertDirectory(workspace, 'workspace')
  const cwd = harness.workingDirectory
    ? absolutePath(expandHome(harness.workingDirectory), workspace)
    : workspace
  assertDirectory(cwd, 'launch directory')

  const environment = launchEnvironment(harness, workspace, adapterEnvironment)
  const command = resolveExecutable(expandHome(harness.command), cwd, environment)
  return { command, cwd, environment, workspacePath: workspace }
}

/** Bind one user-owned command while keeping adapter-generated argv intact. */
export function customHarnessSpawn(
  harness: CustomHarness,
  fallbackWorkspacePath?: string,
): typeof spawnCli {
  return (_defaultCommand, protocolArgs, options: SpawnOptions = {}) => {
    const launch = resolveCustomHarnessLaunch(
      harness,
      options.cwd ?? fallbackWorkspacePath ?? process.cwd(),
      options.env,
    )
    return spawnCli(launch.command, [...harness.args, ...protocolArgs], {
      cwd: launch.cwd,
      // This is already the complete inherited + custom + adapter environment.
      env: launch.environment,
      replaceEnv: true,
    })
  }
}

/** A short command using the same command/cwd/environment as real turns. */
export function runCustomHarness(
  harness: CustomHarness,
  workspacePath: string | undefined,
  protocolArgs: string[],
  timeoutMs = 10_000,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = customHarnessSpawn(harness, workspacePath)('', protocolArgs, {})
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: { code: number | null; stdout: string } | Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void killTree(child).then(() => {
        if (result instanceof Error) reject(result)
        else resolve(result)
      }, reject)
    }
    const timer = setTimeout(() => {
      finish(new Error(`${harness.displayName} did not answer within ${timeoutMs / 1_000}s`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 1_000_000) stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 16_000) stderr += chunk
    })
    child.on('error', (error) => finish(actionableLaunchError(harness, error)))
    // `exit` can fire before inherited stdout/stderr pipes have drained. Waiting
    // for `close` preserves the final protocol bytes emitted during shutdown.
    child.on('close', (code) => {
      if (code === 0 || code === null) {
        finish({ code, stdout })
        return
      }
      const detail = stderr.trim() || stdout.trim()
      finish(
        new Error(
          `${harness.displayName} exited with code ${code}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
        ),
      )
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end()
  })
}

export function customHarnessRun(harness: CustomHarness, fallbackWorkspacePath?: string) {
  return (_defaultCommand: string, args: string[], timeoutMs = 5_000) =>
    runCustomHarness(harness, fallbackWorkspacePath, args, timeoutMs)
}

export function actionableLaunchError(harness: CustomHarness, cause: unknown): Error {
  const error = cause instanceof Error ? cause : new Error(String(cause))
  const parsed = z.object({ code: z.string().optional() }).safeParse(error)
  const code = parsed.success ? parsed.data.code : undefined
  if (code === 'ENOENT') {
    return new Error(
      `${harness.displayName} executable was not found. Shell aliases and functions are unavailable; use an absolute path or an executable shim on PATH.`,
    )
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new Error(`${harness.displayName} executable is not allowed to run: ${error.message}`)
  }
  return error
}

function launchEnvironment(
  harness: CustomHarness,
  workspacePath: string,
  adapterEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const custom = harness.environment ?? {}
  const merged = { ...process.env, ...custom, ...adapterEnvironment }
  const suppliedPath = adapterEnvironment.PATH ?? custom.PATH ?? process.env.PATH ?? ''
  return {
    ...merged,
    PATH: desktopPath(suppliedPath, { env: merged }),
    // A wrapper can boot from its own directory without losing the project it
    // should operate on. Native protocols also receive the workspace normally.
    HARNESS_WORKSPACE_PATH: workspacePath,
  }
}

function resolveExecutable(command: string, cwd: string, environment: NodeJS.ProcessEnv): string {
  const pathCommand = path.isAbsolute(command) || command.includes('/') || command.includes('\\')
  if (pathCommand) {
    const candidate = path.isAbsolute(command) ? command : path.resolve(cwd, command)
    assertExecutable(candidate, command)
    return candidate
  }

  const extensions = executableExtensions(command, environment)
  for (const directory of (environment.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = path.join(stripQuotes(directory), `${command}${extension}`)
      if (isExecutable(candidate)) return candidate
    }
  }
  throw new Error(
    `Executable "${command}" was not found in TasteCode's PATH. Shell aliases and functions are unavailable; use an absolute path or an executable shim.`,
  )
}

function executableExtensions(command: string, environment: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') return ['']
  if (path.extname(command)) return ['']
  return (environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((extension) => extension.toLowerCase())
}

function assertExecutable(candidate: string, entered: string): void {
  if (!existsSync(candidate))
    throw new Error(`Executable "${entered}" does not exist at ${candidate}`)
  if (!isExecutable(candidate)) {
    throw new Error(`Executable "${entered}" is not a runnable file at ${candidate}`)
  }
}

function isExecutable(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    if (process.platform !== 'win32') accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function assertDirectory(candidate: string, label: string): void {
  try {
    if (statSync(candidate).isDirectory()) return
  } catch {
    // The actionable message below is the same for absent and unreadable dirs.
  }
  throw new Error(`Custom harness ${label} is not an accessible directory: ${candidate}`)
}

function absolutePath(candidate: string, relativeTo: string): string {
  return path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(relativeTo, candidate)
}

function expandHome(candidate: string): string {
  if (candidate === '~') return os.homedir()
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    return path.join(os.homedir(), candidate.slice(2))
  }
  return candidate
}

function stripQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value
}
