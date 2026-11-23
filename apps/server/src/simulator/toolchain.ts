import {
  access,
  constants,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import type { SimulatorToolVersion, SimulatorToolVersions } from '@harness/contracts'
import { killTree, locateCommand, spawnCli } from '@harness/proc'
import {
  AGENT_DEVICE_PACKAGE,
  AGENT_DEVICE_VERSION,
  DEVICE_HUB_PACKAGE,
  DEVICE_HUB_VERSION,
} from './tool-versions.js'

const INSTALL_TIMEOUT_MS = 10 * 60_000
const SEMVER_DIR = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/

export type SimulatorToolPaths = {
  readonly installDir: string
  readonly entryPath: string
  readonly sentinelPath: string
}

type ToolSpec = {
  readonly name: string
  readonly version: string
  readonly entry: readonly string[]
}

const HUB_SPEC: ToolSpec = {
  name: DEVICE_HUB_PACKAGE,
  version: DEVICE_HUB_VERSION,
  entry: ['dist', 'server', 'cli.mjs'],
}

const AGENT_DEVICE_SPEC: ToolSpec = {
  name: AGENT_DEVICE_PACKAGE,
  version: AGENT_DEVICE_VERSION,
  entry: ['bin', 'agent-device.mjs'],
}

function toolPaths(baseDir: string, spec: ToolSpec): SimulatorToolPaths {
  const installDir = path.join(baseDir, 'tools', spec.name, spec.version)
  return {
    installDir,
    entryPath: path.join(installDir, 'node_modules', spec.name, ...spec.entry),
    sentinelPath: path.join(installDir, '.install-complete'),
  }
}

export function simulatorStateDir(dataRoot: string): string {
  return path.join(dataRoot, 'simulator')
}

export function agentDeviceStateDir(dataRoot: string): string {
  return path.join(simulatorStateDir(dataRoot), 'agent-device')
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function isInstalled(paths: SimulatorToolPaths, version: string): Promise<boolean> {
  if (!(await fileExists(paths.entryPath))) return false
  try {
    const sentinel = (await readFile(paths.sentinelPath, 'utf8')).trim()
    return sentinel === version
  } catch {
    return false
  }
}

export async function isDeviceHubInstalled(baseDir: string): Promise<boolean> {
  return isInstalled(toolPaths(baseDir, HUB_SPEC), HUB_SPEC.version)
}

export async function isAgentDeviceInstalled(baseDir: string): Promise<boolean> {
  return isInstalled(toolPaths(baseDir, AGENT_DEVICE_SPEC), AGENT_DEVICE_SPEC.version)
}

export async function installedAgentDeviceEntry(
  baseDir: string,
  versions: readonly string[],
): Promise<string | null> {
  for (const version of versions) {
    const paths = toolPaths(baseDir, { ...AGENT_DEVICE_SPEC, version })
    if (await isInstalled(paths, version)) return paths.entryPath
  }
  return null
}

/**
 * Resolve a Node executable suitable for running the hub and agent-device.
 * Inside a packaged Electron desktop build, `process.execPath` is Node when
 * invoked with `ELECTRON_RUN_AS_NODE=1`, so we prefer `node` on PATH first
 * and fall back to `process.execPath`.
 */
export async function resolveNodeExecutable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ executable: string; env: NodeJS.ProcessEnv }> {
  const onPath = await locateCommand('node', env)
  if (onPath) return { executable: onPath, env }
  if (process.execPath) {
    return {
      executable: process.execPath,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    }
  }
  throw new Error('Node.js runtime was not found on PATH.')
}

type RunResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  enoent: boolean
}

function runInstallCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawnCli(command, args, { env })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const MAX_CAPTURE = 256 * 1024
    const append = (current: string, chunk: Buffer) => {
      if (current.length >= MAX_CAPTURE) return current
      return current + chunk.toString('utf8').slice(0, MAX_CAPTURE - current.length)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end()

    const finish = (code: number | null, enoent: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut, enoent })
    }

    const timer = setTimeout(() => {
      timedOut = true
      void killTree(child).finally(() => finish(null, false))
    }, timeoutMs)

    child.once('error', (error: NodeJS.ErrnoException) => {
      finish(null, error.code === 'ENOENT')
    })
    child.once('close', (code) => finish(code, false))
  })
}

const inflight = new Map<string, Promise<SimulatorToolPaths>>()

async function installTool(
  spec: ToolSpec,
  paths: SimulatorToolPaths,
  env: NodeJS.ProcessEnv,
): Promise<SimulatorToolPaths> {
  if (await isInstalled(paths, spec.version)) return paths

  const parentDir = path.dirname(paths.installDir)
  await rm(paths.installDir, { recursive: true, force: true })
  await mkdir(parentDir, { recursive: true })
  const stagingDir = await mkdtemp(path.join(parentDir, '.staging-'))

  try {
    const installArgs = [
      'install',
      '--prefix',
      stagingDir,
      '--no-fund',
      '--no-audit',
      `${spec.name}@${spec.version}`,
    ]
    let result = await runInstallCommand('npm', installArgs, INSTALL_TIMEOUT_MS, env)
    if (result.enoent) {
      result = await runInstallCommand(
        'pnpm',
        ['--package=npm@11', 'dlx', 'npm', ...installArgs],
        INSTALL_TIMEOUT_MS,
        env,
      )
      if (result.enoent) {
        throw new Error(
          'Simulator support needs npm, which is not on PATH. Install Node.js (with npm) and retry.',
        )
      }
    }
    if (result.timedOut) {
      throw new Error(`Installing ${spec.name}@${spec.version} timed out.`)
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim()
      const tail = detail ? `: ${detail.slice(-400)}` : ''
      throw new Error(
        `Installing ${spec.name}@${spec.version} failed (exit code ${result.code})${tail}`,
      )
    }
    const stagedEntry = path.join(stagingDir, 'node_modules', spec.name, ...spec.entry)
    if (!(await fileExists(stagedEntry))) {
      throw new Error(`Installed ${spec.name}@${spec.version} is missing its entry point.`)
    }
    await writeFile(path.join(stagingDir, '.install-complete'), `${spec.version}\n`, 'utf8')
    try {
      await rename(stagingDir, paths.installDir)
    } catch (error) {
      if (!(await isInstalled(paths, spec.version))) throw error
    }
    return paths
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function ensureTool(
  baseDir: string,
  spec: ToolSpec,
  env: NodeJS.ProcessEnv,
): Promise<SimulatorToolPaths> {
  const paths = toolPaths(baseDir, spec)
  const key = `${spec.name}@${spec.version}\0${baseDir}`
  const existing = inflight.get(key)
  if (existing) return existing
  const promise = installTool(spec, paths, env).finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key)
  })
  inflight.set(key, promise)
  return promise
}

export function ensureDeviceHub(
  baseDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SimulatorToolPaths> {
  return ensureTool(baseDir, HUB_SPEC, env)
}

export function ensureAgentDevice(
  baseDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SimulatorToolPaths> {
  return ensureTool(baseDir, AGENT_DEVICE_SPEC, env)
}

export async function pruneOldSimulatorTools(
  baseDir: string,
  kind: 'hub' | 'agent',
): Promise<void> {
  const spec = kind === 'hub' ? HUB_SPEC : AGENT_DEVICE_SPEC
  const root = path.join(baseDir, 'tools', spec.name)
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter((entry) => entry !== spec.version && SEMVER_DIR.test(entry))
      .map((entry) => rm(path.join(root, entry), { recursive: true, force: true }).catch(() => {})),
  )
}

async function inspectTool(
  baseDir: string,
  spec: ToolSpec,
  runningVersion: string | null,
): Promise<SimulatorToolVersion> {
  const root = path.join(baseDir, 'tools', spec.name)
  let names: string[] = []
  try {
    names = await readdir(root)
  } catch {
    names = []
  }
  const installedVersions: string[] = []
  for (const name of names) {
    if (!SEMVER_DIR.test(name)) continue
    const candidate = toolPaths(baseDir, { ...spec, version: name })
    if (await isInstalled(candidate, name)) installedVersions.push(name)
  }
  installedVersions.sort()
  return {
    requiredVersion: spec.version,
    installedVersions,
    runningVersion,
  }
}

export async function inspectSimulatorToolVersions(
  baseDir: string,
  running: { hub?: string | null; agent?: string | null } = {},
): Promise<SimulatorToolVersions> {
  const [hub, agent] = await Promise.all([
    inspectTool(baseDir, HUB_SPEC, running.hub ?? null),
    inspectTool(baseDir, AGENT_DEVICE_SPEC, running.agent ?? null),
  ])
  return { hub, agent }
}
