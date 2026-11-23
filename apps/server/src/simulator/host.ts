import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  access,
  constants,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type {
  SimulatorAndroidSdk,
  SimulatorDevice,
  SimulatorNewOptions,
  SimulatorPlatform,
  SimulatorPlatformAvailability,
  SimulatorToolVersions,
} from '@harness/contracts'
import { killTree, locateCommand, spawnCli } from '@harness/proc'
import { z } from 'zod'
import {
  acceptAndroidSdkLicenses,
  ANDROID_SYSTEM_IMAGE_PATTERN,
  buildAndroidEnv,
  createAndroidAvd,
  defaultAndroidSdkRoot,
  deleteAndroidAvd,
  inspectAndroidSdkDetails,
  installAndroidCmdlineTools,
  installAndroidPackages,
  listAndroidDeviceProfiles,
  listAndroidSystemImages,
  recommendedAndroidSystemImage,
  resolveJavaHome,
  sanitizeAvdName,
  uninstallAndroidSystemImage,
} from './android-sdk.js'
import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from './tool-versions.js'
import {
  agentDeviceStateDir,
  ensureAgentDevice,
  ensureDeviceHub,
  inspectSimulatorToolVersions,
  installedAgentDeviceEntry,
  isAgentDeviceInstalled,
  isDeviceHubInstalled,
  pruneOldSimulatorTools,
  resolveNodeExecutable,
  type SimulatorToolPaths,
} from './toolchain.js'

const HUB_READY_TIMEOUT_MS = 30_000
const DAEMON_READY_TIMEOUT_MS = 30_000
const DAEMON_POLL_MS = 100
const HUB_RESTART_STABLE_UPTIME_MS = 60_000
const HUB_RESTART_MAX_DELAY_MS = 30_000
const LIST_TIMEOUT_MS = 40_000
const BOOT_TIMEOUT_MS = 180_000
const SCREENSHOT_TIMEOUT_MS = 20_000
const ACTION_TIMEOUT_MS = 20_000

const SIMULATOR_LIST_FAILED =
  /^\[apple-utils\] (?:Failed to (?:run `xcrun simctl list devices|parse JSON output:|list devices:)|`xcrun simctl list devices --json` did not respond within )/
const AVDMANAGER_LIST_FAILED = '[android-utils] Failed to run `avdmanager list avd`'
const GETPROP_LINE = /^\[([^\]]+)\]: \[(.*)\]$/

const HubStateFileSchema = z.object({
  pid: z.number().int(),
  port: z.number().int(),
  entryPath: z.string(),
})

const AgentDeviceDaemonFileSchema = z.object({
  httpPort: z.number().int(),
  token: z.string(),
  pid: z.number().int().optional(),
  version: z.string().optional(),
})

const HubDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  platform: z.enum(['ios', 'android']),
  booted: z.boolean(),
  physical: z.boolean(),
})

const HubDeviceListSchema = z.object({
  simulators: z.array(HubDeviceSchema),
  emulators: z.array(HubDeviceSchema),
  errors: z.array(z.object({ message: z.string(), error: z.string().optional() })).optional(),
})

const HubActionResultSchema = z.object({
  ok: z.boolean(),
  id: z.string().optional(),
  serial: z.string().optional(),
  error: z.string().optional(),
  errors: z.array(z.object({ message: z.string(), error: z.string().optional() })).optional(),
})

const HubNewOptionsSchema = z.object({
  ios: z.object({
    runtimes: z.array(
      z.object({
        value: z.string(),
        label: z.string(),
        models: z.array(
          z.object({
            value: z.string(),
            label: z.string(),
            supported: z.boolean().optional(),
          }),
        ),
      }),
    ),
  }),
  android: z.object({
    runtimes: z.array(
      z.object({
        value: z.string(),
        label: z.string(),
        models: z.array(
          z.object({
            value: z.string(),
            label: z.string(),
            supported: z.boolean().optional(),
          }),
        ),
      }),
    ),
  }),
  errors: z.array(z.object({ message: z.string(), error: z.string().optional() })).optional(),
})

export type HostRunResult = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export type HostHelpers = {
  readonly serveSimAxSettings: string | null
  readonly serveSimCli: string | null
}

export type AgentDaemonEndpoint = {
  readonly baseUrl: string
  readonly token: string
  readonly entryPath: string
}

export type SimulatorHostSummary = {
  readonly platforms: SimulatorPlatformAvailability[]
  readonly hubInstalled: boolean
  readonly agentDeviceInstalled: boolean
  readonly tools: SimulatorToolVersions
  readonly androidSdk: SimulatorAndroidSdk
}

export type SimulatorListResult = {
  readonly devices: SimulatorDevice[]
  readonly detail?: string
  readonly incompletePlatforms?: SimulatorPlatform[]
}

export type ReadySimulatorHost = {
  readonly origin: string
  readonly helpers: HostHelpers
  readonly agentDevice: AgentDaemonEndpoint | null
  readonly run: (
    command: string,
    args: string[],
    options?: { timeoutMs?: number; stdin?: string; maxOutputBytes?: number },
  ) => Promise<HostRunResult>
}

type AndroidSdkInfo = {
  readonly root: string | null
  readonly adb: boolean
  readonly emulator: boolean
  readonly avdmanager: boolean
  readonly legacyAvdmanager: boolean
}

type HubProcess = {
  readonly child: ChildProcessWithoutNullStreams
  readonly origin: string
  readonly port: number
  readonly entryPath: string
  readonly startedAt: number
  readonly nodeExecutable: string
  readonly nodeEnv: NodeJS.ProcessEnv
  readonly helpers: HostHelpers
  stoppedByUs: boolean
}

function boundDiagnostics(text: string): string {
  return text.length > 2_000 ? `${text.slice(0, 1_999)}…` : text
}

function errorHead(error: string): string {
  const lines = error.split(/\r?\n/)
  const firstFrame = lines.findIndex((line) => /^\s+at /.test(line))
  return (firstFrame === -1 ? lines : lines.slice(0, firstFrame))
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
}

function vendorPrefix(platform: SimulatorPlatform): string {
  return platform === 'ios' ? '/vendor/serve-sim' : '/vendor/serve-emu'
}

function runsOnXcode26Runtime(version: string): boolean {
  const match = /^iOS (\d+)/.exec(version)
  return match !== null && Number(match[1]) <= 26
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((closeError) => {
        if (closeError) reject(closeError)
        else if (!address || typeof address === 'string')
          reject(new Error('Could not reserve port'))
        else resolve(address.port)
      })
    })
  })
}

async function waitForHttpReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErrorDetail = 'timeout'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
      lastErrorDetail = `HTTP ${response.status}`
    } catch (error) {
      lastErrorDetail = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Simulator hub did not become ready in time (${lastErrorDetail}).`)
}

export async function inspectAndroidSdk(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<AndroidSdkInfo> {
  const windows = platform === 'win32'
  const home = env['HOME'] ?? env['USERPROFILE'] ?? os.homedir()
  const explicit = [env['ANDROID_HOME']?.trim(), env['ANDROID_SDK_ROOT']?.trim()].filter(
    (root): root is string => Boolean(root),
  )
  const adbBinary = windows ? 'adb.exe' : 'adb'
  const emulatorBinary = windows ? 'emulator.exe' : 'emulator'
  const avdmanagerBinary = windows ? 'avdmanager.bat' : 'avdmanager'

  const inspect = async (root: string): Promise<AndroidSdkInfo> => {
    const [adb, emulator, avdmanager] = await Promise.all([
      fileExists(path.join(root, 'platform-tools', adbBinary)),
      fileExists(path.join(root, 'emulator', emulatorBinary)),
      fileExists(path.join(root, 'cmdline-tools', 'latest', 'bin', avdmanagerBinary)),
    ])
    const legacyAvdmanager =
      !avdmanager && (await fileExists(path.join(root, 'tools', 'bin', avdmanagerBinary)))
    return { root, adb, emulator, avdmanager, legacyAvdmanager }
  }

  const candidates = [
    ...explicit,
    path.join(home, 'Library', 'Android', 'sdk'),
    path.join(home, 'Android', 'Sdk'),
    path.join(env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local'), 'Android', 'Sdk'),
  ]
  for (const root of candidates) {
    const sdk = await inspect(root)
    if (sdk.adb || sdk.emulator || sdk.avdmanager) return sdk
  }

  const searchPath = env['PATH'] ?? env['Path'] ?? ''
  for (const directory of searchPath.split(windows ? ';' : ':')) {
    if (!directory) continue
    const adb = path.join(directory, adbBinary)
    if (!(await fileExists(adb))) continue
    const resolved = await realpath(adb).catch(() => adb)
    const sdk = await inspect(path.dirname(path.dirname(resolved)))
    if (sdk.adb || sdk.emulator || sdk.avdmanager) return sdk
  }

  if (explicit[0]) return inspect(explicit[0])
  return { root: null, adb: false, emulator: false, avdmanager: false, legacyAvdmanager: false }
}

function hostEnvWithAndroidSdk(
  env: NodeJS.ProcessEnv,
  sdkRoot: string | null,
  javaHome: string | null = null,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return buildAndroidEnv(env, sdkRoot, javaHome, platform)
}

function runHostCommandBinary(
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv
    timeoutMs?: number
    maxOutputBytes?: number
  },
): Promise<{ readonly code: number; readonly stdout: Buffer; readonly stderr: string }> {
  const timeoutMs = options.timeoutMs ?? SCREENSHOT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? 32 * 1024 * 1024
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnCli(command, args, { env: options.env })
    } catch (error) {
      resolve({
        code: 127,
        stdout: Buffer.alloc(0),
        stderr: error instanceof Error ? error.message : String(error),
      })
      return
    }
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let capturedBytes = 0
    let settled = false

    child.stdout.on('data', (chunk: Buffer) => {
      if (capturedBytes >= maxOutputBytes) return
      const remaining = maxOutputBytes - capturedBytes
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      stdoutChunks.push(slice)
      capturedBytes += slice.length
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrChunks.length < 64) stderrChunks.push(chunk)
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end()

    const finish = (code: number, fallbackStderr?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString('utf8') || (fallbackStderr ?? ''),
      })
    }

    const timer = setTimeout(() => {
      void killTree(child).finally(() => finish(124, `Command timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.once('error', (error: Error) => finish(127, error.message))
    child.once('close', (code) => finish(code ?? 1))
  })
}

function runHostCommand(
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv
    timeoutMs?: number
    stdin?: string
    maxOutputBytes?: number
  },
): Promise<HostRunResult> {
  const timeoutMs = options.timeoutMs ?? ACTION_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnCli(command, args, { env: options.env })
    } catch (error) {
      resolve({
        code: 127,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      })
      return
    }
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let capturedBytes = 0
    let settled = false

    const pushChunk = (target: Buffer[], chunk: Buffer) => {
      if (capturedBytes >= maxOutputBytes) return
      const remaining = maxOutputBytes - capturedBytes
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      target.push(slice)
      capturedBytes += slice.length
    }

    child.stdout.on('data', (chunk: Buffer) => pushChunk(stdoutChunks, chunk))
    child.stderr.on('data', (chunk: Buffer) => pushChunk(stderrChunks, chunk))
    child.stdin.on('error', () => undefined)
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin, 'utf8')
    } else {
      child.stdin.end()
    }

    const finish = (code: number, fallbackStderr?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8') || (fallbackStderr ?? '')
      resolve({ code, stdout, stderr })
    }

    const timer = setTimeout(() => {
      void killTree(child).finally(() => finish(124, `Command timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.once('error', (error: Error) => finish(127, error.message))
    child.once('close', (code) => finish(code ?? 1))
  })
}

async function fetchJson<T>(
  url: string,
  schema: z.ZodType<T>,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const { timeoutMs = 15_000, ...rest } = init ?? {}
  const response = await fetch(url, {
    ...rest,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
  }
  const raw: unknown = await response.json()
  return schema.parse(raw)
}

export class LocalSimulatorHost {
  #hub: HubProcess | null = null
  #agentDevice: AgentDaemonEndpoint | null = null
  #restartDelayMs = 0
  #restartTimer: ReturnType<typeof setTimeout> | undefined
  #startLock: Promise<unknown> = Promise.resolve()
  #disposed = false

  constructor(
    private readonly dataRoot: string,
    private readonly onLog: (line: string) => void = () => undefined,
  ) {}

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#startLock.then(operation, operation)
    this.#startLock = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async platformAvailability(platform: SimulatorPlatform): Promise<SimulatorPlatformAvailability> {
    if (platform === 'ios') {
      if (process.platform !== 'darwin') {
        return { platform, available: false, reason: 'iOS Simulators need macOS with Xcode.' }
      }
      const xcrun = await locateCommand('xcrun')
      if (!xcrun) {
        return { platform, available: false, reason: 'Xcode command line tools were not found.' }
      }
      return { platform, available: true }
    }

    const sdk = await inspectAndroidSdk()
    if (!sdk.root) {
      return {
        platform,
        available: false,
        reason:
          'Android SDK is not installed yet. Click Install Android Emulator to set it up automatically.',
      }
    }
    if (!sdk.adb) {
      return {
        platform,
        available: false,
        reason: `Android SDK Platform-Tools are missing from ${sdk.root}. Click Install Android Emulator to add them.`,
      }
    }
    if (!sdk.emulator) {
      return {
        platform,
        available: false,
        reason: `Android Emulator is missing from ${sdk.root}. Click Install Android Emulator to add it.`,
      }
    }
    if (!sdk.avdmanager) {
      return {
        platform,
        available: false,
        reason: sdk.legacyAvdmanager
          ? `The Android SDK command-line tools in ${sdk.root} are outdated. Click Install Android Emulator to update them.`
          : `Android SDK Command-line Tools are missing from ${sdk.root}. Click Install Android Emulator to set them up.`,
      }
    }
    return { platform, available: true }
  }

  async summary(): Promise<SimulatorHostSummary> {
    const sdk = await inspectAndroidSdk()
    const [ios, android, hubInstalled, agentDeviceInstalled, daemon, androidSdk] =
      await Promise.all([
        this.platformAvailability('ios'),
        this.platformAvailability('android'),
        isDeviceHubInstalled(this.dataRoot),
        isAgentDeviceInstalled(this.dataRoot),
        this.#readDaemonFile(),
        inspectAndroidSdkDetails(sdk.root),
      ])
    const hubAlive = Boolean(
      this.#hub && this.#hub.child.exitCode === null && !this.#hub.child.killed,
    )
    const agentAlive = Boolean(
      this.#agentDevice && daemon?.pid !== undefined && isProcessAlive(daemon.pid),
    )
    const tools = await inspectSimulatorToolVersions(this.dataRoot, {
      hub: hubAlive ? DEVICE_HUB_VERSION : null,
      agent: agentAlive ? (daemon?.version ?? AGENT_DEVICE_VERSION) : null,
    })
    return {
      platforms: [ios, android],
      hubInstalled,
      agentDeviceInstalled,
      tools,
      androidSdk,
    }
  }

  current(): ReadySimulatorHost | null {
    if (!this.#hub || this.#hub.child.exitCode !== null) return null
    return {
      origin: this.#hub.origin,
      helpers: this.#hub.helpers,
      agentDevice: this.#agentDevice,
      run: (command, args, options) => this.run(command, args, options),
    }
  }

  async run(
    command: string,
    args: string[],
    options?: { timeoutMs?: number; stdin?: string; maxOutputBytes?: number },
  ): Promise<HostRunResult> {
    const [sdk, java] = await Promise.all([inspectAndroidSdk(), resolveJavaHome()])
    const env = hostEnvWithAndroidSdk(process.env, sdk.root, java.javaHome)
    const resolvedCommand =
      command === 'emulator' && sdk.root
        ? path.join(
            sdk.root,
            'emulator',
            process.platform === 'win32' ? 'emulator.exe' : 'emulator',
          )
        : command
    return runHostCommand(resolvedCommand, args, { ...options, env })
  }

  ensureReady(
    onPhase: (phase: 'installing' | 'starting', detail?: string) => void = () => undefined,
  ): Promise<ReadySimulatorHost> {
    return this.#serialized(() => this.#ensureHubReady(onPhase))
  }

  ensureAgentReady(
    onPhase: (phase: 'installing' | 'starting', detail?: string) => void = () => undefined,
  ): Promise<ReadySimulatorHost & { readonly agentDevice: AgentDaemonEndpoint }> {
    return this.#serialized(async () => {
      const ready = await this.#ensureHubReady(onPhase)
      if (this.#agentDevice) {
        const alive = await this.#isDaemonAlive(this.#agentDevice.baseUrl)
        if (alive) return { ...ready, agentDevice: this.#agentDevice }
      }
      const installed = await isAgentDeviceInstalled(this.dataRoot)
      if (!installed) {
        onPhase('installing', `Installing agent-device@${AGENT_DEVICE_VERSION}…`)
      }
      const agentTool = await ensureAgentDevice(this.dataRoot)
      onPhase('starting', 'Starting simulator agent daemon…')
      const hub = this.#hub!
      const endpoint = await this.#startAgentDeviceDaemon(
        agentTool.entryPath,
        hub.nodeExecutable,
        hub.nodeEnv,
      )
      await pruneOldSimulatorTools(this.dataRoot, 'agent').catch(() => undefined)
      this.#agentDevice = endpoint
      return { ...ready, agentDevice: endpoint }
    })
  }

  stopAgent(): Promise<void> {
    return this.#serialized(async () => {
      await this.#stopAgentDeviceDaemon()
      this.#agentDevice = null
    })
  }

  stop(): Promise<void> {
    return this.#serialized(async () => {
      this.#disposed = true
      if (this.#restartTimer !== undefined) {
        clearTimeout(this.#restartTimer)
        this.#restartTimer = undefined
      }
      const hub = this.#hub
      this.#hub = null
      this.#agentDevice = null
      await Promise.allSettled([this.#stopHubProcess(hub), this.#stopAgentDeviceDaemon()])
    })
  }

  /** Stops processes without marking the host permanently disposed (e.g., user turns off support). */
  disable(): Promise<void> {
    return this.#serialized(async () => {
      if (this.#restartTimer !== undefined) {
        clearTimeout(this.#restartTimer)
        this.#restartTimer = undefined
      }
      const hub = this.#hub
      this.#hub = null
      this.#agentDevice = null
      await Promise.allSettled([this.#stopHubProcess(hub), this.#stopAgentDeviceDaemon()])
    })
  }

  async listDevices(): Promise<SimulatorListResult> {
    const ready = this.current()
    if (!ready) throw new Error('Simulator hub is not running.')
    let hubList: z.infer<typeof HubDeviceListSchema>
    try {
      hubList = await fetchJson(`${ready.origin}/api/devices`, HubDeviceListSchema, {
        timeoutMs: LIST_TIMEOUT_MS,
      })
    } catch (error) {
      const platforms = await Promise.all([
        this.platformAvailability('ios'),
        this.platformAvailability('android'),
      ])
      return {
        devices: [],
        detail:
          error instanceof Error
            ? `Could not list devices from the simulator hub: ${error.message}`
            : 'The simulator hub did not answer in time.',
        incompletePlatforms: platforms
          .filter((entry) => entry.available)
          .map((entry) => entry.platform),
      }
    }

    const devices: SimulatorDevice[] = [...hubList.simulators, ...hubList.emulators]
    const [androidAvail, androidSdk] = await Promise.all([
      this.platformAvailability('android'),
      inspectAndroidSdk(),
    ])
    const androidAvailable = androidAvail.available
    const androidCanList = androidAvailable || (androidSdk.adb && androidSdk.emulator)
    const warnings = (hubList.errors ?? []).filter(
      (entry) =>
        !(!androidAvailable && entry.message.startsWith('[android-utils] ')) &&
        !(
          entry.message.startsWith('[apple-utils] Failed to read CoreSimulator plist at ') &&
          /\/CoreSimulator\/Devices\/[^/]+\/device\.plist:$/.test(entry.message) &&
          /(?:^Error:\s*ENOENT:|\bcode:\s*['"]ENOENT['"])/.test(entry.error ?? '')
        ),
    )
    const details = warnings.map((entry) => {
      const head = errorHead(entry.error ?? '')
      return boundDiagnostics(head ? `${entry.message} ${head}` : entry.message)
    })

    const incompletePlatforms: SimulatorPlatform[] = []
    if (androidCanList) {
      if (
        (hubList.errors ?? []).some((entry) => entry.message.startsWith(AVDMANAGER_LIST_FAILED)) ||
        !androidAvailable
      ) {
        const adbDevices = await this.#listAdbDevices()
        if (adbDevices === undefined) {
          incompletePlatforms.push('android')
          details.push('Could not list Android devices (adb devices -l).')
        } else {
          for (const candidate of adbDevices) {
            if (
              !devices.some((device) => device.platform === 'android' && device.id === candidate.id)
            ) {
              devices.push(candidate)
            }
          }
        }
      }
      const avds = await this.run('emulator', ['-list-avds'])
      if (avds.code !== 0) {
        if (!incompletePlatforms.includes('android')) incompletePlatforms.push('android')
        details.push(
          `Could not list Android virtual devices (emulator -list-avds, exit code ${avds.code}).`,
        )
      } else {
        for (const name of avds.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)) {
          if (!devices.some((device) => device.platform === 'android' && device.name === name)) {
            devices.push({
              id: name,
              name,
              platform: 'android',
              version: 'Android',
              booted: false,
              physical: false,
            })
          }
        }
      }
    }

    if (
      hubList.simulators.length === 0 &&
      (hubList.errors ?? []).some((entry) => SIMULATOR_LIST_FAILED.test(entry.message))
    ) {
      incompletePlatforms.push('ios')
    }

    return {
      devices,
      ...(details.length > 0 ? { detail: details.join('\n') } : {}),
      ...(incompletePlatforms.length > 0 ? { incompletePlatforms } : {}),
    }
  }

  async bootDevice(device: Pick<SimulatorDevice, 'id' | 'name' | 'platform'>): Promise<string> {
    const ready = this.current()
    if (!ready) throw new Error('Simulator hub is not running.')
    const result = await fetchJson(`${ready.origin}/api/devices/boot`, HubActionResultSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: device.platform, id: device.id, name: device.name }),
      timeoutMs: BOOT_TIMEOUT_MS,
    })
    if (!result.ok) {
      const diagnostics = [
        result.error,
        ...(result.errors ?? []).flatMap((entry) => [entry.message, entry.error]),
      ]
        .filter((text): text is string => Boolean(text?.trim()))
        .join('\n\n')
      throw new Error(
        diagnostics
          ? `Could not boot ${device.name}: ${boundDiagnostics(diagnostics)}`
          : `Could not boot ${device.name}.`,
      )
    }
    if (device.platform === 'ios') {
      await this.#attachIosStream(ready.origin, device.id)
    }
    return result.serial ?? result.id ?? device.id
  }

  async attachDevice(device: Pick<SimulatorDevice, 'id' | 'platform'>): Promise<void> {
    const ready = this.current()
    if (!ready) throw new Error('Simulator hub is not running.')
    if (device.platform === 'ios') {
      await this.#attachIosStream(ready.origin, device.id)
    }
  }

  async shutdownDevice(device: Pick<SimulatorDevice, 'id' | 'platform'>): Promise<void> {
    const ready = this.current()
    if (!ready) throw new Error('Simulator hub is not running.')
    if (device.platform === 'ios') {
      try {
        const result = await fetchJson(
          `${ready.origin}${vendorPrefix('ios')}/grid/api/shutdown`,
          HubActionResultSchema,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ udid: device.id }),
            timeoutMs: 30_000,
          },
        )
        if (!result.ok) throw new Error(result.error ?? 'Could not shut down simulator.')
      } catch (error) {
        const listed = await this.listDevices().catch(() => undefined)
        const current = listed?.devices.find((candidate) => candidate.id === device.id)
        if (current && !current.booted) return
        throw error
      }
      return
    }

    const result = await fetchJson(`${ready.origin}/api/devices/shutdown`, HubActionResultSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: device.platform, id: device.id }),
      timeoutMs: 30_000,
    })
    if (!result.ok) throw new Error(result.error ?? 'Could not shut down emulator.')
  }

  async screenshotDevice(
    device: Pick<SimulatorDevice, 'id' | 'platform' | 'version'>,
  ): Promise<Uint8Array> {
    const ready = this.current()
    if (!ready) throw new Error('Simulator hub is not running.')
    const url = `${ready.origin}${vendorPrefix(device.platform)}/api/screenshot?device=${encodeURIComponent(device.id)}`
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(SCREENSHOT_TIMEOUT_MS),
      })
      if (response.ok) {
        return new Uint8Array(await response.arrayBuffer())
      }
      if (device.platform === 'ios' && runsOnXcode26Runtime(device.version)) {
        return await this.#fallbackIosScreenshot(device.id)
      }
      if (device.platform === 'android') {
        return await this.#fallbackAndroidScreenshot(device.id)
      }
      throw new Error(`Screenshot failed with HTTP ${response.status}.`)
    } catch (error) {
      if (device.platform === 'ios' && runsOnXcode26Runtime(device.version)) {
        return await this.#fallbackIosScreenshot(device.id)
      }
      if (device.platform === 'android') {
        return await this.#fallbackAndroidScreenshot(device.id)
      }
      throw error
    }
  }

  async newDeviceOptions(): Promise<SimulatorNewOptions> {
    const ready = this.current()
    let iosRuntimes: SimulatorNewOptions['ios']['runtimes'] = []
    let androidRuntimes: SimulatorNewOptions['android']['runtimes'] = []
    const errors: string[] = []

    if (ready) {
      try {
        const hubOptions = await fetchJson(
          `${ready.origin}/api/new-device-options`,
          HubNewOptionsSchema,
          { timeoutMs: LIST_TIMEOUT_MS },
        )
        iosRuntimes = hubOptions.ios.runtimes.map((runtime) => ({
          value: runtime.value,
          label: runtime.label,
          models: runtime.models.map((model) => ({
            value: model.value,
            label: model.label,
            supported: model.supported !== false,
          })),
        }))
        androidRuntimes = hubOptions.android.runtimes.map((runtime) => ({
          value: runtime.value,
          label: runtime.label,
          models: runtime.models.map((model) => ({
            value: model.value,
            label: model.label,
            supported: model.supported !== false,
          })),
        }))
        for (const err of hubOptions.errors ?? []) {
          if (err.message) errors.push(err.message)
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }

    // Fallback/augment Android options directly from local SDK system-images and avdmanager profiles.
    if (androidRuntimes.length === 0) {
      const [sdk, java] = await Promise.all([inspectAndroidSdk(), resolveJavaHome()])
      if (sdk.root) {
        const images = (await listAndroidSystemImages(sdk.root)).filter((item) => item.installed)
        if (images.length > 0) {
          const env = hostEnvWithAndroidSdk(process.env, sdk.root, java.javaHome)
          const profiles = await listAndroidDeviceProfiles(sdk.root, env)
          androidRuntimes = images.map((image) => ({
            value: image.packageId,
            label: image.label,
            models: profiles,
          }))
        }
      }
    }

    return {
      ios: { runtimes: iosRuntimes },
      android: { runtimes: androidRuntimes },
      errors,
    }
  }

  async createDevice(input: {
    readonly platform: SimulatorPlatform
    readonly name: string
    readonly runtime: string
    readonly deviceType: string
    readonly boot?: boolean | undefined
  }): Promise<SimulatorDevice> {
    if (input.platform === 'ios') {
      if (process.platform !== 'darwin') {
        throw new Error('iOS Simulators can only be created on macOS.')
      }
      const created = await this.run('xcrun', [
        'simctl',
        'create',
        input.name.trim(),
        input.deviceType.trim(),
        input.runtime.trim(),
      ])
      if (created.code !== 0) {
        const detail = created.stderr.trim() || created.stdout.trim()
        throw new Error(
          `Could not create iOS Simulator "${input.name}" (exit ${created.code})${detail ? `: ${detail.slice(-300)}` : ''}`,
        )
      }
      const udid = created.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? ''
      if (!udid) throw new Error('xcrun simctl create did not return a simulator UDID.')
      let booted = false
      if (input.boot && this.current()) {
        await this.bootDevice({ id: udid, name: input.name.trim(), platform: 'ios' })
        booted = true
      }
      const listed = this.current() ? await this.listDevices().catch(() => undefined) : undefined
      const found = listed?.devices.find((d) => d.id === udid && d.platform === 'ios')
      return (
        found ?? {
          id: udid,
          name: input.name.trim(),
          platform: 'ios',
          version: input.runtime
            .replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '')
            .replaceAll('-', ' '),
          booted,
          physical: false,
        }
      )
    }

    const [sdk, java] = await Promise.all([inspectAndroidSdk(), resolveJavaHome()])
    if (!sdk.root || !sdk.avdmanager) {
      throw new Error(
        'Android SDK Command-line Tools are not installed. Click Install Android Emulator first.',
      )
    }
    const env = hostEnvWithAndroidSdk(process.env, sdk.root, java.javaHome)
    const avdName = await createAndroidAvd({
      sdkRoot: sdk.root,
      name: input.name,
      packageId: input.runtime,
      deviceProfile: input.deviceType,
      env,
    })

    let effectiveId = avdName
    let booted = false
    if (input.boot && this.current()) {
      effectiveId = await this.bootDevice({ id: avdName, name: avdName, platform: 'android' })
      booted = true
    }
    const listed = this.current() ? await this.listDevices().catch(() => undefined) : undefined
    const found = listed?.devices.find(
      (d) => d.platform === 'android' && (d.id === effectiveId || d.name === avdName),
    )
    const apiMatch = /android-(\d+)/.exec(input.runtime)
    return (
      found ?? {
        id: effectiveId,
        name: avdName,
        platform: 'android',
        version: apiMatch?.[1] ? `Android API ${apiMatch[1]}` : 'Android',
        booted,
        physical: false,
      }
    )
  }

  async removeDevice(input: {
    readonly platform: SimulatorPlatform
    readonly deviceId: string
    readonly name?: string | undefined
  }): Promise<void> {
    if (input.platform === 'ios') {
      if (process.platform !== 'darwin') {
        throw new Error('iOS Simulators can only be removed on macOS.')
      }
      // Best-effort shutdown before deletion.
      if (this.current()) {
        await this.shutdownDevice({ id: input.deviceId, platform: 'ios' }).catch(() => undefined)
      } else {
        await this.run('xcrun', ['simctl', 'shutdown', input.deviceId]).catch(() => undefined)
      }
      const deleted = await this.run('xcrun', ['simctl', 'delete', input.deviceId])
      if (deleted.code !== 0) {
        const detail = deleted.stderr.trim() || deleted.stdout.trim()
        throw new Error(
          `Could not remove iOS Simulator "${input.name ?? input.deviceId}" (exit ${deleted.code})${detail ? `: ${detail.slice(-300)}` : ''}`,
        )
      }
      return
    }

    const [sdk, java] = await Promise.all([inspectAndroidSdk(), resolveJavaHome()])
    const env = hostEnvWithAndroidSdk(process.env, sdk.root, java.javaHome)
    let avdName = input.name?.trim()
    const isBootedSerial = input.deviceId.startsWith('emulator-')

    if (isBootedSerial) {
      if (!avdName) {
        const res = await this.run('adb', ['-s', input.deviceId, 'emu', 'avd', 'name'])
        avdName = res.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line && line !== 'OK' && !line.startsWith('KO'))
      }
      if (this.current()) {
        await this.shutdownDevice({ id: input.deviceId, platform: 'android' }).catch(
          () => undefined,
        )
      } else {
        await this.run('adb', ['-s', input.deviceId, 'emu', 'kill']).catch(() => undefined)
      }
      // Wait briefly for the emulator process to release its AVD lock before deleting files.
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const check = await this.run('adb', ['devices'])
        if (!check.stdout.includes(input.deviceId)) break
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
    }

    const targetName = avdName || input.deviceId
    await deleteAndroidAvd({ sdkRoot: sdk.root, name: targetName, env })
  }

  async installAndroidSupport(input: {
    readonly systemImage?: string | undefined
    readonly sdkRoot?: string | undefined
    readonly createDefaultAvd?: boolean | undefined
    readonly onProgress?: (detail: string) => void
  }): Promise<void> {
    const java = await resolveJavaHome()
    if (!java.available || !java.javaHome) {
      throw new Error(
        java.reason ??
          'Java 17+ is required for Android SDK tools. Install OpenJDK or Android Studio.',
      )
    }

    const detected = await inspectAndroidSdk()
    const sdkRoot = input.sdkRoot?.trim() || detected.root || defaultAndroidSdkRoot()
    await mkdir(sdkRoot, { recursive: true })

    const selectedImage = input.systemImage?.trim()
    if (selectedImage && !ANDROID_SYSTEM_IMAGE_PATTERN.test(selectedImage)) {
      throw new Error(`Invalid Android system image "${selectedImage}".`)
    }

    const detailsBefore = await inspectAndroidSdkDetails(sdkRoot)
    if (!detailsBefore.cmdlineTools) {
      await installAndroidCmdlineTools(
        sdkRoot,
        input.onProgress ? { onProgress: input.onProgress } : {},
      )
    }

    const env = hostEnvWithAndroidSdk(process.env, sdkRoot, java.javaHome)
    input.onProgress?.('Accepting Android SDK licenses…')
    await acceptAndroidSdkLicenses(sdkRoot, env)

    const packages: string[] = []
    if (!detailsBefore.adb) packages.push('platform-tools')
    if (!detailsBefore.emulator) packages.push('emulator')

    const installedImages = detailsBefore.systemImages.filter((item) => item.installed)
    const imageToInstall =
      selectedImage ?? (installedImages.length === 0 ? recommendedAndroidSystemImage() : undefined)
    if (imageToInstall && !installedImages.some((item) => item.packageId === imageToInstall)) {
      packages.push(imageToInstall)
    }

    if (packages.length > 0) {
      await installAndroidPackages({
        sdkRoot,
        packages,
        env,
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      })
    }

    if (input.createDefaultAvd) {
      const avdList = await this.run('emulator', ['-list-avds'])
      const existingAvds = avdList.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      if (existingAvds.length === 0) {
        const afterImages = (await listAndroidSystemImages(sdkRoot)).filter(
          (item) => item.installed,
        )
        const chosenImage =
          (imageToInstall && afterImages.find((item) => item.packageId === imageToInstall)) ??
          afterImages[0]
        if (chosenImage) {
          input.onProgress?.('Creating default Android emulator…')
          const profiles = await listAndroidDeviceProfiles(sdkRoot, env)
          const preferred =
            profiles.find((p) => p.value === 'pixel_9') ??
            profiles.find((p) => p.value === 'pixel_8') ??
            profiles.find((p) => p.value === 'medium_phone') ??
            profiles[0]
          const defaultName = sanitizeAvdName(
            `${preferred?.label ?? 'Pixel'}_API_${chosenImage.apiLevel}`,
          )
          await createAndroidAvd({
            sdkRoot,
            name: defaultName,
            packageId: chosenImage.packageId,
            deviceProfile: preferred?.value ?? 'pixel_9',
            env,
          })
        }
      }
    }

    input.onProgress?.('Reloading simulator hub with Android SDK…')
    await this.restartHubIfRunning()
  }

  async uninstallAndroidImage(packageId: string): Promise<void> {
    const [sdk, java] = await Promise.all([inspectAndroidSdk(), resolveJavaHome()])
    const sdkRoot = sdk.root ?? defaultAndroidSdkRoot()
    const env = hostEnvWithAndroidSdk(process.env, sdkRoot, java.javaHome)
    await uninstallAndroidSystemImage({ sdkRoot, packageId, env })
  }

  restartHubIfRunning(): Promise<void> {
    return this.#serialized(async () => {
      // Stop any running agent-device daemon too so it restarts with updated ANDROID_HOME / PATH.
      if (this.#agentDevice) {
        await this.#stopAgentDeviceDaemon()
        this.#agentDevice = null
      }
      const existing = this.#hub
      if (!existing || this.#disposed) return
      const hubTool = await ensureDeviceHub(this.dataRoot, existing.nodeEnv)
      await this.#stopHubProcess(existing)
      this.#hub = null
      const replacement = await this.#spawnHub(hubTool, existing.nodeExecutable, existing.nodeEnv)
      this.#hub = replacement
      this.#restartDelayMs = 0
      this.#superviseHub(replacement, hubTool)
    })
  }

  async releaseAgentSession(session: string): Promise<void> {
    const endpoint = this.#agentDevice
    if (!endpoint) return
    try {
      const response = await fetch(`${endpoint.baseUrl}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${endpoint.token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: session,
          method: 'agent_device.command',
          params: { command: 'close', session, positionals: [], flags: {} },
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (response.status === 404 || response.ok) return
    } catch {
      // Best-effort cleanup when the daemon is already gone or shutting down.
    }
  }

  async #attachIosStream(origin: string, udid: string): Promise<void> {
    const result = await fetchJson(
      `${origin}${vendorPrefix('ios')}/grid/api/start`,
      HubActionResultSchema,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ udid }),
        timeoutMs: BOOT_TIMEOUT_MS,
      },
    )
    if (!result.ok) {
      throw new Error(result.error ?? 'Could not attach simulator video stream.')
    }
  }

  async #fallbackIosScreenshot(udid: string): Promise<Uint8Array> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tastecode-sim-shot-'))
    const filePath = path.join(dir, 'shot.png')
    try {
      const result = await this.run(
        'xcrun',
        ['simctl', 'io', udid, 'screenshot', '--type=png', filePath],
        {
          timeoutMs: SCREENSHOT_TIMEOUT_MS,
        },
      )
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `simctl screenshot failed (exit ${result.code}).`)
      }
      return new Uint8Array(await readFile(filePath))
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async #fallbackAndroidScreenshot(serial: string): Promise<Uint8Array> {
    const [sdk, java] = await Promise.all([inspectAndroidSdk(), resolveJavaHome()])
    const env = hostEnvWithAndroidSdk(process.env, sdk.root, java.javaHome)
    const result = await runHostCommandBinary(
      'adb',
      ['-s', serial, 'exec-out', 'screencap', '-p'],
      {
        env,
        timeoutMs: SCREENSHOT_TIMEOUT_MS,
      },
    )
    if (result.code !== 0 || result.stdout.length < 24) {
      throw new Error(result.stderr.trim() || `adb screencap failed (exit ${result.code}).`)
    }
    return new Uint8Array(result.stdout)
  }

  async #listAdbDevices(): Promise<SimulatorDevice[] | undefined> {
    const listed = await this.run('adb', ['devices', '-l'])
    if (listed.code !== 0) return undefined
    const serials = listed.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .flatMap(([serial, state]) => (serial && state === 'device' ? [serial] : []))
    const devices: SimulatorDevice[] = []
    for (const serial of serials) {
      const getprop = await this.run('adb', ['-s', serial, 'shell', 'getprop'])
      const props = new Map<string, string>()
      for (const line of getprop.stdout.split(/\r?\n/)) {
        const match = GETPROP_LINE.exec(line.trim())
        if (match?.[1] && match[2] !== undefined) props.set(match[1], match[2])
      }
      const emulator = props.get('ro.kernel.qemu') === '1' || props.get('ro.boot.qemu') === '1'
      let avdName: string | undefined
      if (emulator) {
        const avdResult = await this.run('adb', ['-s', serial, 'emu', 'avd', 'name'])
        avdName = avdResult.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line && line !== 'OK' && !line.startsWith('KO'))
      }
      const model = props.get('ro.product.model')
      const manufacturer = props.get('ro.product.manufacturer')
      const release = props.get('ro.build.version.release')
      devices.push({
        id: serial,
        name: emulator
          ? (avdName ?? serial)
          : model
            ? [manufacturer, model].filter(Boolean).join(' ')
            : serial,
        platform: 'android',
        version: release
          ? `Android ${/^\d+$/.test(release) ? `${release}.0` : release}`
          : 'Android',
        booted: true,
        physical: !emulator,
      })
    }
    return devices
  }

  #hubStatePath(): string {
    return path.join(agentDeviceStateDir(this.dataRoot), 'hub.json')
  }

  #daemonFilePath(): string {
    return path.join(agentDeviceStateDir(this.dataRoot), 'daemon.json')
  }

  async #readDaemonFile(): Promise<z.infer<typeof AgentDeviceDaemonFileSchema> | null> {
    try {
      const raw = await readFile(this.#daemonFilePath(), 'utf8')
      return AgentDeviceDaemonFileSchema.parse(JSON.parse(raw))
    } catch {
      return null
    }
  }

  async #isDaemonAlive(baseUrl: string): Promise<boolean> {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) })
      return response.status === 200
    } catch {
      return false
    }
  }

  async #reapStaleHub(): Promise<void> {
    try {
      const raw = await readFile(this.#hubStatePath(), 'utf8')
      const state = HubStateFileSchema.parse(JSON.parse(raw))
      if (isProcessAlive(state.pid)) {
        const ps = await runHostCommand('ps', ['-o', 'command=', '-p', String(state.pid)], {
          env: process.env,
          timeoutMs: 5_000,
        })
        if (ps.stdout.includes(state.entryPath)) {
          this.onLog(`Stopping orphaned simulator hub (pid ${state.pid}, port ${state.port})`)
          try {
            process.kill(state.pid, 'SIGTERM')
          } catch {
            // Already exited.
          }
        }
      }
    } catch {
      // No stale hub file or unreadable.
    }
    await rm(this.#hubStatePath(), { force: true }).catch(() => undefined)
  }

  async #hubEnvironment(baseEnv: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    const [sdk, java] = await Promise.all([inspectAndroidSdk(baseEnv), resolveJavaHome(baseEnv)])
    const env: NodeJS.ProcessEnv = {
      ...hostEnvWithAndroidSdk(baseEnv, sdk.root, java.javaHome),
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    }
    if (env['ANDROID_HOME']) {
      const emulator = path.join(
        env['ANDROID_HOME'],
        'emulator',
        process.platform === 'win32' ? 'emulator.exe' : 'emulator',
      )
      const overrides: string[] = []
      for (const facing of ['front', 'back'] as const) {
        const help = await runHostCommand(emulator, [`-help-camera-${facing}`], {
          env,
          timeoutMs: 5_000,
        })
        const text = `${help.stdout}\n${help.stderr}`
        if (help.code === 0 && /\bemulated\b/.test(text) && !/\bimagefile\b/.test(text)) {
          overrides.push(`-camera-${facing} emulated`)
        }
      }
      if (overrides.length > 0) {
        env['EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS'] = [
          overrides.join(' '),
          env['EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS'],
        ]
          .filter(Boolean)
          .join(' ')
      }
    }
    return env
  }

  async #helperPaths(hubTool: SimulatorToolPaths): Promise<HostHelpers> {
    const serveSimDist = path.join(
      hubTool.installDir,
      'node_modules',
      'expo-device-hub',
      'vendor',
      'serve-sim',
      'dist',
    )
    const axCandidate = path.join(serveSimDist, 'simax', 'serve-sim-ax-settings')
    const cliCandidate = path.join(serveSimDist, 'serve-sim.js')
    const [axExists, cliExists] = await Promise.all([
      fileExists(axCandidate),
      fileExists(cliCandidate),
    ])
    return {
      serveSimAxSettings: axExists ? axCandidate : null,
      serveSimCli: cliExists ? cliCandidate : null,
    }
  }

  async #ensureHubReady(
    onPhase: (phase: 'installing' | 'starting', detail?: string) => void,
  ): Promise<ReadySimulatorHost> {
    if (this.#disposed) throw new Error('Simulator host is closed.')
    if (this.#hub && this.#hub.child.exitCode === null) {
      return this.current()!
    }
    const { executable: nodeExecutable, env: nodeEnv } = await resolveNodeExecutable(process.env)
    const installed = await isDeviceHubInstalled(this.dataRoot)
    if (!installed) {
      onPhase('installing', `Installing expo-device-hub@${DEVICE_HUB_VERSION}…`)
    }
    const hubTool = await ensureDeviceHub(this.dataRoot, nodeEnv)
    onPhase('starting', 'Starting simulator hub…')
    const hub = await this.#spawnHub(hubTool, nodeExecutable, nodeEnv)
    await pruneOldSimulatorTools(this.dataRoot, 'hub').catch(() => undefined)
    this.#hub = hub
    this.#restartDelayMs = 0
    this.#superviseHub(hub, hubTool)
    return this.current()!
  }

  async #spawnHub(
    hubTool: SimulatorToolPaths,
    nodeExecutable: string,
    nodeEnv: NodeJS.ProcessEnv,
  ): Promise<HubProcess> {
    await this.#reapStaleHub()
    const stateDir = agentDeviceStateDir(this.dataRoot)
    await mkdir(stateDir, { recursive: true })
    const port = await reserveLoopbackPort()
    const origin = `http://127.0.0.1:${port}`
    const env = await this.#hubEnvironment(nodeEnv)
    const platformArgs = process.platform === 'darwin' ? [] : ['--platform', 'android']
    const child = spawnCli(
      nodeExecutable,
      [
        hubTool.entryPath,
        '--port',
        String(port),
        '--host',
        '127.0.0.1',
        '--hide-sidebar',
        '--hide-boot-device',
        ...platformArgs,
      ],
      { env },
    )
    child.stdin.on('error', () => undefined)
    child.stdin.end()
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) this.onLog(`[hub] ${line.trim()}`)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) this.onLog(`[hub] ${line.trim()}`)
      }
    })

    const spawnError = new Promise<never>((_, reject) => {
      child.once('error', (error) => reject(error))
      child.once('exit', (code, signal) =>
        reject(new Error(`Simulator hub exited early (code=${code}, signal=${signal}).`)),
      )
    })

    try {
      await Promise.race([waitForHttpReady(`${origin}/readyz`, HUB_READY_TIMEOUT_MS), spawnError])
    } catch (error) {
      await killTree(child).catch(() => undefined)
      throw error
    }

    const helpers = await this.#helperPaths(hubTool)
    const hub: HubProcess = {
      child,
      origin,
      port,
      entryPath: hubTool.entryPath,
      startedAt: Date.now(),
      nodeExecutable,
      nodeEnv,
      helpers,
      stoppedByUs: false,
    }
    if (child.pid !== undefined) {
      await writeFile(
        this.#hubStatePath(),
        JSON.stringify({ pid: child.pid, port, entryPath: hubTool.entryPath }),
        'utf8',
      ).catch(() => undefined)
    }
    this.onLog(`Simulator hub started on ${origin} (pid ${child.pid ?? 'unknown'})`)
    return hub
  }

  #superviseHub(hub: HubProcess, hubTool: SimulatorToolPaths): void {
    hub.child.once('exit', () => {
      if (hub.stoppedByUs || this.#disposed || this.#hub !== hub) return
      const uptime = Date.now() - hub.startedAt
      const delay =
        uptime >= HUB_RESTART_STABLE_UPTIME_MS
          ? 0
          : this.#restartDelayMs === 0
            ? 1_000
            : Math.min(this.#restartDelayMs * 2, HUB_RESTART_MAX_DELAY_MS)
      this.#restartDelayMs = delay
      this.onLog(`Simulator hub exited unexpectedly; restarting in ${delay}ms`)
      this.#restartTimer = setTimeout(() => {
        this.#restartTimer = undefined
        void this.#serialized(async () => {
          if (this.#disposed || this.#hub !== hub) return
          try {
            const replacement = await this.#spawnHub(hubTool, hub.nodeExecutable, hub.nodeEnv)
            this.#hub = replacement
            this.#superviseHub(replacement, hubTool)
          } catch (error) {
            this.onLog(
              `Simulator hub restart failed: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        })
      }, delay)
      this.#restartTimer.unref()
    })
  }

  async #stopHubProcess(hub: HubProcess | null): Promise<void> {
    if (!hub) return
    hub.stoppedByUs = true
    await killTree(hub.child).catch(() => undefined)
    await rm(this.#hubStatePath(), { force: true }).catch(() => undefined)
  }

  async #startAgentDeviceDaemon(
    entryPath: string,
    nodeExecutable: string,
    nodeEnv: NodeJS.ProcessEnv,
  ): Promise<AgentDaemonEndpoint> {
    const stateDir = agentDeviceStateDir(this.dataRoot)
    await mkdir(stateDir, { recursive: true })
    const existing = await this.#readDaemonFile()
    if (existing) {
      const baseUrl = `http://127.0.0.1:${existing.httpPort}`
      if (await this.#isDaemonAlive(baseUrl)) {
        return { baseUrl, token: existing.token, entryPath }
      }
      await rm(this.#daemonFilePath(), { force: true }).catch(() => undefined)
    }

    const [sdk, java] = await Promise.all([inspectAndroidSdk(nodeEnv), resolveJavaHome(nodeEnv)])
    const daemonEnv: NodeJS.ProcessEnv = {
      ...hostEnvWithAndroidSdk(nodeEnv, sdk.root, java.javaHome),
      AGENT_DEVICE_STATE_DIR: stateDir,
      AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
      AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    }
    const result = await runHostCommand(nodeExecutable, [entryPath, 'devices', '--json'], {
      env: daemonEnv,
      timeoutMs: DAEMON_READY_TIMEOUT_MS,
    })

    const started = await this.#readDaemonFile()
    if (started) {
      return { baseUrl: `http://127.0.0.1:${started.httpPort}`, token: started.token, entryPath }
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim()
      throw new Error(
        `Starting agent-device daemon failed (exit ${result.code})${detail ? `: ${detail.slice(-300)}` : ''}`,
      )
    }
    const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      const file = await this.#readDaemonFile()
      if (file) {
        return { baseUrl: `http://127.0.0.1:${file.httpPort}`, token: file.token, entryPath }
      }
      await new Promise((resolve) => setTimeout(resolve, DAEMON_POLL_MS))
    }
    throw new Error('Timed out waiting for agent-device daemon to start.')
  }

  async #stopAgentDeviceDaemon(): Promise<void> {
    const recorded = await this.#readDaemonFile()
    if (!recorded) return
    if (recorded.pid !== undefined && !isProcessAlive(recorded.pid)) {
      await rm(this.#daemonFilePath(), { force: true }).catch(() => undefined)
      return
    }
    const versions = [...(recorded.version ? [recorded.version] : []), AGENT_DEVICE_VERSION]
    const entryPath = await installedAgentDeviceEntry(this.dataRoot, versions)
    if (!entryPath) return
    try {
      const { executable, env } = await resolveNodeExecutable(process.env)
      await runHostCommand(
        executable,
        [entryPath, 'daemon', 'stop', '--state-dir', agentDeviceStateDir(this.dataRoot)],
        {
          env: { ...env, AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' },
          timeoutMs: 10_000,
        },
      )
    } catch {
      // Best-effort shutdown.
    }
  }
}
