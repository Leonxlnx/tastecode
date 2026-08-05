import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import type { PreviewPlan } from '@harness/design-agent'
import { spawnCli } from '@harness/proc'
import { existingWorkspacePath } from './api-workspace-paths.js'
import { safeCommandEnvironment } from './safe-command-environment.js'

const COMMANDS = new Set(['bun', 'node', 'npm', 'npx', 'pnpm', 'yarn'])
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
