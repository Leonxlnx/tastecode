import { randomBytes, timingSafeEqual } from 'node:crypto'
import type {
  SimulatorActionInput,
  SimulatorAndroidSetupStatus,
  SimulatorDetail,
  SimulatorDevice,
  SimulatorHostStatus,
  SimulatorHubAccess,
  SimulatorNewOptions,
  SimulatorOpenedEvent,
  SimulatorPlatform,
  SimulatorSession,
  SimulatorState,
} from '@harness/contracts'
import { SIMULATOR_HUB_ROUTE_PREFIX } from '@harness/contracts'
import { z } from 'zod'
import { readSimulatorDetail, runSimulatorAction } from './actions.js'
import {
  agentDeviceConfigPath,
  agentDeviceQuickStart,
  agentDeviceSessionId,
  agentDeviceTargetArgs,
  bindAgentDeviceLauncher,
  pruneAgentDeviceLaunchers,
  removeAgentDeviceLauncher,
  writeAgentDeviceConfig,
} from './agent-shim.js'
import { LocalSimulatorHost, type ReadySimulatorHost } from './host.js'

const HUB_TICKET_TTL_MS = 30 * 60_000
const MAX_ACTIVE_TICKETS = 32

const PersistedSimulatorSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  agentAccessEnabled: z.boolean().default(false),
  onboardingCompleted: z.boolean().default(false),
})

export type PersistedSimulatorSettings = z.infer<typeof PersistedSimulatorSettingsSchema>

export type SimulatorSettingsStore = {
  read(): string | undefined
  write(value: string): void
}

export type SimulatorServiceOptions = {
  readonly dataRoot: string
  readonly settings: SimulatorSettingsStore
  readonly serverOrigin: () => { readonly httpOrigin: string; readonly wsOrigin: string }
  readonly onStateChanged?: (state: SimulatorState) => void
  readonly onOpened?: (event: SimulatorOpenedEvent) => void
  readonly onLog?: (line: string) => void
  readonly host?: LocalSimulatorHost
}

type ActiveTicket = {
  readonly token: string
  readonly expiresAt: number
}

export type AgentDeviceOpenResult = {
  readonly device: SimulatorDevice
  readonly agentDevice: {
    readonly command: string
    readonly targetArgs: readonly string[]
    readonly session: string
  }
  readonly quickStart: string
}

export class SimulatorService {
  readonly #dataRoot: string
  readonly #settingsStore: SimulatorSettingsStore
  readonly #serverOrigin: () => { readonly httpOrigin: string; readonly wsOrigin: string }
  readonly #onStateChanged: (state: SimulatorState) => void
  readonly #onOpened: (event: SimulatorOpenedEvent) => void
  readonly #host: LocalSimulatorHost

  #settings: PersistedSimulatorSettings
  #hostStatus: SimulatorHostStatus
  #hostStatusDetail: string | undefined
  #androidSetupStatus: SimulatorAndroidSetupStatus = 'idle'
  #androidSetupDetail: string | undefined
  #androidSetupInFlight: Promise<SimulatorState> | null = null
  #devices: SimulatorDevice[] = []
  #incompletePlatforms: SimulatorPlatform[] | undefined
  #sessions: SimulatorSession[] = []
  #agentLaunchers = new Map<string, string>()
  #tickets: ActiveTicket[] = []
  #revision = 0
  #cachedState: SimulatorState | undefined

  constructor(options: SimulatorServiceOptions) {
    this.#dataRoot = options.dataRoot
    this.#settingsStore = options.settings
    this.#serverOrigin = options.serverOrigin
    this.#onStateChanged = options.onStateChanged ?? (() => undefined)
    this.#onOpened = options.onOpened ?? (() => undefined)
    this.#host = options.host ?? new LocalSimulatorHost(options.dataRoot, options.onLog)
    this.#settings = this.#loadSettings()
    this.#hostStatus = this.#settings.enabled ? 'idle' : 'disabled'
  }

  get enabled(): boolean {
    return this.#settings.enabled
  }

  get agentAccessEnabled(): boolean {
    return this.#settings.enabled && this.#settings.agentAccessEnabled
  }

  currentHost(): ReadySimulatorHost | null {
    return this.#settings.enabled ? this.#host.current() : null
  }

  async state(): Promise<SimulatorState> {
    return this.#buildState()
  }

  async configure(input: {
    readonly enabled?: boolean | undefined
    readonly agentAccessEnabled?: boolean | undefined
    readonly onboardingCompleted?: boolean | undefined
  }): Promise<SimulatorState> {
    const previous = this.#settings
    const next: PersistedSimulatorSettings = {
      enabled: input.enabled ?? previous.enabled,
      agentAccessEnabled:
        input.enabled === false ? false : (input.agentAccessEnabled ?? previous.agentAccessEnabled),
      onboardingCompleted: input.onboardingCompleted ?? previous.onboardingCompleted,
    }
    this.#settings = next
    this.#saveSettings(next)

    if (!next.enabled) {
      await this.#closeAllSessions()
      await this.#host.disable()
      this.#devices = []
      this.#incompletePlatforms = undefined
      this.#hostStatus = 'disabled'
      this.#hostStatusDetail = undefined
      return this.#publishState()
    }

    if (previous.agentAccessEnabled && !next.agentAccessEnabled) {
      await this.#releaseAllAgentSessions()
      await this.#host.stopAgent()
    }

    const summary = await this.#host.summary()
    const anyPlatform = summary.platforms.some((platform) => platform.available)
    if (!anyPlatform) {
      this.#hostStatus = 'idle'
      this.#hostStatusDetail = undefined
      return this.#publishState()
    }

    try {
      if (next.agentAccessEnabled) {
        await this.#ensureAgentReady()
      } else {
        await this.#ensureHubReady()
      }
      await this.#refreshDeviceList()
    } catch (error) {
      this.#hostStatus = 'failed'
      this.#hostStatusDetail = error instanceof Error ? error.message : String(error)
      return this.#publishState()
    }

    return this.#publishState()
  }

  async list(): Promise<SimulatorState> {
    if (!this.#settings.enabled) {
      this.#hostStatus = 'disabled'
      this.#hostStatusDetail = undefined
      return this.#buildState()
    }
    const summary = await this.#host.summary()
    if (!summary.platforms.some((platform) => platform.available)) {
      this.#devices = []
      this.#hostStatus = 'idle'
      this.#hostStatusDetail = undefined
      return this.#publishState()
    }
    try {
      await this.#ensureHubReady()
      await this.#refreshDeviceList()
    } catch (error) {
      this.#hostStatus = 'failed'
      this.#hostStatusDetail = error instanceof Error ? error.message : String(error)
    }
    return this.#publishState()
  }

  async open(input: {
    readonly threadId: string
    readonly deviceId: string
    readonly platform?: SimulatorPlatform | undefined
    readonly openedBy?: 'user' | 'agent' | undefined
  }): Promise<{ readonly session: SimulatorSession; readonly device: SimulatorDevice }> {
    if (!this.#settings.enabled) {
      throw new Error('Simulator support is turned off. Enable it in the Simulator panel first.')
    }
    await this.#ensureHubReady()
    if (this.#devices.length === 0) {
      await this.#refreshDeviceList()
    }
    let device = this.#devices.find(
      (candidate) =>
        candidate.id === input.deviceId &&
        (input.platform === undefined || candidate.platform === input.platform),
    )
    if (!device) {
      await this.#refreshDeviceList()
      device = this.#devices.find(
        (candidate) =>
          candidate.id === input.deviceId &&
          (input.platform === undefined || candidate.platform === input.platform),
      )
    }
    if (!device) {
      throw new Error(
        `Simulator "${input.deviceId}" was not found. Refresh the device list and retry.`,
      )
    }

    let effectiveId = device.id
    if (!device.booted) {
      effectiveId = await this.#host.bootDevice(device)
      await this.#refreshDeviceList()
      const booted = sameDevice(this.#devices, device.platform, effectiveId, device.name)
      if (booted) {
        device = booted
        effectiveId = booted.id
      } else {
        device = { ...device, id: effectiveId, booted: true }
      }
    } else {
      await this.#host.attachDevice(device)
    }

    const openedBy = input.openedBy ?? 'user'
    const existingIndex = this.#sessions.findIndex(
      (entry) => entry.threadId === input.threadId && entry.deviceId === effectiveId,
    )
    const session: SimulatorSession = {
      threadId: input.threadId,
      deviceId: effectiveId,
      platform: device.platform,
      openedAt: Date.now(),
      openedBy,
    }
    if (existingIndex >= 0) {
      this.#sessions[existingIndex] = session
    } else {
      this.#sessions.push(session)
    }

    await this.#publishState()
    this.#onOpened({
      threadId: session.threadId,
      deviceId: device.id,
      platform: device.platform,
      name: device.name,
      openedBy,
    })
    return { session, device }
  }

  async close(input: {
    readonly threadId: string
    readonly deviceId?: string | undefined
    readonly shutdown?: boolean | undefined
  }): Promise<void> {
    const matching = this.#sessions.filter(
      (entry) =>
        entry.threadId === input.threadId &&
        (input.deviceId === undefined || entry.deviceId === input.deviceId),
    )
    if (matching.length === 0) {
      if (input.shutdown && input.deviceId) {
        await this.shutdown(input.deviceId)
      }
      return
    }
    const matchingKeys = new Set(matching.map((entry) => `${entry.threadId}\0${entry.deviceId}`))
    this.#sessions = this.#sessions.filter(
      (entry) => !matchingKeys.has(`${entry.threadId}\0${entry.deviceId}`),
    )
    for (const session of matching) {
      await this.#releaseAgentSessionFor(session.threadId, session.deviceId)
    }
    if (input.shutdown) {
      for (const session of matching) {
        const stillOpenElsewhere = this.#sessions.some(
          (other) => other.deviceId === session.deviceId,
        )
        if (!stillOpenElsewhere) {
          await this.shutdown(session.deviceId)
        }
      }
    }
    await this.#publishState()
  }

  async closeThreadSessions(threadId: string): Promise<void> {
    await this.close({ threadId })
  }

  async shutdown(deviceId: string): Promise<void> {
    if (!this.#settings.enabled) return
    await this.#ensureHubReady()
    const device = this.#devices.find((candidate) => candidate.id === deviceId)
    const sessionMatches = this.#sessions.filter((entry) => entry.deviceId === deviceId)
    const platform = device?.platform ?? sessionMatches[0]?.platform
    if (!platform) {
      throw new Error(`Simulator "${deviceId}" was not found.`)
    }
    this.#sessions = this.#sessions.filter((entry) => entry.deviceId !== deviceId)
    for (const session of sessionMatches) {
      await this.#releaseAgentSessionFor(session.threadId, session.deviceId)
    }
    await this.#host.shutdownDevice({ id: deviceId, platform })
    await this.#refreshDeviceList().catch(() => undefined)
    await this.#publishState()
  }

  async newOptions(): Promise<SimulatorNewOptions> {
    if (this.#settings.enabled) {
      await this.#ensureHubReady().catch(() => undefined)
    }
    return this.#host.newDeviceOptions()
  }

  async create(input: {
    readonly platform: SimulatorPlatform
    readonly name: string
    readonly runtime: string
    readonly deviceType: string
    readonly boot?: boolean | undefined
  }): Promise<{ readonly device: SimulatorDevice; readonly state: SimulatorState }> {
    if (this.#settings.enabled) {
      await this.#ensureHubReady()
    }
    const device = await this.#host.createDevice(input)
    if (this.#settings.enabled) {
      await this.#refreshDeviceList().catch(() => undefined)
    }
    const state = await this.#publishState()
    const refreshed = sameDevice(state.devices, device.platform, device.id, device.name) ?? device
    return { device: refreshed, state }
  }

  async remove(input: {
    readonly platform: SimulatorPlatform
    readonly deviceId: string
    readonly name?: string | undefined
  }): Promise<SimulatorState> {
    const existing = this.#devices.find(
      (candidate) => candidate.platform === input.platform && candidate.id === input.deviceId,
    )
    const sessionMatches = this.#sessions.filter(
      (entry) => entry.platform === input.platform && entry.deviceId === input.deviceId,
    )
    this.#sessions = this.#sessions.filter(
      (entry) => !(entry.platform === input.platform && entry.deviceId === input.deviceId),
    )
    for (const session of sessionMatches) {
      await this.#releaseAgentSessionFor(session.threadId, session.deviceId)
    }
    await this.#host.removeDevice({
      platform: input.platform,
      deviceId: input.deviceId,
      name: input.name ?? existing?.name,
    })
    if (this.#settings.enabled && this.#host.current()) {
      await this.#refreshDeviceList().catch(() => undefined)
    } else {
      this.#devices = this.#devices.filter(
        (candidate) => !(candidate.platform === input.platform && candidate.id === input.deviceId),
      )
    }
    return this.#publishState()
  }

  async installAndroid(input: {
    readonly systemImage?: string | undefined
    readonly sdkRoot?: string | undefined
    readonly createDefaultAvd?: boolean | undefined
  }): Promise<SimulatorState> {
    if (this.#androidSetupInFlight) {
      throw new Error('An Android SDK operation is already in progress.')
    }
    const run = (async (): Promise<SimulatorState> => {
      this.#androidSetupStatus = 'installing'
      this.#androidSetupDetail = 'Preparing Android Emulator installation…'
      await this.#publishState()
      let lastPublishAt = Date.now()
      try {
        await this.#host.installAndroidSupport({
          systemImage: input.systemImage,
          sdkRoot: input.sdkRoot,
          createDefaultAvd: input.createDefaultAvd,
          onProgress: (detail) => {
            this.#androidSetupDetail = detail
            const now = Date.now()
            if (now - lastPublishAt >= 500) {
              lastPublishAt = now
              void this.#publishState()
            }
          },
        })
        this.#androidSetupStatus = 'idle'
        this.#androidSetupDetail = undefined
        if (this.#settings.enabled) {
          if (this.#settings.agentAccessEnabled) {
            await this.#ensureAgentReady().catch(() => undefined)
          } else {
            await this.#ensureHubReady().catch(() => undefined)
          }
          await this.#refreshDeviceList().catch(() => undefined)
        }
        return await this.#publishState()
      } catch (error) {
        this.#androidSetupStatus = 'failed'
        this.#androidSetupDetail = error instanceof Error ? error.message : String(error)
        await this.#publishState()
        throw error
      }
    })()

    this.#androidSetupInFlight = run
    try {
      return await run
    } finally {
      if (this.#androidSetupInFlight === run) this.#androidSetupInFlight = null
    }
  }

  async uninstallAndroidImage(packageId: string): Promise<SimulatorState> {
    if (this.#androidSetupInFlight) {
      throw new Error('An Android SDK operation is already in progress.')
    }
    const run = (async (): Promise<SimulatorState> => {
      this.#androidSetupStatus = 'removing'
      this.#androidSetupDetail = `Removing ${packageId}…`
      await this.#publishState()
      try {
        await this.#host.uninstallAndroidImage(packageId)
        this.#androidSetupStatus = 'idle'
        this.#androidSetupDetail = undefined
        if (this.#settings.enabled && this.#host.current()) {
          await this.#refreshDeviceList().catch(() => undefined)
        }
        return await this.#publishState()
      } catch (error) {
        this.#androidSetupStatus = 'failed'
        this.#androidSetupDetail = error instanceof Error ? error.message : String(error)
        await this.#publishState()
        throw error
      }
    })()

    this.#androidSetupInFlight = run
    try {
      return await run
    } finally {
      if (this.#androidSetupInFlight === run) this.#androidSetupInFlight = null
    }
  }

  async detail(deviceId: string): Promise<SimulatorDetail> {
    if (!this.#settings.enabled) {
      throw new Error('Simulator support is turned off.')
    }
    const host = await this.#ensureHubReady()
    const device = this.#devices.find((candidate) => candidate.id === deviceId)
    const platform =
      device?.platform ?? this.#sessions.find((entry) => entry.deviceId === deviceId)?.platform
    if (!platform) throw new Error(`Simulator "${deviceId}" was not found.`)
    return readSimulatorDetail(host, deviceId, platform)
  }

  async action(input: SimulatorActionInput): Promise<SimulatorDetail> {
    if (!this.#settings.enabled) {
      throw new Error('Simulator support is turned off.')
    }
    const host = await this.#ensureHubReady()
    const device = this.#devices.find((candidate) => candidate.id === input.deviceId)
    const platform =
      device?.platform ??
      this.#sessions.find((entry) => entry.deviceId === input.deviceId)?.platform
    if (!platform) throw new Error(`Simulator "${input.deviceId}" was not found.`)
    return runSimulatorAction(host, platform, input)
  }

  async screenshot(
    deviceId: string,
  ): Promise<{ readonly device: SimulatorDevice; readonly png: Uint8Array }> {
    if (!this.#settings.enabled) {
      throw new Error('Simulator support is turned off.')
    }
    await this.#ensureHubReady()
    let device = this.#devices.find((candidate) => candidate.id === deviceId)
    if (!device) {
      await this.#refreshDeviceList()
      device = this.#devices.find((candidate) => candidate.id === deviceId)
    }
    if (!device) throw new Error(`Simulator "${deviceId}" was not found.`)
    const png = await this.#host.screenshotDevice(device)
    return { device, png }
  }

  sessionsForThread(threadId: string): SimulatorSession[] {
    return this.#sessions.filter((entry) => entry.threadId === threadId)
  }

  /** Agent MCP `device_open`: opens device in panel, starts agent-device daemon, writes bound launcher. */
  async agentOpen(input: {
    readonly threadId: string
    readonly deviceId?: string | undefined
    readonly platform?: SimulatorPlatform | undefined
  }): Promise<AgentDeviceOpenResult> {
    if (!this.#settings.enabled) {
      throw new Error(
        'Simulator support is off. Ask the user to enable it in the Simulator panel before starting simulators.',
      )
    }
    if (!this.#settings.agentAccessEnabled) {
      throw new Error(
        'Agent simulator access is turned off. Ask the user to enable "Allow agents to control simulators" in Settings → Simulator or the Simulator panel.',
      )
    }
    const ready = await this.#ensureAgentReady()
    await this.#refreshDeviceList()

    let target: SimulatorDevice | undefined
    if (input.deviceId !== undefined) {
      target = this.#devices.find(
        (candidate) =>
          candidate.id === input.deviceId &&
          (input.platform === undefined || candidate.platform === input.platform),
      )
      if (!target) {
        throw new Error(
          `No simulator "${input.deviceId}" was found. Call device_list for current ids.`,
        )
      }
    } else {
      const candidates = this.#devices.filter(
        (candidate) => input.platform === undefined || candidate.platform === input.platform,
      )
      if (candidates.length === 0) {
        throw new Error(
          input.platform
            ? `No ${input.platform} simulators were found. Call device_list to see why.`
            : 'No simulators or emulators were found. Call device_list to see why.',
        )
      }
      const platforms = new Set(candidates.map((candidate) => candidate.platform))
      if (input.platform === undefined && platforms.size > 1) {
        throw new Error('Both iOS and Android devices are available; pass platform or deviceId.')
      }
      target = candidates.find((candidate) => candidate.booted) ?? candidates[0]!
    }

    const opened = await this.open({
      threadId: input.threadId,
      deviceId: target.id,
      platform: target.platform,
      openedBy: 'agent',
    })

    const configPath = agentDeviceConfigPath(this.#dataRoot, 'local')
    await writeAgentDeviceConfig(configPath, ready.agentDevice)
    const session = agentDeviceSessionId(input.threadId, opened.device.id)
    const targetArgs = [
      ...agentDeviceTargetArgs(opened.device),
      '--config',
      configPath,
      '--session',
      session,
    ]
    const command = await bindAgentDeviceLauncher({
      dataRoot: this.#dataRoot,
      entryPath: ready.agentDevice.entryPath,
      session,
      targetArgs,
    })
    this.#agentLaunchers.set(session, command)
    return {
      device: opened.device,
      agentDevice: { command, targetArgs, session },
      quickStart: agentDeviceQuickStart(opened.device, command),
    }
  }

  async agentScreenshot(input: {
    readonly threadId: string
    readonly deviceId?: string | undefined
  }): Promise<{ readonly device: SimulatorDevice; readonly png: Uint8Array }> {
    const threadSessions = this.sessionsForThread(input.threadId)
    const session =
      input.deviceId === undefined
        ? threadSessions.at(-1)
        : threadSessions.find((entry) => entry.deviceId === input.deviceId)
    if (!session) {
      throw new Error(
        input.deviceId === undefined
          ? 'No simulator is open in this thread. Call device_open first.'
          : `Simulator "${input.deviceId}" is not open in this thread. Call device_open first.`,
      )
    }
    return this.screenshot(session.deviceId)
  }

  mintHubAccess(): SimulatorHubAccess {
    const now = Date.now()
    this.#tickets = this.#tickets.filter((entry) => entry.expiresAt > now)
    const token = randomBytes(32).toString('base64url')
    const expiresAt = now + HUB_TICKET_TTL_MS
    this.#tickets.push({ token, expiresAt })
    if (this.#tickets.length > MAX_ACTIVE_TICKETS) {
      this.#tickets.splice(0, this.#tickets.length - MAX_ACTIVE_TICKETS)
    }
    const { httpOrigin, wsOrigin } = this.#serverOrigin()
    return {
      httpBase: `${httpOrigin}${SIMULATOR_HUB_ROUTE_PREFIX}`,
      wsBase: `${wsOrigin}${SIMULATOR_HUB_ROUTE_PREFIX}`,
      ticket: token,
      expiresAt,
    }
  }

  verifyHubTicket(candidate: string | null | undefined): boolean {
    if (!candidate) return false
    const now = Date.now()
    this.#tickets = this.#tickets.filter((entry) => entry.expiresAt > now)
    const supplied = Buffer.from(candidate)
    for (const active of this.#tickets) {
      const expected = Buffer.from(active.token)
      if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) {
        return true
      }
    }
    return false
  }

  async dispose(): Promise<void> {
    this.#tickets = []
    await this.#releaseAllAgentSessions()
    await pruneAgentDeviceLaunchers(this.#dataRoot, new Set()).catch(() => undefined)
    await this.#host.stop()
  }

  #loadSettings(): PersistedSimulatorSettings {
    const raw = this.#settingsStore.read()
    if (!raw) return { enabled: false, agentAccessEnabled: false, onboardingCompleted: false }
    try {
      return PersistedSimulatorSettingsSchema.parse(JSON.parse(raw))
    } catch {
      return { enabled: false, agentAccessEnabled: false, onboardingCompleted: false }
    }
  }

  #saveSettings(settings: PersistedSimulatorSettings): void {
    this.#settingsStore.write(JSON.stringify(settings))
  }

  async #ensureHubReady(): Promise<ReadySimulatorHost> {
    const ready = await this.#host.ensureReady((phase, detail) => {
      this.#hostStatus = phase
      this.#hostStatusDetail = detail
      void this.#publishState()
    })
    this.#hostStatus = 'ready'
    return ready
  }

  async #ensureAgentReady(): Promise<
    ReadySimulatorHost & { readonly agentDevice: NonNullable<ReadySimulatorHost['agentDevice']> }
  > {
    const ready = await this.#host.ensureAgentReady((phase, detail) => {
      this.#hostStatus = phase
      this.#hostStatusDetail = detail
      void this.#publishState()
    })
    this.#hostStatus = 'ready'
    return ready
  }

  async #refreshDeviceList(): Promise<void> {
    const listed = await this.#host.listDevices()
    this.#devices = listed.devices
    this.#hostStatusDetail = listed.detail
    this.#incompletePlatforms = listed.incompletePlatforms
  }

  async #releaseAgentSessionFor(threadId: string, deviceId: string): Promise<void> {
    const session = agentDeviceSessionId(threadId, deviceId)
    const hadLauncher = this.#agentLaunchers.delete(session)
    if (hadLauncher) {
      await this.#host.releaseAgentSession(session).catch(() => undefined)
    }
    await removeAgentDeviceLauncher(this.#dataRoot, session)
  }

  async #releaseAllAgentSessions(): Promise<void> {
    const sessions = [...this.#agentLaunchers.keys()]
    this.#agentLaunchers.clear()
    await Promise.allSettled(
      sessions.map(async (session) => {
        await this.#host.releaseAgentSession(session).catch(() => undefined)
        await removeAgentDeviceLauncher(this.#dataRoot, session)
      }),
    )
  }

  async #closeAllSessions(): Promise<void> {
    this.#sessions = []
    await this.#releaseAllAgentSessions()
  }

  async #buildState(): Promise<SimulatorState> {
    const summary = await this.#host.summary()
    const state: SimulatorState = {
      enabled: this.#settings.enabled,
      agentAccessEnabled: this.#settings.agentAccessEnabled,
      onboardingCompleted: this.#settings.onboardingCompleted,
      hostStatus: this.#hostStatus,
      ...(this.#hostStatusDetail ? { hostStatusDetail: this.#hostStatusDetail } : {}),
      platforms: summary.platforms,
      hubInstalled: summary.hubInstalled,
      agentDeviceInstalled: summary.agentDeviceInstalled,
      tools: summary.tools,
      androidSdk: summary.androidSdk,
      androidSetupStatus: this.#androidSetupStatus,
      ...(this.#androidSetupDetail ? { androidSetupDetail: this.#androidSetupDetail } : {}),
      devices: [...this.#devices],
      sessions: [...this.#sessions],
      hubBasePath: SIMULATOR_HUB_ROUTE_PREFIX,
      ...(this.#incompletePlatforms && this.#incompletePlatforms.length > 0
        ? { incompletePlatforms: [...this.#incompletePlatforms] }
        : {}),
      revision: this.#revision,
    }
    this.#cachedState = state
    return state
  }

  async #publishState(): Promise<SimulatorState> {
    this.#revision += 1
    const state = await this.#buildState()
    this.#onStateChanged(state)
    return state
  }

  get cachedState(): SimulatorState | undefined {
    return this.#cachedState
  }
}

/**
 * The listed device a host operation answered with. Its id decides; the name
 * stands in only when no device has that id (a platform that changes the id
 * at boot) and exactly one device of the platform has the name, booted first,
 * so a namesake on another runtime is never taken for it.
 */
function sameDevice(
  devices: readonly SimulatorDevice[],
  platform: SimulatorPlatform,
  id: string,
  name: string,
): SimulatorDevice | undefined {
  const onPlatform = devices.filter((candidate) => candidate.platform === platform)
  const exact = onPlatform.find((candidate) => candidate.id === id)
  if (exact) return exact
  const named = onPlatform.filter((candidate) => candidate.name === name)
  const booted = named.filter((candidate) => candidate.booted)
  if (booted.length === 1) return booted[0]
  return booted.length === 0 && named.length === 1 ? named[0] : undefined
}
