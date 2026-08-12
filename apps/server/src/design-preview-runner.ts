import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import type { PreviewPlan } from '@harness/design-agent'
import { spawnCli } from '@harness/proc'
import { existingWorkspacePath } from './api-workspace-paths.js'
import { safeCommandEnvironment } from './safe-command-environment.js'

/**
 * `npx` is deliberately absent: it fetches and executes a package from the
 * network, which turns "the model chose a preview command" into arbitrary
 * remote code execution. Everything left here runs code that is already in
 * the workspace the user opened.
 */
const COMMANDS = new Set(['bun', 'node', 'npm', 'pnpm', 'yarn'])
const UNSAFE_ARG = /[&|<>^%!"\r\n()]/
const MAX_OUTPUT_BYTES = 100_000

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
  if (!COMMANDS.has(plan.command)) throw new Error('preview command is not allowed')
  if (plan.args.some((arg) => UNSAFE_ARG.test(arg))) {
    throw new Error('preview command argument is unsafe')
  }
  const workspace = realpathSync(workspacePath)
  const cwd = existingWorkspacePath(workspace, plan.cwd, true)
  assertRunsWorkspaceCode(workspace, cwd, plan)
  await assertPreviewPortAvailable(plan.url)
  const child = spawnCli(plan.command, plan.args, {
    cwd,
    replaceEnv: true,
    env: safeCommandEnvironment(workspace),
  })
  child.stdin.end()

  let output = ''
  const append = (chunk: string) => {
    output = `${output}${chunk}`.slice(-MAX_OUTPUT_BYTES)
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', append)
  child.stderr.on('data', append)

  try {
    await waitForPreview(child, plan.url, timeoutMs, () => output)
  } catch (error) {
    await stopProcess(child)
    throw error
  }

  return {
    url: plan.url,
    viewports: plan.viewports,
    output: () => output,
    stop: () => stopProcess(child),
  }
}

async function assertPreviewPortAvailable(url: string): Promise<void> {
  const port = Number(new URL(url).port)
  await new Promise<void>((resolve, reject) => {
    const reservation = createServer()
    reservation.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(
          new Error(
            `preview port ${port} is already in use; choose another http://127.0.0.1 port and retry`,
          ),
        )
        return
      }
      reject(error)
    })
    reservation.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      reservation.close((error) => (error ? reject(error) : resolve()))
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
export function assertRunsWorkspaceCode(workspace: string, cwd: string, plan: PreviewPlan): void {
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

async function waitForPreview(
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
      if (response.ok) return
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`preview did not become ready within ${timeoutMs}ms\n${output()}`)
}

function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return Promise.resolve()
  if (process.platform !== 'win32') {
    child.kill('SIGTERM')
    return Promise.resolve()
  }
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
