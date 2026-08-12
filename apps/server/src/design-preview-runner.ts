import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import type { PreviewPlan } from '@harness/design-agent'
import { spawnCli } from '@harness/proc'
import { existingWorkspacePath } from './api-workspace-paths.js'
import { startStaticDesignPreview } from './design-static-preview.js'
import { safeCommandEnvironment } from './safe-command-environment.js'

/**
 * `npx` is deliberately absent: it fetches and executes a package from the
 * network, which turns "the model chose a preview command" into arbitrary
 * remote code execution. Everything left here runs code that is already in
 * the workspace the user opened.
 */
const COMMANDS = new Set(['bun', 'node', 'npm', 'pnpm', 'yarn'])
const UNSAFE_ARG = /[&|<>^%!"\r\n()]/
const PACKAGE_SCOPE_ARG =
  /^-(?:C|F|r|w)|^--(?:cwd|dir|prefix|filter(?:-prod)?|recursive|workspace(?:-root|s)?|include-workspace-root)(?:=|$)/
const MAX_OUTPUT_BYTES = 100_000
const startingPreviewPorts = new Set<number>()

export type RunningPreview = {
  url: string
  viewports: PreviewPlan['viewports']
  output: () => string
  stop: () => Promise<void>
}

export async function startDesignPreview(
  workspacePath: string,
  plan: PreviewPlan,
  timeoutMs = 30_000,
): Promise<RunningPreview> {
  const workspace = realpathSync(workspacePath)
  const cwd = existingWorkspacePath(workspace, plan.cwd, true)
  if (plan.kind === 'static') {
    return startStaticDesignPreview(cwd, plan)
  }
  if (!COMMANDS.has(plan.command)) throw new Error('preview command is not allowed')
  if (plan.args.some((arg) => UNSAFE_ARG.test(arg))) {
    throw new Error('preview command argument is unsafe')
  }
  assertRunsWorkspaceCode(workspace, cwd, plan)
  const releaseStart = claimPreviewStart(plan.url)
  let child: ChildProcessWithoutNullStreams | undefined
  let output = ''
  try {
    await assertPreviewPortAvailable(plan.url)
    const environment = safeCommandEnvironment(workspace)
    child =
      process.platform === 'win32'
        ? spawnCli(plan.command, plan.args, { cwd, replaceEnv: true, env: environment })
        : spawn(plan.command, plan.args, {
            cwd,
            env: environment,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true,
          })
    const childFailure = watchPreviewChild(child)
    child.stdin.end()
    const append = (chunk: string) => {
      output = `${output}${chunk}`.slice(-MAX_OUTPUT_BYTES)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    await waitForPreview(child, plan.url, timeoutMs, () => output, childFailure)
  } catch (error) {
    if (child) await stopProcess(child, plan.url)
    throw error
  } finally {
    releaseStart()
  }

  return {
    url: plan.url,
    viewports: plan.viewports,
    output: () => output,
    stop: () => stopProcess(child, plan.url),
  }
}

function claimPreviewStart(url: string): () => void {
  const port = Number(new URL(url).port)
  if (startingPreviewPorts.has(port)) {
    throw new Error(`preview port ${port} is already being started`)
  }
  startingPreviewPorts.add(port)
  return () => startingPreviewPorts.delete(port)
}

async function assertPreviewPortAvailable(url: string): Promise<void> {
  const port = Number(new URL(url).port)
  if (!(await previewPortAvailable(url))) {
    throw new Error(
      `preview port ${port} is already in use; choose another http://127.0.0.1 port and retry`,
    )
  }
}

function previewPortAvailable(url: string): Promise<boolean> {
  const port = Number(new URL(url).port)
  return new Promise<boolean>((resolve, reject) => {
    const reservation = createServer()
    reservation.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        resolve(false)
        return
      }
      reject(error)
    })
    reservation.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      reservation.close((error) => (error ? reject(error) : resolve(true)))
    })
  })
}

/**
 * The plan must start code that already lives in the workspace.
 *
 * Design Mode reads the project's own README, package.json and source while
 * it works, so anything in there can steer the model's choice of preview
 * command. Without this, a line in a README was enough to make the harness
 * run a command of the repository's choosing with no user approval. Package
 * scripts and workspace files are code the user already opted into by
 * pointing Design Mode at the project; a package name resolved off the
 * network is not.
 */
export function assertRunsWorkspaceCode(
  workspace: string,
  cwd: string,
  plan: Extract<PreviewPlan, { kind: 'command' }>,
): void {
  if (plan.command === 'node') {
    const entries = plan.args.filter((arg) => !arg.startsWith('-'))
    if (entries.length === 0) throw new Error('preview command must name a script in the workspace')
    // EVERY path argument, not just the first: `node --import ./local.mjs
    // ../../outside.mjs` would otherwise pass on the local one and then run
    // the other. Flag VALUES are checked too — they can be paths as well.
    for (const entry of plan.args) {
      if (entry.startsWith('-') && !entry.includes(path.sep) && !entry.includes('/')) continue
      const candidate = entry.startsWith('-') ? entry.slice(entry.indexOf('=') + 1) : entry
      // Throws unless the file exists inside the workspace.
      existingWorkspacePath(
        workspace,
        path.relative(workspace, path.resolve(cwd, candidate)),
        false,
      )
    }
    return
  }

  const scriptSeparator = plan.args.indexOf('--')
  const packageManagerArgs =
    scriptSeparator === -1 ? plan.args : plan.args.slice(0, scriptSeparator)
  if (
    packageManagerArgs.some((arg) => PACKAGE_SCOPE_ARG.test(arg)) ||
    plan.args[0] === 'workspace' ||
    plan.args[0] === 'workspaces'
  ) {
    throw new Error('preview package-manager workspace selectors are not allowed')
  }
  // `pnpm dev` and `pnpm run dev` are both idiomatic; both must name a script.
  const named = plan.args.filter((arg) => !arg.startsWith('-'))
  const script = named[0] === 'run' ? named[1] : named[0]
  if (!script) throw new Error('preview command must name a package script')
  if (!packageScripts(cwd).has(script)) {
    throw new Error(`preview script "${script}" is not declared in package.json`)
  }
}

function packageScripts(cwd: string): Set<string> {
  try {
    const manifest = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>
    }
    return new Set(Object.keys(manifest.scripts ?? {}))
  } catch {
    return new Set()
  }
}

export async function waitForPreview(
  child: ChildProcessWithoutNullStreams,
  url: string,
  timeoutMs: number,
  output: () => string,
  childFailure: Promise<never>,
): Promise<void> {
  await Promise.race([pollForPreview(child, url, timeoutMs, output), childFailure])
}

export function watchPreviewChild(child: ChildProcessWithoutNullStreams): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    child.once('error', (error) => reject(new Error(`preview failed to start: ${error.message}`)))
  })
}

async function pollForPreview(
  child: ChildProcessWithoutNullStreams,
  url: string,
  timeoutMs: number,
  output: () => string,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`preview exited before it was ready\n${output()}`)
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) })
      if (response.ok) {
        // A losing child can remain alive briefly while its wrapper unwinds.
        // Do not let another process's response win that race.
        await delay(100)
        if (child.exitCode === null) return
        throw new Error(`preview exited before it was ready\n${output()}`)
      }
    } catch (error) {
      if (child.exitCode !== null) {
        throw new Error(`preview exited before it was ready\n${output()}`, { cause: error })
      }
      // The server is still starting.
    }
    await delay(100)
  }
  throw new Error(`preview did not become ready within ${timeoutMs}ms\n${output()}`)
}

async function stopProcess(child: ChildProcessWithoutNullStreams, url: string): Promise<void> {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') {
      await killWindowsTree(child)
    } else {
      await killPosixGroup(child.pid)
    }
    await waitForPortRelease(url, 500)
  } catch {}
}

async function killPosixGroup(pid: number): Promise<void> {
  signalProcessGroup(pid, 'SIGTERM')
  if (await waitForProcessGroupExit(pid, 1_500)) return
  signalProcessGroup(pid, 'SIGKILL')
  await waitForProcessGroupExit(pid, 1_500)
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now()
  do {
    if (!processGroupAlive(pid)) return true
    await delay(50)
  } while (Date.now() - startedAt < timeoutMs)
  return false
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

function killWindowsTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.on('error', () => {
      child.kill()
      resolve()
    })
    killer.on('exit', () => resolve())
  })
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

async function waitForPortRelease(url: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now()
  do {
    if (await previewPortAvailable(url)) return true
    await delay(50)
  } while (Date.now() - startedAt < timeoutMs)
  return false
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
