import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import type { PreviewPlan } from '@harness/design-agent'
import { spawnCli } from '@harness/proc/cli'
import { killTree, spawnOwned } from '@harness/proc/kill'
import { z } from 'zod'
import { existingWorkspacePath, writableWorkspacePath } from './api-workspace-paths.js'
import { STATIC_PREVIEW_HEADER, startStaticDesignPreview } from './design-static-preview.js'
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
const PackageManifestSchema = z.object({
  scripts: z.record(z.string(), z.string()).optional(),
})

export type RunningPreview = {
  url: string
  viewports: PreviewPlan['viewports']
  output: () => string
  stop: () => Promise<void>
}

export type PreviewChild = Pick<ChildProcessWithoutNullStreams, 'exitCode' | 'once'>

export async function startDesignPreview(
  workspacePath: string,
  plan: PreviewPlan,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<RunningPreview> {
  signal?.throwIfAborted()
  const workspace = realpathSync(workspacePath)
  const cwd = existingWorkspacePath(workspace, plan.cwd, true)
  if (plan.kind === 'static') {
    // A command preview that is still booting has not bound its port yet.
    const preview = await startStaticDesignPreview(cwd, plan, startingPreviewPorts)
    if (signal?.aborted) {
      await preview.stop()
      signal.throwIfAborted()
    }
    return preview
  }
  if (!COMMANDS.has(plan.command)) throw new Error('preview command is not allowed')
  if (plan.args.some((arg) => UNSAFE_ARG.test(arg))) {
    throw new Error('preview command argument is unsafe')
  }
  assertRunsWorkspaceCode(workspace, cwd, plan)
  const { url, releaseStart } = await claimPreviewStart(plan.url)
  const port = new URL(url).port
  const args = plan.args.map((arg, index) => {
    if (/^--port=\d+$/.test(arg)) return `--port=${port}`
    if (/^\d+$/.test(arg) && ['--port', '-p'].includes(plan.args[index - 1] ?? '')) return port
    return arg
  })
  const commandArgs = plan.command === 'node' ? args : packageScriptRun(args).args
  let child: ChildProcessWithoutNullStreams | undefined
  let output = ''
  try {
    signal?.throwIfAborted()
    const environment = { ...safeCommandEnvironment(workspace), PORT: port }
    child =
      process.platform === 'win32'
        ? spawnCli(plan.command, commandArgs, { cwd, replaceEnv: true, env: environment })
        : spawnOwned(plan.command, commandArgs, {
            cwd,
            env: environment,
            stdio: ['pipe', 'pipe', 'pipe'],
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
    await waitForPreview(child, url, timeoutMs, () => output, childFailure, signal)
  } catch (error) {
    if (child) {
      try {
        await stopProcess(child, url)
      } catch (stopError) {
        throw new AggregateError([error, stopError], 'Preview failed and did not stop')
      }
    }
    throw error
  } finally {
    releaseStart()
  }

  // After a natural exit the port may belong to an unrelated process, so only a
  // stop that found the tree running confirms the port was released.
  let confirmPort: boolean | undefined
  return {
    url,
    viewports: plan.viewports,
    output: () => output,
    stop: () => {
      confirmPort ??= child.exitCode === null && child.signalCode === null
      return stopProcess(child, url, confirmPort)
    },
  }
}

async function claimPreviewStart(url: string) {
  const previewUrl = new URL(url)
  let requestedPort = Number(previewUrl.port)
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await availablePreviewPort(
      startingPreviewPorts.has(requestedPort) ? 0 : requestedPort,
    )
    if (port !== undefined && !startingPreviewPorts.has(port)) {
      startingPreviewPorts.add(port)
      previewUrl.port = String(port)
      return {
        url: previewUrl.href,
        releaseStart: () => startingPreviewPorts.delete(port),
      }
    }
    requestedPort = 0
  }
  throw new Error('could not allocate a local preview port')
}

async function previewPortAvailable(url: string): Promise<boolean> {
  return (await availablePreviewPort(Number(new URL(url).port))) !== undefined
}

function availablePreviewPort(port: number): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const reservation = createServer()
    reservation.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        resolve(undefined)
        return
      }
      reject(error)
    })
    reservation.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      const address = reservation.address()
      const assignedPort = address && typeof address !== 'string' ? address.port : undefined
      reservation.close((error) => (error ? reject(error) : resolve(assignedPort)))
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
    const [script, ...args] = plan.args
    // Keep Node runtime flags (eval, loaders, preloads) out of model-chosen argv.
    // Projects needing them can declare an existing package script instead.
    if (!script || script.startsWith('-'))
      throw new Error('preview node command must start with a workspace script')
    existingWorkspacePath(workspace, path.relative(workspace, path.resolve(cwd, script)), false)
    for (const entry of args) {
      if (
        entry.startsWith('-') &&
        !entry.includes('=') &&
        !entry.includes(path.sep) &&
        !entry.includes('/')
      )
        continue
      const candidate = entry.startsWith('-') ? entry.slice(entry.indexOf('=') + 1) : entry
      // Script arguments may be directories, ports or other values. Retain
      // workspace/credential boundaries without requiring each value to be a file.
      writableWorkspacePath(workspace, path.relative(workspace, path.resolve(cwd, candidate)))
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
  const { script } = packageScriptRun(plan.args)
  if (!script) throw new Error('preview command must name a package script')
  if (!packageScripts(cwd).has(script)) {
    throw new Error(`preview script "${script}" is not declared in package.json`)
  }
}

/**
 * `pnpm dev`, `pnpm run dev` and `pnpm --silent run dev` all name a script.
 * Validation and launch share this so the script that runs is the one checked.
 */
function packageScriptRun(args: readonly string[]) {
  const named = args.filter((arg) => !arg.startsWith('-'))
  const explicitRun = named[0] === 'run'
  return {
    script: explicitRun ? named[1] : named[0],
    args: explicitRun ? [...args] : ['run', ...args],
  }
}

function packageScripts(cwd: string): Set<string> {
  try {
    const manifest = PackageManifestSchema.parse(
      JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')),
    )
    return new Set(Object.keys(manifest.scripts ?? {}))
  } catch {
    return new Set()
  }
}

export async function waitForPreview(
  child: PreviewChild,
  url: string,
  timeoutMs: number,
  output: () => string,
  childFailure: Promise<never>,
  signal?: AbortSignal,
): Promise<void> {
  await Promise.race([pollForPreview(child, url, timeoutMs, output, signal), childFailure])
}

export function watchPreviewChild(child: PreviewChild): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    child.once('error', (error: NodeJS.ErrnoException) =>
      // Recovery classifies setup failures such as ENOENT by their code.
      reject(
        Object.assign(new Error(`preview failed to start: ${error.message}`, { cause: error }), {
          code: error.code,
        }),
      ),
    )
  })
}

async function pollForPreview(
  child: PreviewChild,
  url: string,
  timeoutMs: number,
  output: () => string,
  signal?: AbortSignal,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    signal?.throwIfAborted()
    if (child.exitCode !== null) {
      throw new Error(`preview exited before it was ready\n${output()}`)
    }
    try {
      const timeout = AbortSignal.timeout(500)
      const response = await fetch(url, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      // A TasteCode static preview on this port is never the command's own server.
      if (response.ok && !response.headers.has(STATIC_PREVIEW_HEADER)) {
        // A losing child can remain alive briefly while its wrapper unwinds.
        // Do not let another process's response win that race.
        await delay(100)
        signal?.throwIfAborted()
        if (child.exitCode === null) return
        throw new Error(`preview exited before it was ready\n${output()}`)
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (child.exitCode !== null) {
        throw new Error(`preview exited before it was ready\n${output()}`, { cause: error })
      }
      // The server is still starting.
    }
    await delay(100)
  }
  throw new Error(`preview did not become ready within ${timeoutMs}ms\n${output()}`)
}

/**
 * Rejects when the process tree or its port outlives the stop, so the caller
 * keeps the handle and can retry instead of reporting a server that still runs.
 */
async function stopProcess(
  child: ChildProcessWithoutNullStreams,
  url: string,
  confirmPort = true,
): Promise<void> {
  if (child.pid === undefined) return
  await killTree(child)
  if (confirmPort && !(await waitForPortRelease(url, 1_000)))
    throw new Error(`Preview stopped but ${new URL(url).host} is still in use`)
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
