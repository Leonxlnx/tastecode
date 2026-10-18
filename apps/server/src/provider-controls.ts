import type { CodexAdapter } from '@harness/adapter-codex'
import type {
  Account,
  McpCapabilities,
  McpServer,
  McpServerConfig,
  Model,
  ParamsOf,
  ProviderCommand,
  ProviderId,
  ProviderLimit,
  ProviderLimitSource,
  ResultOf,
  Skill,
  SkillCapabilities,
  SkillDiscoveryError,
  UsageReadIntent,
} from '@harness/contracts'
import { validateAcpMcpServer } from '@harness/adapter-acp/mcp'
import {
  CLAUDE_MCP_CAPABILITIES,
  validateClaudeMcpServer,
} from '@harness/adapter-claude-code/capabilities'
import { GROK_MCP_CAPABILITIES } from '@harness/adapter-grok/mcp'
import { OPENCODE_MCP_CAPABILITIES } from '@harness/adapter-opencode/inventory'
import { parseLimitSnapshot, serializeLimitSnapshot } from './limit-snapshot.js'
import type { ModelListRead } from './model-list-cache.js'
import { ProjectInventoryCache, type ProjectInventoryService } from './project-inventory-cache.js'
import { PROVIDER_CAPABILITIES, type ProviderControlCapabilities } from './provider-capabilities.js'
import { retryableLazy } from './retryable-lazy.js'
import { WatchLeases } from './watch-leases.js'

const loadCodex = retryableLazy(() => import('@harness/adapter-codex'))
const loadClaude = retryableLazy(() => import('@harness/adapter-claude-code'))
const loadCursor = retryableLazy(() => import('@harness/adapter-cursor'))
const loadGrok = retryableLazy(() => import('@harness/adapter-grok'))
const loadAcp = retryableLazy(() => import('@harness/adapter-acp'))
const loadAntigravity = retryableLazy(() => import('@harness/adapter-antigravity'))
const loadOpenCode = retryableLazy(() => import('@harness/adapter-opencode'))

export type ProviderLoginResult = {
  loginId: string | null
  success: boolean
  error: string | null
}
type LoginResponse = { loginId: string; authUrl?: string }
type LoginHandle = LoginResponse & { cancel: () => Promise<void> }
type LimitSource = { status: 'ready'; limits: ProviderLimit[] } | { status: 'unavailable' }
/**
 * The Codex control process serves no commands, so a `commands` watch holds no
 * process lease. It does watch a project inventory's configuration folders,
 * and services report command changes through `InventoryRead.changed`.
 */
type WatchTarget = ParamsOf<'providers.watch'>['targets'][number]

/** A provider's own MCP servers, before the project's TasteCode overrides. */
export type McpInventory = {
  capabilities: McpCapabilities
  servers: McpServer[]
  /** Still collecting; a change notification follows when it settles. */
  loading?: boolean
}
/** A live chat's answer; the provider's capabilities do not depend on it. */
export type ActiveMcpInventory = Omit<McpInventory, 'capabilities'>
export type CommandInventory = ResultOf<'commands.list'>
export type SkillInventory = {
  capabilities: SkillCapabilities
  skills: Skill[]
  errors: SkillDiscoveryError[]
}
/** What a service gets with each inventory read of one project. */
export type InventoryRead<Active> = {
  /** Reads a chat already running in the project, which costs no new process. */
  readActive?: (() => Promise<Active>) | undefined
  /** Reports that this project's answer changed after the read returned. */
  changed: () => void
}

/** Only this settings surface is required of an injected control process. */
export type CodexControlAdapter = Pick<
  CodexAdapter,
  | 'start'
  | 'dispose'
  | 'onUsageChanged'
  | 'account'
  | 'listModels'
  | 'listMcpServers'
  | 'isMcpLoading'
  | 'whenMcpServersListed'
  | 'listSkills'
  | 'setSkillEnabled'
  | 'rateLimitSource'
  | 'consumeRateLimitReset'
  | 'startLogin'
  | 'cancelLogin'
  | 'useApiKey'
  | 'signOut'
> & {
  on(event: 'log', listener: (line: string) => void): void
  on(event: 'login', listener: (result: ProviderLoginResult) => void): void
  on(event: 'skillsChanged' | 'mcpChanged' | 'disconnected', listener: () => void): void
}

/** Injectable readers keep auth tests independent of installed CLIs and credentials. */
export type ProviderServices = {
  validateMcpServer?: (server: McpServerConfig) => void
  account?: (agent?: string) => Promise<Account>
  usageLimitSource?: () => Promise<LimitSource>
  startLogin?: (
    onComplete: (result: ProviderLoginResult) => void,
  ) => LoginHandle | Promise<LoginHandle>
  signOut?: (agent?: string) => Promise<void>
  listMcpServers?: (
    projectPath: string,
    read: InventoryRead<ActiveMcpInventory>,
  ) => Promise<McpInventory>
  listCommands?: (
    projectPath: string,
    read: InventoryRead<ProviderCommand[]>,
  ) => Promise<CommandInventory>
  listSkills?: (projectPath: string, read: InventoryRead<never>) => Promise<SkillInventory>
  /** Commands and MCP servers of a project without a chat, cached; explicit readers above win. */
  projectInventory?: ProjectInventoryService
}

export type ProviderControl = {
  capabilities: ProviderControlCapabilities
  validateMcpServer?: (server: McpServerConfig) => void
  account(agent?: string): Promise<Account>
  /** Absent intent is treated as `visible`, as the contract asks of servers. */
  usageLimitSource(intent?: UsageReadIntent): Promise<ProviderLimitSource>
  /**
   * The held snapshot without reading; undefined until a read or live window
   * arrives. A view that shows the limits (any intent but `background`) also
   * gets the last session's full read until then, which the next read replaces.
   */
  heldLimitSource(intent?: UsageReadIntent): ProviderLimitSource | undefined
  signOut(agent?: string): Promise<void>
  watch(projectPath: string, targets: WatchTarget[]): { expiresInMs: number }
  listModels?: (agent?: string, read?: ModelListRead) => Promise<Model[]>
  listMcpServers?: (
    projectPath: string,
    readActive?: () => Promise<ActiveMcpInventory>,
  ) => Promise<McpInventory>
  listCommands?: (
    projectPath: string,
    readActive?: () => Promise<ProviderCommand[]>,
  ) => Promise<CommandInventory>
  listSkills?: (projectPath: string) => Promise<SkillInventory>
  setSkillEnabled?: (projectPath: string, skillId: string, enabled: boolean) => Promise<boolean>
  startLogin?: () => Promise<LoginResponse>
  cancelLogin?: (loginId: string) => Promise<void>
  useApiKey?: (apiKey: string) => Promise<Account>
  consumeRateLimitReset?: (
    idempotencyKey: string,
    creditId?: string,
  ) => Promise<{ outcome: 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed' }>
}

export type ProviderControlsOptions = {
  /** Runtime injection also handles custom harness model discovery. */
  listModels: (provider: ProviderId, agent?: string, read?: ModelListRead) => Promise<Model[]>
  onLog?: (provider: ProviderId, line: string) => void
  onLogin?: (provider: ProviderId, result: ProviderLoginResult) => void
  onUsageChanged?: (provider: ProviderId) => void
  /** A provider's held limits changed; `source` is the newest snapshot. */
  onLimitsChanged?: (provider: ProviderId, source: ProviderLimitSource) => void
  onMcpChanged?: (provider: ProviderId, projectPath: string) => void
  onSkillsChanged?: (provider: ProviderId, projectPath: string) => void
  onCommandsChanged?: (provider: ProviderId, projectPath: string) => void
  onAuthChanged?: (provider: ProviderId) => void
  controlIdleMs?: number
  /** How long an unanswered Codex MCP status load may keep the shared process. */
  mcpLoadHoldMs?: number
  watchTtlMs?: number
  loginTtlMs?: number
  /** How long a sign-in may take to return its URL before later auth work proceeds. */
  loginStartTimeoutMs?: number
  /** How long a successful limit read answers later reads without a change signal. */
  limitCacheMs?: number
  /** How long an account without plan limits keeps that answer through usage changes. */
  unavailableLimitCacheMs?: number
  /** Replaces every provider's declared `limitReadIntervalMs`. */
  limitReadIntervalMs?: number
  /** Minimum spacing of published limit snapshots per provider. */
  limitPublishIntervalMs?: number
  /** Minimum spacing of forwarded usage-change signals per provider. */
  limitChangeIntervalMs?: number
  /**
   * Waited on before a limit read that is not cached. Such a read can start a
   * vendor process, and the server holds it while a turn streams.
   */
  beforeLimitRead?: () => Promise<void>
  /** How long a signed-in account read answers later reads without starting the CLI again. */
  accountCacheMs?: number
  /** How long the last confirmed sign-in answers when a later account read fails. */
  accountFallbackMs?: number
  /**
   * Keeps each provider's last full limit read across restarts, so the first
   * view that shows the limits after a launch paints figures at once instead
   * of waiting seconds for a vendor process.
   */
  limitSnapshot?: { read: () => string | undefined; write: (value: string) => void }
  createCodex?: () => CodexControlAdapter | Promise<CodexControlAdapter>
  services?: Partial<Record<ProviderId, ProviderServices>>
}

type ProcessEntry = {
  creating: Promise<CodexControlAdapter>
  ready: Promise<CodexControlAdapter>
  closing: boolean
  stopped: boolean
  stopping?: Promise<void> | undefined
}
type LoginEntry = {
  loginId?: string
  cancel?: () => Promise<void>
  timer?: ReturnType<typeof setTimeout> | undefined
  expired: boolean
  canceled: boolean
  canceling?: Promise<void> | undefined
  earlyResults: ProviderLoginResult[]
}
type LimitEntry = {
  /** Bumped by every change so a read that started earlier cannot stay fresh. */
  version: number
  /** Bumped by a change that must reach the next read, such as a redeemed reset. */
  forcedVersion: number
  /** Bumped only when the account may have changed; usage changes leave it alone. */
  accountVersion: number
  /** Numbers reads in start order, so an older read never replaces a newer answer. */
  reads: number
  /** The number of the read behind `value`. */
  stored: number
  /** The last account read, which shows a sign-in or switch made outside the app. */
  account?: string | undefined
  value?: ProviderLimitSource | undefined
  /** When the read behind `value` started. */
  readAt: number
  freshUntil: number
  reading?: Promise<ProviderLimitSource> | undefined
  /** The last failed read; later reads reject with it until `retryAt`. */
  failure?: LimitFailure | undefined
  notifiedAt: number
  notifyTimer?: ReturnType<typeof setTimeout> | undefined
  /** Windows a live session reported, by id, so a read that started earlier cannot revert them. */
  live?: Map<string, { limit: ProviderLimit; at: number }> | undefined
  /** When a live session last reported windows, changed or not. */
  liveAt: number
  publishedAt: number
  publishTimer?: ReturnType<typeof setTimeout> | undefined
  /** The held read was a background one that left out details a shown view lists. */
  detailsOmitted?: boolean | undefined
}
type LimitFailure = { error: unknown; count: number; timeouts: number; retryAt: number }
type ReadyLimitSource = Extract<ProviderLimitSource, { status: 'ready' }>

const REFRESH_ERROR_LIMIT = 300
const REFRESH_ERROR_FALLBACK = 'Plan limits could not be refreshed.'
const NOT_READ_YET = 'Plan limits are read when you open them.'

/** A held source without the marks of an earlier failed refresh. */
function heldValues(source: ReadyLimitSource): ReadyLimitSource {
  const { stale: _stale, refreshError: _error, retryAt: _retryAt, ...values } = source
  return values
}

/** Live rows carry only the fields they know; the held row keeps the rest, such as a reset time. */
function mergeLimit(held: ProviderLimit, update: ProviderLimit): ProviderLimit {
  return { ...held, ...update }
}

/** A merged row keeps the held row's key order, so equal values serialize alike. */
function sameLimit(left: ProviderLimit, right: ProviderLimit): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** What a client shows of a source; when it was checked is not part of it. */
function shownLimits(source: ProviderLimitSource | undefined): string {
  return JSON.stringify(
    source?.status === 'ready' ? [source.limits, source.stale ?? false] : (source?.status ?? null),
  )
}

/** Overlays live windows newer than a read onto that read's rows. */
function withLiveWindows(
  limits: ProviderLimit[],
  live: Map<string, { limit: ProviderLimit; at: number }> | undefined,
  readStartedAt: number,
): ProviderLimit[] {
  if (!live?.size) return limits
  let merged = limits
  for (const [id, window] of live) {
    // The read already saw this window or something newer.
    if (window.at < readStartedAt) {
      live.delete(id)
      continue
    }
    const index = merged.findIndex((limit) => limit.id === id)
    if (index === -1) continue
    if (merged === limits) merged = [...limits]
    merged[index] = mergeLimit(merged[index]!, window.limit)
  }
  return merged
}

/**
 * The held values of a source whose newest refresh failed. They keep the
 * time they were read, so clients can say how old they are.
 */
function lastKnownLimits(held: ReadyLimitSource, failure: LimitFailure): ReadyLimitSource {
  return {
    ...heldValues(held),
    stale: true,
    refreshError: refreshErrorOf(failure),
    // A source that ran out of timeouts waits for an account change, not a time.
    ...(Number.isFinite(failure.retryAt) ? { retryAt: failure.retryAt } : {}),
  }
}

/** The stable, bounded text a client may show for a failed read. */
function refreshErrorOf(failure: LimitFailure): string {
  const message = failure.error instanceof Error ? failure.error.message.trim() : ''
  return message ? message.slice(0, REFRESH_ERROR_LIMIT) : REFRESH_ERROR_FALLBACK
}

/** Failed reads wait 5, 10 and 20 minutes, then every 30 minutes. */
const LIMIT_RETRY_MIN_MS = 5 * 60_000
const LIMIT_RETRY_MAX_MS = 30 * 60_000

function limitRetryDelay(failures: number): number {
  return Math.min(LIMIT_RETRY_MIN_MS * 2 ** (failures - 1), LIMIT_RETRY_MAX_MS)
}

/** Adapters mark a missed deadline with the platform's own error name. */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError'
}

/** Each failure doubles the wait; reaching the timeout limit ends retries for this account. */
function limitFailure(
  previous: LimitFailure | undefined,
  error: unknown,
  timeoutLimit: number | undefined,
): LimitFailure {
  const count = (previous?.count ?? 0) + 1
  const timeouts = (previous?.timeouts ?? 0) + (isTimeout(error) ? 1 : 0)
  return {
    error,
    count,
    timeouts,
    retryAt:
      timeoutLimit !== undefined && timeouts >= timeoutLimit
        ? Number.POSITIVE_INFINITY
        : Date.now() + limitRetryDelay(count),
  }
}
type AccountEntry = {
  /** The last read that answered; a failed read never replaces it. */
  value?: Account | undefined
  at: number
  reading?: Promise<Account> | undefined
}

const defaultServices = {
  antigravity: {
    account: async () => (await loadAntigravity()).antigravityAccount(),
    // agy keeps its Google sign-in in the OS keyring and drops it only from
    // its own TUI; doing nothing here would show a sign-out that never happened.
    signOut: async () => {
      throw new Error('Sign out of Antigravity in agy itself: run agy and enter /logout.')
    },
  },
  api: {},
  codex: {},
  opencode: {
    // OpenCode reports these from a running server. A project without a chat
    // starts one without a session (4-12 s), cached.
    projectInventory: {
      mcpCapabilities: OPENCODE_MCP_CAPABILITIES,
      skillCapabilities: { inventory: true, configure: false, install: false },
      discover: async (projectPath, options) =>
        (await loadOpenCode()).discoverOpenCodeProject(projectPath, options),
      watchPaths: async (projectPath) =>
        (await loadOpenCode()).openCodeInventoryWatchPaths(projectPath),
    },
    account: async () => (await loadOpenCode()).openCodeAccount(),
    // Being signed in means one or more connected model providers, each
    // removed on its own; signing out of all of them is not one action.
    signOut: async () => {
      throw new Error('To remove an OpenCode sign-in, run "opencode auth logout" in a terminal.')
    },
  },
  pi: {},
  'claude-code': {
    validateMcpServer: validateClaudeMcpServer,
    // Claude reports its commands and servers only from a running agent. A
    // project without a chat starts one without a prompt (10-15 s), cached.
    projectInventory: {
      mcpCapabilities: CLAUDE_MCP_CAPABILITIES,
      discover: async (projectPath, options) =>
        (await loadClaude()).discoverClaudeProject(projectPath, options),
      watchPaths: async (projectPath) =>
        (await loadClaude()).claudeInventoryWatchPaths(projectPath),
    },
    account: async () => (await loadClaude()).claudeAccount(),
    usageLimitSource: async () => (await loadClaude()).claudeLimitSource(),
    startLogin: async (complete) => (await loadClaude()).startClaudeLogin(complete),
    signOut: async () => (await loadClaude()).signOutClaude(),
  },
  cursor: {
    account: async () => (await loadCursor()).cursorAccount(),
    startLogin: async (complete) => (await loadCursor()).startCursorLogin(complete),
    signOut: async () => (await loadCursor()).signOutCursor(),
  },
  grok: {
    // Grok's MCP sessions run through ACP.
    validateMcpServer: validateAcpMcpServer,
    // Grok reports commands, skills and MCP status only from a session, and
    // its print-mode chats report none. A project without an ACP chat starts
    // one without a prompt (about 3 s), cached.
    projectInventory: {
      mcpCapabilities: GROK_MCP_CAPABILITIES,
      skillCapabilities: { inventory: true, configure: false, install: false },
      discover: async (projectPath, options) =>
        (await loadGrok()).discoverGrokProject(projectPath, options),
      watchPaths: async (projectPath) => (await loadGrok()).grokInventoryWatchPaths(projectPath),
    },
    account: async () => (await loadGrok()).grokAccount(),
    usageLimitSource: async () => (await loadGrok()).grokLimitSource(),
    signOut: async () => (await loadGrok()).signOutGrok(),
  },
  acp: {
    account: async (agent) => (agent ? (await loadAcp()).acpAccount(agent) : { signedIn: false }),
    signOut: async (agent) => {
      if (agent) await (await loadAcp()).acpSignOut(agent)
    },
  },
} satisfies Record<ProviderId, ProviderServices>

/** Vendor settings and the processes that serve them have one owner. */
export class ProviderControls {
  readonly #options: ProviderControlsOptions
  readonly #controls = new Map<ProviderId, ProviderControl>()
  readonly #owned = new Set<ProcessEntry>()
  readonly #logins = new Map<ProviderId, LoginEntry>()
  /** Starts that missed their deadline; their handle is canceled on arrival. */
  readonly #lateLogins = new Map<LoginEntry, ProviderId>()
  readonly #authQueues = new Map<ProviderId, Promise<void>>()
  readonly #skills: WatchLeases
  readonly #mcp: WatchLeases
  readonly #idleMs: number
  readonly #mcpLoadHoldMs: number
  readonly #mcpHolds = new Set<ReturnType<typeof setTimeout>>()
  readonly #loginTtlMs: number
  readonly #loginStartTimeoutMs: number
  readonly #limitCacheMs: number
  readonly #unavailableLimitCacheMs: number
  readonly #limitReadIntervalMs: number | undefined
  readonly #limitChangeIntervalMs: number
  readonly #limitPublishIntervalMs: number
  readonly #limits = new Map<ProviderId, LimitEntry>()
  /**
   * The last full read per provider, kept across restarts. Only views that
   * show the limits see it, and only until this session holds a value; a
   * passive figure never shows numbers this session has not confirmed.
   */
  #savedLimits: Map<ProviderId, ReadyLimitSource> | undefined
  readonly #accountCacheMs: number
  readonly #accountFallbackMs: number
  /** Keyed by provider and agent; an auth change deletes the provider's entries. */
  readonly #accounts = new Map<string, AccountEntry>()
  readonly #projectInventories = new Map<ProviderId, ProjectInventoryCache>()
  #shared: ProcessEntry | undefined
  #users = 0
  #idleTimer: ReturnType<typeof setTimeout> | undefined
  #watchTimer: ReturnType<typeof setTimeout> | undefined
  #closed = false
  #generation = 0
  #disposing: Promise<void> | undefined

  constructor(options: ProviderControlsOptions) {
    this.#options = options
    this.#idleMs = duration(options.controlIdleMs, 5_000, 0)
    this.#mcpLoadHoldMs = duration(options.mcpLoadHoldMs, 3 * 60_000, 1)
    this.#loginTtlMs = duration(options.loginTtlMs, 10 * 60_000, 1)
    this.#loginStartTimeoutMs = duration(options.loginStartTimeoutMs, 60_000, 1)
    // Each read starts a vendor process, and live windows from running
    // sessions keep held values current, so a full read answers 5 minutes.
    this.#limitCacheMs = duration(options.limitCacheMs, 5 * 60_000, 0)
    // An account without plan limits answers the same until it changes, and
    // Claude scans its local transcripts for up to a minute to say so. Every
    // turn reports a usage change, so only a longer, bounded cache stops each
    // turn from repeating that scan.
    this.#unavailableLimitCacheMs = duration(options.unavailableLimitCacheMs, 30 * 60_000, 0)
    this.#limitReadIntervalMs =
      options.limitReadIntervalMs === undefined
        ? undefined
        : duration(options.limitReadIntervalMs, 0, 0)
    // Codex reports its windows beside nearly every token update.
    this.#limitPublishIntervalMs = duration(options.limitPublishIntervalMs, 1_000, 0)
    this.#limitChangeIntervalMs = duration(options.limitChangeIntervalMs, 30_000, 0)
    // An account read starts the vendor CLI, which takes seconds on a busy
    // machine. App and Settings ask at once and again on every switch, so one
    // read serves them all, and a slow or failed read keeps the last sign-in
    // instead of reporting a signed-in account as unavailable.
    this.#accountCacheMs = duration(options.accountCacheMs, 60_000, 0)
    this.#accountFallbackMs = duration(options.accountFallbackMs, 30 * 60_000, 0)
    const watchTtlMs = duration(options.watchTtlMs, 60_000, 1)
    this.#skills = new WatchLeases(watchTtlMs)
    this.#mcp = new WatchLeases(watchTtlMs)
    for (const provider of Object.keys(PROVIDER_CAPABILITIES) as ProviderId[]) {
      this.#controls.set(provider, this.#makeControl(provider))
    }
  }

  forProvider(provider: ProviderId): ProviderControl {
    const control = this.#controls.get(provider)
    if (!control) throw new Error(`unknown provider "${provider}"`)
    return control
  }

  forgetProject(projectPath: string): void {
    for (const inventory of this.#projectInventories.values()) inventory.forget(projectPath)
    this.#skills.delete(projectPath)
    this.#mcp.delete(projectPath)
    this.#scheduleIdle()
  }

  /** A chat's last server list includes the project servers TasteCode gave it. */
  projectMcpConfigChanged(provider: ProviderId, projectPath: string): void {
    this.#projectInventories.get(provider)?.forgetLiveServers(projectPath)
  }

  /**
   * Marks cached limits stale and forwards the signal at a bounded rate: the
   * first change notifies at once, a burst after it collapses into one
   * trailing notification per interval. An `immediate` change, such as a
   * redeemed reset, also reaches the next limit read.
   */
  usageChanged(provider: ProviderId, immediate = false): void {
    if (this.#closed) return
    const entry = this.#invalidateLimits(provider, false, immediate)
    this.#notifyUsageChanged(provider, entry, immediate)
  }

  /** Forwards a usage-change signal: the first at once, a burst as one trailing signal. */
  #notifyUsageChanged(provider: ProviderId, entry: LimitEntry, immediate: boolean): void {
    const wait = immediate ? 0 : entry.notifiedAt + this.#limitChangeIntervalMs - Date.now()
    if (wait <= 0) {
      clearTimeout(entry.notifyTimer)
      entry.notifyTimer = undefined
      entry.notifiedAt = Date.now()
      this.#options.onUsageChanged?.(provider)
      return
    }
    if (entry.notifyTimer) return
    entry.notifyTimer = setTimeout(() => {
      entry.notifyTimer = undefined
      if (this.#limits.get(provider) !== entry || this.#closed) return
      entry.notifiedAt = Date.now()
      this.#options.onUsageChanged?.(provider)
    }, wait)
    entry.notifyTimer.unref?.()
  }

  /**
   * Folds plan-limit windows a live session reported into the held snapshot
   * by id. A known window takes the reported fields, other windows stay, and
   * rows without an id are left to full reads. When every row matches, the
   * snapshot stays the same object and nothing is published.
   */
  applyLimitRows(provider: ProviderId, rows: readonly ProviderLimit[]): void {
    if (this.#closed) return
    const entry = this.#limitEntry(provider)
    const held = entry.value
    // An account without plan limits keeps that answer until it changes.
    if (held?.status === 'unavailable') return
    const limits = held?.limits ?? []
    const now = Date.now()
    let next: ProviderLimit[] | undefined
    for (const row of rows) {
      if (row.id === undefined) continue
      // An unchanged window still confirms the held values are current.
      entry.liveAt = now
      const current = next ?? limits
      const index = current.findIndex((limit) => limit.id === row.id)
      const merged = index === -1 ? row : mergeLimit(current[index]!, row)
      if (index !== -1 && sameLimit(current[index]!, merged)) continue
      next ??= [...limits]
      if (index === -1) next.push(merged)
      else next[index] = merged
      entry.live ??= new Map()
      const seen = entry.live.get(row.id)
      entry.live.set(row.id, { limit: seen ? mergeLimit(seen.limit, row) : row, at: now })
    }
    if (!next) return
    // Live values are current, so they are no longer the last known ones.
    entry.value = held
      ? { ...heldValues(held), limits: next, checkedAt: now, origin: 'live' }
      : { provider, status: 'ready', limits: next, checkedAt: now, origin: 'live' }
    this.#publishLimits(provider, entry)
    // Clients that re-pull after a usage change see the merge without a new
    // read: the held value stays fresh, and the signal keeps its spacing.
    this.#notifyUsageChanged(provider, entry, false)
  }

  /** Failed cleanup retains ownership, so a subsequent call can retry it. */
  disposeAll(): Promise<void> {
    if (this.#disposing) return this.#disposing
    this.#closed = true
    this.#generation += 1
    this.#users = 0
    clearTimeout(this.#idleTimer)
    clearTimeout(this.#watchTimer)
    for (const timer of this.#mcpHolds) clearTimeout(timer)
    this.#mcpHolds.clear()
    this.#skills.clear()
    this.#mcp.clear()
    for (const inventory of this.#projectInventories.values()) inventory.clear()
    for (const entry of this.#limits.values()) clearTimeout(entry.publishTimer)
    for (const entry of this.#limits.values()) clearTimeout(entry.notifyTimer)
    this.#limits.clear()
    this.#accounts.clear()
    for (const login of this.#logins.values()) clearTimeout(login.timer)
    // Stopping the control process also cancels its browser login. Sending a
    // cancellation RPC while stopping that same process would race its exit.
    const codexLogin = this.#logins.get('codex')
    if (codexLogin) {
      codexLogin.expired = true
      this.#releaseLogin('codex', codexLogin)
    }
    const disposing = (async () => {
      const results = await Promise.allSettled([
        ...[...this.#logins].map(([provider, login]) => this.#cancelOwnedLogin(provider, login)),
        ...[...this.#owned].map((entry) => this.#stop(entry)),
      ])
      await Promise.all(this.#authQueues.values())
      // A login loader may have returned its handle during the reset. Its
      // canceled start owns cleanup; failed cleanup remains available here.
      const late = await Promise.allSettled([
        ...[...this.#logins].map(([provider, login]) => this.#cancelOwnedLogin(provider, login)),
        ...[...this.#lateLogins].map(([login, provider]) =>
          this.#cancelOwnedLogin(provider, login).then(() => {
            if (login.cancel) this.#lateLogins.delete(login)
          }),
        ),
      ])
      const errors = [...results, ...late].flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (errors.length) throw new AggregateError(errors, 'Provider controls could not stop')
    })()
    this.#disposing = disposing
    void disposing.then(
      () => {
        this.#closed = false
        this.#disposing = undefined
      },
      () => {
        this.#closed = false
        this.#disposing = undefined
      },
    )
    return disposing
  }

  #assertOpen(generation = this.#generation): void {
    if (this.#closed || generation !== this.#generation)
      throw new Error('Provider controls were reset')
  }

  #makeControl(provider: ProviderId): ProviderControl {
    const capabilities = PROVIDER_CAPABILITIES[provider]
    const services: ProviderServices = {
      ...defaultServices[provider],
      ...this.#options.services?.[provider],
    }
    const inventory = this.#projectInventory(provider, services)
    const control: ProviderControl = {
      capabilities,
      account: async (agent) => {
        const account = await this.#cachedAccount(provider, agent, () =>
          this.#read(async () => (await services.account?.(agent)) ?? { signedIn: false }),
        )
        return agent === undefined ? this.#accountRead(provider, account) : account
      },
      usageLimitSource: (intent) =>
        services.usageLimitSource
          ? this.#cachedLimits(
              provider,
              () =>
                this.#read(async () => {
                  const source = await services.usageLimitSource?.()
                  return source?.status === 'ready'
                    ? { provider, status: 'ready', limits: source.limits }
                    : { provider, status: 'unavailable' }
                }),
              intent,
            )
          : this.#read(async () => ({ provider, status: 'unavailable' })),
      heldLimitSource: (intent) =>
        this.#limits.get(provider)?.value ??
        (intent === 'background' ? undefined : this.#lastSession(provider)),
      signOut: (agent) =>
        this.#auth(provider, async (generation) => {
          const login = this.#logins.get(provider)
          if (login) await this.#cancelOwnedLogin(provider, login)
          this.#assertOpen(generation)
          await services.signOut?.(agent)
          this.#assertOpen(generation)
          this.#authChanged(provider)
        }),
      watch: (projectPath, targets) => this.#watch(provider, projectPath, targets),
      ...(services.validateMcpServer ? { validateMcpServer: services.validateMcpServer } : {}),
      ...(capabilities.nativeModels
        ? {
            listModels: (agent?: string, read?: ModelListRead) =>
              this.#readModels(provider, agent, read),
          }
        : {}),
      ...(capabilities.login && services.startLogin
        ? {
            startLogin: () =>
              this.#auth(provider, (generation) =>
                this.#startOwnedLogin(provider, services.startLogin!, generation),
              ),
            cancelLogin: (loginId: string) => this.#cancelLogin(provider, loginId),
          }
        : {}),
      ...(services.listMcpServers
        ? {
            listMcpServers: (projectPath: string, readActive?: () => Promise<ActiveMcpInventory>) =>
              this.#read(() =>
                services.listMcpServers!(
                  projectPath,
                  this.#inventoryRead(provider, 'mcp', projectPath, readActive),
                ),
              ),
          }
        : {}),
      ...(services.listCommands
        ? {
            listCommands: (projectPath: string, readActive?: () => Promise<ProviderCommand[]>) =>
              this.#read(() =>
                services.listCommands!(
                  projectPath,
                  this.#inventoryRead(provider, 'commands', projectPath, readActive),
                ),
              ),
          }
        : {}),
      ...(services.listSkills
        ? {
            listSkills: (projectPath: string) =>
              this.#read(() =>
                services.listSkills!(
                  projectPath,
                  this.#inventoryRead<never>(provider, 'skills', projectPath),
                ),
              ),
          }
        : {}),
      ...(inventory && !services.listMcpServers
        ? {
            listMcpServers: (projectPath: string, readActive?: () => Promise<ActiveMcpInventory>) =>
              this.#read(() => inventory.listMcpServers(projectPath, readActive)),
          }
        : {}),
      ...(inventory && !services.listCommands
        ? {
            listCommands: (projectPath: string, readActive?: () => Promise<ProviderCommand[]>) =>
              this.#read(() => inventory.listCommands(projectPath, readActive)),
          }
        : {}),
      ...(inventory && services.projectInventory?.skillCapabilities && !services.listSkills
        ? {
            listSkills: (projectPath: string) =>
              this.#read(async () => inventory.listSkills(projectPath)),
          }
        : {}),
    }
    if (provider !== 'codex') return control
    return {
      ...control,
      account: async () =>
        this.#accountRead(
          provider,
          await this.#cachedAccount(provider, undefined, () =>
            this.#withShared((adapter) => adapter.account()),
          ),
        ),
      listModels: (agent, read) =>
        agent
          ? this.#readModels(provider, agent, read)
          : this.#withShared((adapter) => adapter.listModels()),
      listMcpServers: (projectPath, readActive) =>
        this.#read(async () => {
          const [inventory, { CODEX_MCP_CAPABILITIES }] = await Promise.all([
            readActive
              ? readActive()
              : this.#withShared(async (adapter) => {
                  const servers = await adapter.listMcpServers()
                  if (!adapter.isMcpLoading()) return { servers }
                  this.#holdForMcpLoad(adapter, projectPath)
                  return { servers, loading: true }
                }),
            loadCodex(),
          ])
          return { capabilities: CODEX_MCP_CAPABILITIES, ...inventory }
        }),
      listSkills: (projectPath) =>
        this.#read(async () => {
          const [inventory, { CODEX_SKILL_CAPABILITIES }] = await Promise.all([
            this.#withShared((adapter) => adapter.listSkills(projectPath)),
            loadCodex(),
          ])
          return { capabilities: CODEX_SKILL_CAPABILITIES, ...inventory }
        }),
      setSkillEnabled: (_projectPath, skillId, enabled) =>
        this.#withShared((adapter) => adapter.setSkillEnabled(skillId, enabled)),
      // A fresh process reads the account's current limits rather than the
      // snapshot a long-lived process captured at startup.
      usageLimitSource: (intent) =>
        this.#cachedLimits(
          provider,
          (background, omittedDetails) =>
            this.#withFresh(async (adapter) => {
              const source = await adapter.rateLimitSource({ background })
              if (source.status === 'ready' && source.detailsOmitted) omittedDetails()
              return source.status === 'ready'
                ? { provider, status: 'ready', limits: source.limits }
                : { provider, status: 'unavailable' }
            }),
          intent,
        ),
      consumeRateLimitReset: async (idempotencyKey, creditId) => {
        const generation = this.#generation
        const outcome = await this.#withFresh((adapter) =>
          adapter.consumeRateLimitReset(idempotencyKey, creditId),
        )
        this.#assertOpen(generation)
        this.usageChanged(provider, true)
        return { outcome }
      },
      startLogin: () =>
        this.#auth(provider, (generation) =>
          this.#startOwnedLogin(
            provider,
            () =>
              this.#withShared(async (adapter) => {
                const response = await adapter.startLogin()
                return { ...response, cancel: () => adapter.cancelLogin(response.loginId) }
              }),
            generation,
          ),
        ),
      cancelLogin: (loginId) => this.#cancelLogin(provider, loginId),
      useApiKey: (apiKey) =>
        this.#auth(provider, async (generation) => {
          const login = this.#logins.get(provider)
          if (login) await this.#cancelOwnedLogin(provider, login)
          this.#assertOpen(generation)
          const account = await this.#withShared((adapter) => adapter.useApiKey(apiKey))
          this.#assertOpen(generation)
          this.#authChanged(provider)
          return account
        }),
      signOut: () =>
        this.#auth(provider, async (generation) => {
          const login = this.#logins.get(provider)
          if (login) await this.#cancelOwnedLogin(provider, login)
          this.#assertOpen(generation)
          await this.#withShared((adapter) => adapter.signOut())
          this.#assertOpen(generation)
          this.#authChanged(provider)
        }),
    }
  }

  #limitEntry(provider: ProviderId): LimitEntry {
    let entry = this.#limits.get(provider)
    if (!entry) {
      entry = {
        version: 0,
        forcedVersion: 0,
        accountVersion: 0,
        reads: 0,
        stored: 0,
        readAt: Number.NEGATIVE_INFINITY,
        freshUntil: 0,
        liveAt: Number.NEGATIVE_INFINITY,
        notifiedAt: Number.NEGATIVE_INFINITY,
        publishedAt: Number.NEGATIVE_INFINITY,
      }
      this.#limits.set(provider, entry)
    }
    return entry
  }

  #limitReadInterval(provider: ProviderId): number {
    const capabilities: ProviderControlCapabilities = PROVIDER_CAPABILITIES[provider]
    return this.#limitReadIntervalMs ?? capabilities.limitReadIntervalMs
  }

  /**
   * The last session's full read, for a view that shows the limits while this
   * session holds nothing yet. A failed read of this session marks it as the
   * last known values, as it would a value this session read.
   */
  #lastSession(provider: ProviderId): ReadyLimitSource | undefined {
    const saved = this.#saved().get(provider)
    const failure = this.#limits.get(provider)?.failure
    return saved && failure ? lastKnownLimits(saved, failure) : saved
  }

  #saved(): Map<ProviderId, ReadyLimitSource> {
    if (!this.#savedLimits) {
      let text: string | undefined
      try {
        text = this.#options.limitSnapshot?.read()
      } catch {
        // Without it the first shown view waits for its read, as before.
        text = undefined
      }
      this.#savedLimits = parseLimitSnapshot(text)
    }
    return this.#savedLimits
  }

  /** Keeps a provider's newest full read for the next launch, or forgets it. */
  #saveLimits(provider: ProviderId, source: ReadyLimitSource | undefined): void {
    const snapshot = this.#options.limitSnapshot
    if (!snapshot) return
    const saved = this.#saved()
    if (source) saved.set(provider, source)
    else if (!saved.delete(provider)) return
    try {
      snapshot.write(serializeLimitSnapshot(saved))
    } catch {
      // Costs the next launch only its figures before the first read answers.
    }
  }

  #invalidateLimits(provider: ProviderId, accountChanged: boolean, forced = false): LimitEntry {
    const entry = this.#limitEntry(provider)
    if (accountChanged) {
      entry.accountVersion += 1
      // Another account starts without this one's values, failures or read times.
      entry.value = undefined
      this.#saveLimits(provider, undefined)
      entry.live = undefined
      entry.failure = undefined
      entry.detailsOmitted = undefined
      entry.readAt = Number.NEGATIVE_INFINITY
    }
    // Spending usage cannot give an account the plan limits it lacks, so only
    // an account change discards that answer.
    else if (entry.value?.status === 'unavailable' && Date.now() < entry.freshUntil) return entry
    entry.version += 1
    if (accountChanged || forced) {
      if (forced) entry.forcedVersion += 1
      entry.freshUntil = 0
      // Live windows do not report what such a change did, so the next request reads.
      entry.liveAt = Number.NEGATIVE_INFINITY
      // A read in flight answers for the old account or predates the forced
      // change, so the next caller starts its own.
      entry.reading = undefined
    } else {
      // Usage moves during every turn. A read in flight still answers its
      // callers instead of a second process starting beside it, and a stored
      // answer stays until the provider's read interval has passed. A failing
      // source keeps its retry time: spending usage does not repair it.
      entry.freshUntil = Math.min(
        entry.freshUntil,
        entry.readAt + this.#limitReadInterval(provider),
      )
    }
    return entry
  }

  /**
   * One read serves concurrent callers, a fresh result serves later ones, and
   * a failed read answers them until its retry time: with the account's last
   * known values when there are any, otherwise with its error. A passive
   * figure is answered without a read while live windows keep arriving, and a
   * provider that reads only while its limits are shown answers it from what
   * it holds.
   */
  #cachedLimits(
    provider: ProviderId,
    /** `background` reads may leave out details, which they report through `omittedDetails`. */
    read: (background: boolean, omittedDetails: () => void) => Promise<ProviderLimitSource>,
    intent: UsageReadIntent = 'visible',
  ): Promise<ProviderLimitSource> {
    this.#assertOpen()
    const entry = this.#limitEntry(provider)
    // A shown view was answered from the last session's read; from here on it
    // is the held value, so this session's read replaces it or, failing, keeps
    // it as the last known values. A passive figure never takes it over.
    if (!entry.value && intent !== 'background') entry.value = this.#lastSession(provider)
    if (entry.reading) return entry.reading
    const startedAt = Date.now()
    // A shown view needs the details a background read left out.
    const missingDetails = entry.detailsOmitted === true && intent !== 'background'
    if (entry.value && startedAt < entry.freshUntil && !missingDetails) {
      return Promise.resolve(entry.value)
    }
    const capabilities: ProviderControlCapabilities = PROVIDER_CAPABILITIES[provider]
    // A running session that keeps reporting its windows keeps a passive figure
    // current; only a shown view needs what else a full read lists.
    if (
      intent === 'background' &&
      entry.value?.status === 'ready' &&
      startedAt < entry.liveAt + this.#limitReadInterval(provider)
    ) {
      return Promise.resolve(entry.value)
    }
    if (intent === 'background' && capabilities.limitReadsWhenShown) {
      // Nothing known is not "no plan limits": the source has simply not been read yet.
      return Promise.resolve(
        entry.value ?? {
          provider,
          status: 'unavailable',
          reason: 'failed',
          error: entry.failure ? refreshErrorOf(entry.failure) : NOT_READ_YET,
        },
      )
    }
    // Someone asked again: that request reads even inside the backoff or after
    // the timeout limit; the next automatic one waits as before.
    if (entry.failure && startedAt < entry.failure.retryAt && intent !== 'retry') {
      return entry.value?.status === 'ready'
        ? Promise.resolve(entry.value)
        : Promise.reject(entry.failure.error)
    }
    const { version, forcedVersion, accountVersion } = entry
    const sequence = ++entry.reads
    // An answer for another account, or one older than the stored answer, changes nothing.
    const current = () =>
      this.#limits.get(provider) === entry &&
      entry.accountVersion === accountVersion &&
      sequence > entry.stored
    let detailsOmitted = false
    // The read may wait while a turn streams, so it is dated when it starts.
    let readStartedAt = startedAt
    const start = () => {
      readStartedAt = Date.now()
      return read(intent === 'background', () => {
        detailsOmitted = true
      })
    }
    const wait = this.#options.beforeLimitRead
    const reading = (wait ? wait().then(start) : start())
      .then(
        (answer) => {
          const now = Date.now()
          // Clients label values by when they were read, not when they were asked for.
          let value: ProviderLimitSource =
            answer.status === 'ready' ? { ...answer, checkedAt: now, origin: 'read' } : answer
          if (!current()) return value
          if (value.status === 'ready' && entry.live) {
            const limits = withLiveWindows(value.limits, entry.live, readStartedAt)
            if (limits !== value.limits) value = { ...value, limits }
          }
          const interval = this.#limitReadInterval(provider)
          const unavailable = value.status === 'unavailable'
          const previous = entry.value
          entry.stored = sequence
          entry.value = value
          entry.readAt = readStartedAt
          entry.failure = undefined
          entry.detailsOmitted = detailsOmitted
          entry.freshUntil =
            entry.forcedVersion !== forcedVersion
              ? 0
              : // A usage change during the read leaves an unavailable answer true.
                unavailable
                ? now + this.#unavailableLimitCacheMs
                : entry.version === version
                  ? now + Math.max(this.#limitCacheMs, interval)
                  : readStartedAt + interval
          this.#saveLimits(provider, value.status === 'ready' ? heldValues(value) : undefined)
          this.#heldReplaced(provider, entry, previous)
          return value
        },
        (error: unknown) => {
          if (!current()) throw error
          const failure = limitFailure(entry.failure, error, capabilities.limitReadTimeoutLimit)
          entry.failure = failure
          // One failed refresh does not make the account's known limits unknown.
          const previous = entry.value
          if (previous?.status !== 'ready') throw error
          const lastKnown = lastKnownLimits(previous, failure)
          entry.value = lastKnown
          this.#heldReplaced(provider, entry, previous)
          return lastKnown
        },
      )
      .finally(() => {
        if (entry.reading === reading) entry.reading = undefined
      })
    entry.reading = reading
    return reading
  }

  /**
   * A read or a failed refresh replaced the held snapshot. Clients that apply
   * pushed snapshots get it; clients that only re-pull after a usage change
   * are told when what they show changed, which a background refresh needs.
   */
  #heldReplaced(provider: ProviderId, entry: LimitEntry, previous?: ProviderLimitSource): void {
    this.#publishLimits(provider, entry)
    if (previous && shownLimits(previous) !== shownLimits(entry.value)) {
      this.#options.onUsageChanged?.(provider)
    }
  }

  /**
   * Sends the held snapshot at a bounded rate: the first change at once, a
   * burst after it as one trailing snapshot with the newest values.
   */
  #publishLimits(provider: ProviderId, entry: LimitEntry): void {
    if (!this.#options.onLimitsChanged || entry.publishTimer) return
    const send = () => {
      if (this.#limits.get(provider) !== entry || this.#closed || !entry.value) return
      entry.publishedAt = Date.now()
      this.#options.onLimitsChanged?.(provider, entry.value)
    }
    const wait = entry.publishedAt + this.#limitPublishIntervalMs - Date.now()
    if (wait <= 0) {
      send()
      return
    }
    entry.publishTimer = setTimeout(() => {
      entry.publishTimer = undefined
      send()
    }, wait)
    entry.publishTimer.unref?.()
  }

  #authChanged(provider: ProviderId): void {
    // The next account read describes the new account; it is no further change.
    this.#invalidateLimits(provider, true).account = undefined
    this.#forgetAccounts(provider)
    this.#options.onAuthChanged?.(provider)
  }

  /**
   * Concurrent callers share one read, a signed-in answer serves later callers
   * for a short while, and a failed read falls back to the last sign-in it
   * confirmed. A signed-out answer is never reused, so a sign-in finished in
   * the provider's own terminal shows at the next read.
   */
  #cachedAccount(
    provider: ProviderId,
    agent: string | undefined,
    read: () => Promise<Account>,
  ): Promise<Account> {
    this.#assertOpen()
    const key = accountKey(provider, agent)
    let entry = this.#accounts.get(key)
    if (!entry) {
      entry = { at: 0 }
      this.#accounts.set(key, entry)
    }
    if (entry.reading) return entry.reading
    if (entry.value?.signedIn && Date.now() - entry.at < this.#accountCacheMs) {
      return Promise.resolve(entry.value)
    }
    const current = entry
    // An auth change or reset deletes the entry; a read that began before it
    // still answers its own caller but cannot answer anyone after the change.
    const owned = () => this.#accounts.get(key) === current
    const reading = read()
      .then(
        (account) => {
          if (owned()) {
            current.value = account
            current.at = Date.now()
          }
          return account
        },
        (error: unknown) => {
          const known = current.value
          if (!owned() || !known?.signedIn || Date.now() - current.at >= this.#accountFallbackMs) {
            throw error
          }
          const reason = error instanceof Error ? error.message : String(error)
          this.#options.onLog?.(
            provider,
            `Account check failed (${reason}); using the last known sign-in.`,
          )
          return known
        },
      )
      .finally(() => {
        if (current.reading === reading) current.reading = undefined
      })
    current.reading = reading
    return reading
  }

  #forgetAccounts(provider: ProviderId): void {
    const prefix = accountKey(provider, undefined)
    // Deleting the entry being visited is safe while iterating a Map.
    for (const key of this.#accounts.keys()) {
      if (key === prefix || key.startsWith(`${prefix}\u0000`)) this.#accounts.delete(key)
    }
  }

  /** A sign-in or account switch in the provider's own CLI reaches the app only here. */
  #accountRead(provider: ProviderId, account: Account): Account {
    const entry = this.#limitEntry(provider)
    const identity = JSON.stringify([account.signedIn, account.email ?? null, account.plan ?? null])
    if (entry.account !== undefined && entry.account !== identity) {
      this.#invalidateLimits(provider, true)
    }
    entry.account = identity
    return account
  }

  #projectInventory(
    provider: ProviderId,
    services: ProviderServices,
  ): ProjectInventoryCache | undefined {
    if (!services.projectInventory) return undefined
    const inventory = new ProjectInventoryCache({
      service: services.projectInventory,
      watchTtlMs: this.#skills.ttlMs,
      onChanged: (projectPath, parts) => {
        if (this.#closed) return
        if (parts.includes('mcp')) this.#options.onMcpChanged?.(provider, projectPath)
        if (parts.includes('commands')) this.#options.onCommandsChanged?.(provider, projectPath)
        if (parts.includes('skills')) this.#options.onSkillsChanged?.(provider, projectPath)
      },
      onError: (_projectPath, error) =>
        this.#options.onLog?.(
          provider,
          `${provider} could not read a project's commands, skills and MCP servers: ${error instanceof Error ? error.message : String(error)}`,
        ),
    })
    this.#projectInventories.set(provider, inventory)
    return inventory
  }

  #inventoryRead<Active>(
    provider: ProviderId,
    target: WatchTarget,
    projectPath: string,
    readActive?: () => Promise<Active>,
  ): InventoryRead<Active> {
    const generation = this.#generation
    return {
      readActive,
      changed: () => {
        // A probe that outlives a reset describes processes that are gone.
        if (this.#closed || generation !== this.#generation) return
        if (target === 'mcp') this.#options.onMcpChanged?.(provider, projectPath)
        else if (target === 'skills') this.#options.onSkillsChanged?.(provider, projectPath)
        else this.#options.onCommandsChanged?.(provider, projectPath)
      },
    }
  }

  async #readModels(provider: ProviderId, agent?: string, read?: ModelListRead): Promise<Model[]> {
    return this.#read(() => this.#options.listModels(provider, agent, read))
  }

  async #read<T>(operation: () => Promise<T>): Promise<T> {
    const generation = this.#generation
    this.#assertOpen(generation)
    const value = await operation()
    this.#assertOpen(generation)
    return value
  }

  #newProcess(shared: boolean): ProcessEntry {
    this.#assertOpen()
    const generation = this.#generation
    const creating = Promise.resolve().then(async () => {
      this.#assertOpen(generation)
      return this.#options.createCodex
        ? this.#options.createCodex()
        : new (await loadCodex()).CodexAdapter()
    })
    const entry: ProcessEntry = {
      creating,
      ready: creating,
      closing: false,
      stopped: false,
    }
    this.#owned.add(entry)
    entry.ready = creating
      .then(async (adapter) => {
        this.#assertOpen(generation)
        if (entry.closing) throw new Error('Provider control process is stopping')
        adapter.on('log', (line) => {
          if (!entry.closing) this.#options.onLog?.('codex', line)
        })
        if (shared) this.#listen(adapter, entry)
        await adapter.start()
        this.#assertOpen(generation)
        if (entry.closing) throw new Error('Provider control process is stopping')
        return adapter
      })
      .catch(async (error: unknown) => {
        try {
          await this.#stop(entry)
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Provider control startup and cleanup failed')
        }
        throw error
      })
    return entry
  }

  #listen(adapter: CodexControlAdapter, entry: ProcessEntry): void {
    const current = () => !this.#closed && !entry.closing && this.#shared === entry
    adapter.onUsageChanged(() => {
      if (current()) this.usageChanged('codex')
    })
    adapter.on('login', (result) => {
      if (!current()) return
      const login = this.#logins.get('codex')
      if (login) this.#loginResult('codex', login, result)
      else if (result.loginId === null) this.#emitLogin('codex', result)
    })
    adapter.on('disconnected', () => {
      if (!current()) return
      const login = this.#logins.get('codex')
      // A start still in flight rejects with the dead process on its own.
      if (!login || login.loginId === undefined || login.expired) return
      // The callback listener died with the process, so nothing is left to cancel.
      login.expired = true
      this.#releaseLogin('codex', login)
      this.#emitLogin('codex', {
        loginId: login.loginId,
        success: false,
        error: 'Codex sign-in stopped because its helper process exited.',
      })
    })
    adapter.on('skillsChanged', () => {
      if (!current()) return
      for (const projectPath of this.#skills) this.#options.onSkillsChanged?.('codex', projectPath)
    })
    adapter.on('mcpChanged', () => {
      if (!current()) return
      for (const projectPath of this.#mcp) this.#options.onMcpChanged?.('codex', projectPath)
    })
  }

  async #sharedAdapter(): Promise<CodexControlAdapter> {
    const generation = this.#generation
    this.#assertOpen()
    for (const entry of this.#owned) {
      if (entry.closing) await this.#stop(entry)
    }
    this.#assertOpen(generation)
    this.#shared ??= this.#newProcess(true)
    return this.#shared.ready
  }

  async #withShared<T>(operation: (adapter: CodexControlAdapter) => Promise<T>): Promise<T> {
    const generation = this.#generation
    this.#assertOpen()
    clearTimeout(this.#idleTimer)
    this.#users += 1
    try {
      const adapter = await this.#sharedAdapter()
      this.#assertOpen(generation)
      const result = await operation(adapter)
      this.#assertOpen(generation)
      return result
    } finally {
      if (generation === this.#generation) {
        this.#users -= 1
        this.#scheduleIdle()
      }
    }
  }

  /**
   * Codex answers its MCP status list only after every server started, which
   * can outlast the idle stop and the 60 s watch lease. The shared process
   * stays up until the list lands (bounded), and a requester whose lease
   * lapsed still hears that it changed.
   */
  #holdForMcpLoad(adapter: CodexControlAdapter, projectPath: string): void {
    const generation = this.#generation
    this.#users += 1
    let released = false
    const release = (listed: boolean) => {
      if (released) return
      released = true
      clearTimeout(timer)
      this.#mcpHolds.delete(timer)
      if (this.#closed || generation !== this.#generation) return
      this.#users -= 1
      this.#scheduleIdle()
      // A leased project already heard the adapter's own change event.
      if (listed && ![...this.#mcp].includes(projectPath)) {
        this.#options.onMcpChanged?.('codex', projectPath)
      }
    }
    const timer = setTimeout(() => release(false), this.#mcpLoadHoldMs)
    timer.unref?.()
    this.#mcpHolds.add(timer)
    void adapter.whenMcpServersListed().then(release, () => release(false))
  }

  async #withFresh<T>(operation: (adapter: CodexControlAdapter) => Promise<T>): Promise<T> {
    const generation = this.#generation
    // Do not accumulate another process after an earlier one failed to stop.
    for (const entry of this.#owned) {
      if (entry.closing) await this.#stop(entry)
    }
    this.#assertOpen(generation)
    const entry = this.#newProcess(false)
    try {
      const adapter = await entry.ready
      this.#assertOpen(generation)
      const result = await operation(adapter)
      this.#assertOpen(generation)
      return result
    } finally {
      await this.#stop(entry)
    }
  }

  #stop(entry: ProcessEntry): Promise<void> {
    if (entry.stopped) return Promise.resolve()
    if (entry.stopping) return entry.stopping
    entry.closing = true
    const stopping = (async () => {
      // A failed factory owns no process; a failed dispose still does.
      const adapter = await entry.creating.catch(() => undefined)
      await adapter?.dispose()
      entry.stopped = true
      this.#owned.delete(entry)
      if (this.#shared === entry) this.#shared = undefined
    })()
    entry.stopping = stopping
    void stopping.then(
      () => {
        entry.stopping = undefined
      },
      () => {
        entry.stopping = undefined
      },
    )
    return stopping
  }

  #watch(provider: ProviderId, projectPath: string, targets: WatchTarget[]) {
    this.#assertOpen()
    this.#projectInventories.get(provider)?.watch(projectPath, targets)
    if (PROVIDER_CAPABILITIES[provider].notifications) {
      if (targets.includes('skills')) this.#skills.add(projectPath)
      if (targets.includes('mcp')) this.#mcp.add(projectPath)
      this.#scheduleIdle()
    }
    return { expiresInMs: this.#skills.ttlMs }
  }

  #scheduleIdle(): void {
    clearTimeout(this.#idleTimer)
    clearTimeout(this.#watchTimer)
    if (this.#closed) return
    const expiries = [this.#skills.nextExpiry, this.#mcp.nextExpiry].filter(
      (expiry): expiry is number => expiry !== undefined,
    )
    if (expiries.length) {
      this.#watchTimer = setTimeout(
        () => this.#scheduleIdle(),
        Math.max(1, Math.min(...expiries) - Date.now()),
      )
      this.#watchTimer.unref?.()
    }
    if (!this.#shared || this.#users || this.#logins.has('codex') || expiries.length) return
    this.#idleTimer = setTimeout(() => {
      const entry = this.#shared
      if (!entry || this.#users || this.#logins.has('codex') || this.#skills.size || this.#mcp.size)
        return
      void this.#stop(entry).catch(() => {
        this.#options.onLog?.(
          'codex',
          'Provider control process could not stop; cleanup can be retried.',
        )
      })
    }, this.#idleMs)
    this.#idleTimer.unref?.()
  }

  #auth<T>(provider: ProviderId, operation: (generation: number) => Promise<T>): Promise<T> {
    const generation = this.#generation
    const result = (this.#authQueues.get(provider) ?? Promise.resolve()).then(() => {
      this.#assertOpen(generation)
      return operation(generation)
    })
    const settled = result.then(
      () => {},
      () => {},
    )
    this.#authQueues.set(provider, settled)
    void settled.then(() => {
      if (this.#authQueues.get(provider) === settled) this.#authQueues.delete(provider)
    })
    return result
  }

  async #startOwnedLogin(
    provider: ProviderId,
    start: NonNullable<ProviderServices['startLogin']>,
    generation: number,
  ): Promise<LoginResponse> {
    const previous = this.#logins.get(provider)
    if (previous) await this.#cancelOwnedLogin(provider, previous)
    this.#assertOpen(generation)
    const login: LoginEntry = { expired: false, canceled: false, earlyResults: [] }
    this.#logins.set(provider, login)
    login.timer = setTimeout(() => {
      login.expired = true
      if (!login.cancel) return
      void this.#cancelOwnedLogin(provider, login).then(
        () => {
          if (this.#closed || generation !== this.#generation) return
          this.#options.onLogin?.(provider, {
            loginId: login.loginId ?? null,
            success: false,
            error: 'Provider sign-in timed out.',
          })
        },
        () => {
          if (this.#closed || generation !== this.#generation) return
          this.#options.onLog?.(
            provider,
            'Provider sign-in could not stop; cleanup can be retried.',
          )
          this.#options.onLogin?.(provider, {
            loginId: login.loginId ?? null,
            success: false,
            error: 'Provider sign-in timed out.',
          })
        },
      )
    }, this.#loginTtlMs)
    login.timer.unref?.()
    const starting = (async () => {
      try {
        const handle = await start((result) => this.#loginResult(provider, login, result))
        login.loginId = handle.loginId
        login.cancel = handle.cancel
        if (
          this.#closed ||
          generation !== this.#generation ||
          login.expired ||
          this.#logins.get(provider) !== login
        ) {
          await this.#cancelOwnedLogin(provider, login)
          throw new Error('Provider sign-in was canceled')
        }
        for (const result of login.earlyResults) this.#loginResult(provider, login, result)
        login.earlyResults = []
        return { loginId: handle.loginId, ...(handle.authUrl ? { authUrl: handle.authUrl } : {}) }
      } catch (error) {
        // Retain a handle whose cancellation failed for a later cleanup attempt.
        if (!login.cancel) this.#releaseLogin(provider, login)
        throw error
      }
    })()
    let startTimer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const deadline = new Promise<never>((_resolve, reject) => {
      startTimer = setTimeout(() => {
        timedOut = true
        reject(new Error('Provider sign-in did not start in time.'))
      }, this.#loginStartTimeoutMs)
      startTimer.unref?.()
    })
    try {
      return await Promise.race([starting, deadline])
    } catch (error) {
      if (timedOut) {
        // A start that never answered would hold every later sign-in, sign-out
        // and shutdown behind it. Release the queue, but keep the late handle
        // owned so it is canceled when it finally arrives.
        login.expired = true
        this.#releaseLogin(provider, login)
        this.#lateLogins.set(login, provider)
        void starting.then(
          () => this.#lateLogins.delete(login),
          () => {
            if (!login.cancel || login.canceled) this.#lateLogins.delete(login)
          },
        )
      }
      throw error
    } finally {
      clearTimeout(startTimer)
    }
  }

  #loginResult(provider: ProviderId, login: LoginEntry, result: ProviderLoginResult): void {
    if (this.#closed || login.expired || this.#logins.get(provider) !== login) return
    if (login.loginId === undefined) {
      if (login.earlyResults.length < 16) login.earlyResults.push(result)
      return
    }
    if (result.loginId !== login.loginId) return
    if (provider === 'codex') {
      this.#releaseLogin(provider, login)
      this.#emitLogin(provider, result)
      return
    }
    // A CLI leader can exit before its descendants. Confirm owned-tree
    // cleanup before its success notification can release this login handle.
    const generation = this.#generation
    void this.#cancelOwnedLogin(provider, login).then(
      () => {
        if (!this.#closed && generation === this.#generation) this.#emitLogin(provider, result)
      },
      () => {
        if (!this.#closed && generation === this.#generation) {
          this.#emitLogin(provider, {
            loginId: result.loginId,
            success: false,
            error: 'Provider sign-in process could not stop.',
          })
        }
      },
    )
  }

  #emitLogin(provider: ProviderId, result: ProviderLoginResult): void {
    if (result.success) this.#authChanged(provider)
    this.#options.onLogin?.(provider, result)
  }

  #releaseLogin(provider: ProviderId, login: LoginEntry): void {
    clearTimeout(login.timer)
    if (this.#logins.get(provider) === login) this.#logins.delete(provider)
    this.#scheduleIdle()
  }

  #cancelLogin(provider: ProviderId, loginId: string): Promise<void> {
    return this.#auth(provider, async () => {
      const login = this.#logins.get(provider)
      if (login?.loginId === loginId) await this.#cancelOwnedLogin(provider, login)
    })
  }

  #cancelOwnedLogin(provider: ProviderId, login: LoginEntry): Promise<void> {
    clearTimeout(login.timer)
    login.expired = true
    if (login.canceled) return Promise.resolve()
    if (login.canceling) return login.canceling
    // A pending start cancels its handle before it can return.
    if (!login.cancel) return Promise.resolve()
    const canceling = Promise.resolve()
      .then(login.cancel)
      .then(() => {
        login.canceled = true
        this.#releaseLogin(provider, login)
      })
    login.canceling = canceling
    void canceling.then(
      () => {
        login.canceling = undefined
      },
      () => {
        login.canceling = undefined
      },
    )
    return canceling
  }
}

function accountKey(provider: ProviderId, agent: string | undefined): string {
  return agent === undefined ? provider : `${provider}\u0000${agent}`
}

function duration(value: number | undefined, fallback: number, minimum: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(minimum, Math.min(2_147_483_647, Math.floor(value)))
    : fallback
}
