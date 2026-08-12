import {
  CODEX_MCP_CAPABILITIES,
  CODEX_SKILL_CAPABILITIES,
  CodexAdapter,
} from '@harness/adapter-codex'
import { acpAccount, acpSignOut } from '@harness/adapter-acp'
import { grokAccount, grokLimitSource, signOutGrok } from '@harness/adapter-grok'
import {
  claudeAccount,
  claudeLimitSource,
  signOutClaude,
  startClaudeLogin,
} from '@harness/adapter-claude-code'
import { cursorAccount, signOutCursor, startCursorLogin } from '@harness/adapter-cursor'
import {
  DESIGN_BRIEF_ATTACHMENT,
  ExactBuildFilesError,
  FINAL_BRIEFING_QUESTION,
  designAssetPrompt,
  designBrandPrompt,
  designBriefingContinuation,
  designBriefingPrompt,
  designBuildCorrectionPrompt,
  designBuildPrompt,
  designPagePrompt,
  designPhaseCorrectionPrompt,
  designPreviewPrompt,
  designRepairPrompt,
  designReviewPrompt,
  parseAssetPhaseOutput,
  parseBrandPhaseOutput,
  parseBriefingOutput,
  parseBuildPhaseOutput,
  parsePagePhaseOutput,
  parsePreviewPhaseOutput,
  parsePreviewPlan,
  parseRepairPhaseOutput,
  parseReviewPhaseOutput,
  readAssetManifest,
  readBrandSystem,
  readDesignBrief,
  readPageBlueprint,
  validateExactBuildFiles,
  writeAssetManifest,
  writeBrandSystem,
  writeDesignBrief,
  writePageBlueprint,
  writeVisualReview,
  type BriefingQuestion,
  type PreviewPlan,
  type ReviewScreenshot,
  type VisualReview,
} from '@harness/design-agent'
import {
  providerRuntime,
  apiRuntime,
  type AgentSession,
  type ProviderRuntime,
  type StartOptions,
  type TurnOptions,
} from './adapters.js'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { changedSince, restoreSnapshot, takeSnapshot } from './checkpoint.js'
import { REPLY_STYLE_INSTRUCTIONS } from './reply-style.js'
import type { Store, StoredCheckpoint } from './store.js'
import {
  createWorktree,
  hasUncommittedChanges,
  pruneWorktrees,
  removeWorktree,
  type Worktree,
} from './worktree.js'
import type {
  Account,
  ApprovalDecision,
  ApprovalMode,
  DiffDecision,
  DomainEvent,
  McpCapabilities,
  McpServer,
  McpServerConfig,
  Model,
  Item,
  PanicStopResult,
  ParamsOf,
  ProviderId,
  ProviderLimit,
  ProviderLimitSource,
  QueuedTurn,
  SessionDiff,
  Skill,
  SkillCapabilities,
  SkillDiscoveryError,
  Thread,
  ThreadInboxStatus,
  ThreadLifecycle,
  UserInputQuestion,
} from '@harness/contracts'
import {
  readSessionDiff,
  reviewDiffFile,
  reviewDiffHunk,
  StaleDiffSnapshotError,
} from './diff-review.js'
import { McpConfigStore } from './mcp-config.js'
import { readCredential } from './credentials.js'
import { ModelConnectionStore } from './model-connections.js'
import { TerminalManager } from './terminal.js'
import { installLocalSkill } from './skill-install.js'
import { startDesignPreview, type RunningPreview } from './design-preview-runner.js'

type UserSubmission = { id: string; text: string; createdAt: number; queueId?: string }
type QueuedTurnEntry = QueuedTurn & { options: TurnOptions; clientSubmissionId?: string }
type QueueState = { items: QueuedTurn[]; canSteer: boolean }
type PendingTurnStart = { acceptedAt: number; submission?: UserSubmission }
type AdapterLimitSource = { status: 'ready'; limits: ProviderLimit[] } | { status: 'unavailable' }
const userTurnKey = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId])
type DesignFlowPhase =
  'brief' | 'brand' | 'page' | 'assets' | 'build' | 'preview' | 'review' | 'repair' | 'complete'
type DesignFlow = {
  workspacePath: string
  originalRequest: string
  options: TurnOptions
  phase: DesignFlowPhase
  askedQuestions: boolean
  finalAsked: boolean
  explicitAnswers: Array<{ question: string; answer: string }>
  correcting: boolean
  repairAttempt: number
  pendingBrief?: unknown
  pendingPrompt?: string
  completion?: string
  previewPlan?: PreviewPlan
  previewUrl?: string
  screenshots?: ReviewScreenshot[]
  review?: VisualReview
}

function resolveWorkspacePath(workspacePath: string): string {
  if (workspacePath === '~') return os.homedir()
  if (workspacePath.startsWith('~/') || workspacePath.startsWith('~\\')) {
    return path.join(os.homedir(), workspacePath.slice(2))
  }
  return workspacePath
}

function parseStoredDesignFlow(value: unknown, workspacePath: string): DesignFlow | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const stored = value as Record<string, unknown>
  const phases: DesignFlowPhase[] = [
    'brief',
    'brand',
    'page',
    'assets',
    'build',
    'preview',
    'review',
    'repair',
    'complete',
  ]
  if (
    typeof stored.originalRequest !== 'string' ||
    !phases.includes(stored.phase as DesignFlowPhase) ||
    typeof stored.askedQuestions !== 'boolean' ||
    typeof stored.finalAsked !== 'boolean' ||
    !Array.isArray(stored.explicitAnswers)
  ) {
    return undefined
  }
  const explicitAnswers = stored.explicitAnswers.filter(
    (answer): answer is { question: string; answer: string } =>
      typeof answer === 'object' &&
      answer !== null &&
      typeof (answer as Record<string, unknown>).question === 'string' &&
      typeof (answer as Record<string, unknown>).answer === 'string',
  )
  if (explicitAnswers.length !== stored.explicitAnswers.length) return undefined

  const rawOptions =
    typeof stored.options === 'object' && stored.options !== null && !Array.isArray(stored.options)
      ? (stored.options as Record<string, unknown>)
      : {}
  const options: TurnOptions = {}
  for (const field of ['model', 'serviceTier', 'effort'] as const) {
    if (typeof rawOptions[field] === 'string') options[field] = rawOptions[field]
  }

  let previewPlan: PreviewPlan | undefined
  let review: VisualReview | undefined
  try {
    if (stored.previewPlan !== undefined) previewPlan = parsePreviewPlan(stored.previewPlan)
    if (stored.review !== undefined) {
      review = parseReviewPhaseOutput(JSON.stringify(stored.review))
    }
  } catch {
    return undefined
  }
  const rawScreenshots = stored.screenshots
  const screenshotCount = Array.isArray(rawScreenshots) ? rawScreenshots.length : undefined
  const screenshots = Array.isArray(rawScreenshots)
    ? rawScreenshots.filter(
        (value): value is ReviewScreenshot =>
          typeof value === 'object' &&
          value !== null &&
          typeof (value as Record<string, unknown>).path === 'string' &&
          Number.isInteger((value as Record<string, unknown>).width) &&
          Number.isInteger((value as Record<string, unknown>).height),
      )
    : undefined
  if (screenshots && screenshots.length !== screenshotCount) return undefined
  const repairAttempt =
    Number.isInteger(stored.repairAttempt) && (stored.repairAttempt as number) >= 0
      ? (stored.repairAttempt as number)
      : 0
  const phase = stored.phase as DesignFlowPhase
  if (
    ((phase === 'review' || phase === 'repair') && !previewPlan) ||
    (phase === 'review' && !screenshots) ||
    (phase === 'repair' && !review)
  ) {
    return undefined
  }

  return {
    workspacePath,
    originalRequest: stored.originalRequest,
    options,
    phase,
    askedQuestions: stored.askedQuestions,
    finalAsked: stored.finalAsked,
    explicitAnswers,
    correcting: stored.correcting === true,
    repairAttempt,
    ...(stored.pendingBrief === undefined ? {} : { pendingBrief: stored.pendingBrief }),
    ...(typeof stored.pendingPrompt === 'string' ? { pendingPrompt: stored.pendingPrompt } : {}),
    ...(typeof stored.completion === 'string' ? { completion: stored.completion } : {}),
    ...(previewPlan ? { previewPlan } : {}),
    ...(previewPlan ? { previewUrl: previewPlan.url } : {}),
    ...(screenshots ? { screenshots } : {}),
    ...(review ? { review } : {}),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unresolvedDesignInput(
  history: Array<{ event: DomainEvent }>,
): { id: string; turnId: string; questions: BriefingQuestion[] } | undefined {
  const unresolved = new Map<string, { turnId: string; questions: BriefingQuestion[] }>()
  for (const { event } of history) {
    if (event.type === 'user_input.requested') {
      unresolved.set(event.request.id, {
        turnId: event.request.turnId,
        questions: event.request.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          allowOther: question.allowOther,
          options: question.options ?? [],
        })),
      })
    }
    if (event.type === 'user_input.resolved') unresolved.delete(event.id)
  }
  const last = [...unresolved].at(-1)
  return last ? { id: last[0], ...last[1] } : undefined
}

function openTurn(history: Array<{ event: DomainEvent }>): string | undefined {
  const open = new Set<string>()
  for (const { event } of history) {
    if (event.type === 'turn.started') open.add(event.turn.id)
    if (event.type === 'turn.completed') open.delete(event.turnId)
  }
  return [...open].at(-1)
}
type DesignInput = {
  threadId: string
  turnId: string
  questions: BriefingQuestion[]
  final: boolean
}
const PANIC_STOP_TIMEOUT_MS = 5_000
const DESIGN_REPAIR_LIMIT = 2
const UNSUPPORTED_MCP_CAPABILITIES: McpCapabilities = {
  inventory: false,
  add: false,
  update: false,
  remove: false,
  reload: false,
  startOAuth: false,
  cancelOAuth: false,
}
/** Harness-managed project servers only: no vendor inventory, no OAuth. */
const OPENCODE_MCP_MANAGEMENT_CAPABILITIES: McpCapabilities = {
  inventory: false,
  add: true,
  update: true,
  remove: true,
  reload: false,
  startOAuth: false,
  cancelOAuth: false,
}
const UNSUPPORTED_SKILL_CAPABILITIES: SkillCapabilities = {
  inventory: false,
  configure: false,
  install: false,
}

/**
 * Owns every live agent session.
 *
 * Sessions are independent: each has its own adapter and child process, and a
 * turn running in one does not block another. The only thing they share is
 * this map and the store.
 *
 * Every event is written to the log before it is broadcast. That ordering
 * matters — a client that reconnects mid-turn replays from the log, and an
 * event that went out but was never recorded would be one the client can never
 * get back.
 */
export class Orchestrator {
  #threads = new Map<string, { thread: Thread; session: AgentSession; worktree?: Worktree }>()
  /** Approval mode each live thread was started with; not persisted. */
  #threadApprovals = new Map<string, ApprovalMode>()
  #activeTurns = new Set<string>()
  #activeTurnIds = new Map<string, string>()
  #serverOwnedUserTurns = new Set<string>()
  #suppressedUserItems = new Map<string, Set<string>>()
  #inFlightSubmissionIds = new Map<string, Set<string>>()
  #startingTurns = new Set<string>()
  #pendingTurnStarts = new Map<string, PendingTurnStart>()
  #acceptedTurnStarts = new Map<string, Map<string, PendingTurnStart>>()
  #restoringThreads = new Map<string, Promise<void>>()
  #reviewingDiffs = new Set<string>()
  #queuedTurns = new Map<string, QueuedTurnEntry[]>()
  #drainingQueues = new Set<string>()
  #designFlows = new Map<string, DesignFlow>()
  #designTurns = new Map<string, string>()
  #designStartingThreads = new Set<string>()
  #designMessageItems = new Set<string>()
  #acceptedDesignOutputs = new Set<string>()
  #designOutputErrors = new Map<string, unknown>()
  #designActivityItems = new Map<string, Item>()
  #designInputs = new Map<string, DesignInput>()
  #designInputByThread = new Map<string, string>()
  #designPreviews = new Map<string, RunningPreview>()
  #resumingThreads = new Map<string, Promise<void>>()
  #panicGeneration = 0
  #panicStopping = false
  #store: Store
  #worktreeRoot: string
  #onEvent: (threadId: string, event: DomainEvent, seq: number) => void
  #onQueue: (threadId: string, state: QueueState) => void
  #onLog: (line: string) => void
  #onLogin: (
    provider: ProviderId,
    result: { loginId: string | null; success: boolean; error: string | null },
  ) => void
  #onMcpOAuth: (
    provider: ProviderId,
    projectPath: string,
    result: { serverId: string; loginId: string; success: boolean; error: string | null },
  ) => void
  #onMcpChanged: (provider: ProviderId, projectPath: string) => void
  #onSkillsChanged: (provider: ProviderId, projectPath: string) => void
  #onUsageChanged: (provider: ProviderId) => void
  #onLifecycle: (threadId: string, lifecycle: ThreadLifecycle) => void
  #capturePreview:
    | ((
        url: string,
        viewports: Array<{ width: number; height: number }>,
      ) => Promise<ReviewScreenshot[] | undefined>)
    | undefined
  #watchedSkillProjects = new Set<string>()
  #watchedMcpProjects = new Set<string>()
  #inboxProjections = new Map<
    string,
    { seq: number; approvals: Set<string>; inputs: Set<string>; last: 'idle' | 'failed' }
  >()
  #mcpConfig: McpConfigStore
  #modelConnections: ModelConnectionStore
  #readCredential: (reference: string) => string
  #terminals: TerminalManager

  /**
   * How a provider is turned into a running session. Injectable so the
   * concurrency behaviour can be tested without spawning real agents — the
   * property worth protecting is that sessions do not block or cross-wire each
   * other, and that is about this class, not about any vendor.
   */
  #runtimeFor: (provider: ProviderId, onLog: (line: string) => void) => ProviderRuntime
  #runtimeForInjected: boolean

  constructor(
    store: Store,
    handlers: {
      onEvent: (threadId: string, event: DomainEvent, seq: number) => void
      onQueue?: (threadId: string, state: QueueState) => void
      onLog: (line: string) => void
      onLogin: (
        provider: ProviderId,
        result: { loginId: string | null; success: boolean; error: string | null },
      ) => void
      onMcpOAuth?: (
        provider: ProviderId,
        projectPath: string,
        result: { serverId: string; loginId: string; success: boolean; error: string | null },
      ) => void
      onMcpChanged?: (provider: ProviderId, projectPath: string) => void
      onSkillsChanged?: (provider: ProviderId, projectPath: string) => void
      onUsageChanged?: (provider: ProviderId) => void
      onLifecycle?: (threadId: string, lifecycle: ThreadLifecycle) => void
      capturePreview?: (
        url: string,
        viewports: Array<{ width: number; height: number }>,
      ) => Promise<ReviewScreenshot[] | undefined>
      mcpConfig?: McpConfigStore
      modelConnections?: ModelConnectionStore
      readCredential?: (reference: string) => string
      onTerminalOutput?: (terminalId: string, data: string) => void
      onTerminalExit?: (terminalId: string, exitCode: number | null) => void
      runtimeFor?: (provider: ProviderId, onLog: (line: string) => void) => ProviderRuntime
      /** Where isolated checkouts live. Outside any repository, on purpose. */
      worktreeRoot?: string
    },
  ) {
    this.#store = store
    this.#worktreeRoot = handlers.worktreeRoot ?? path.join(os.tmpdir(), 'personal-harness-trees')
    this.#onEvent = handlers.onEvent
    this.#onQueue = handlers.onQueue ?? (() => {})
    this.#onLog = handlers.onLog
    this.#onLogin = handlers.onLogin
    this.#onMcpOAuth = handlers.onMcpOAuth ?? (() => {})
    this.#onMcpChanged = handlers.onMcpChanged ?? (() => {})
    this.#onSkillsChanged = handlers.onSkillsChanged ?? (() => {})
    this.#onUsageChanged = handlers.onUsageChanged ?? (() => {})
    this.#onLifecycle = handlers.onLifecycle ?? (() => {})
    this.#capturePreview = handlers.capturePreview
    this.#mcpConfig = handlers.mcpConfig ?? new McpConfigStore()
    this.#modelConnections = handlers.modelConnections ?? new ModelConnectionStore()
    this.#readCredential = handlers.readCredential ?? readCredential
    this.#terminals = new TerminalManager({
      onOutput: handlers.onTerminalOutput ?? (() => {}),
      onExit: handlers.onTerminalExit ?? (() => {}),
    })
    this.#runtimeFor = handlers.runtimeFor ?? providerRuntime
    this.#runtimeForInjected = handlers.runtimeFor !== undefined
  }

  /**
   * A single long-lived adapter for everything that is not a thread: models,
   * account, sign-in. It has to outlive a request because the OAuth completion
   * arrives as a notification minutes later, on the same connection that
   * started the flow.
   */
  #control: CodexAdapter | undefined
  #controlStarting: Promise<CodexAdapter> | undefined
  #providerLogins = new Map<ProviderId, { loginId: string; cancel: () => void }>()
  #voiceRequests = new Map<string, AbortController>()

  async #controlAdapter(): Promise<CodexAdapter> {
    if (this.#control) return this.#control
    if (this.#controlStarting) return this.#controlStarting
    const adapter = new CodexAdapter()
    adapter.on('log', (line) => this.#onLog(line))
    adapter.on('login', (result) => this.#onLogin('codex', result))
    adapter.onUsageChanged(() => {
      if (this.#control === adapter) this.#onUsageChanged('codex')
    })
    adapter.on('skillsChanged', () => {
      for (const projectPath of this.#watchedSkillProjects) {
        this.#onSkillsChanged('codex', projectPath)
      }
    })
    adapter.on('mcpChanged', () => {
      for (const projectPath of this.#watchedMcpProjects) {
        this.#onMcpChanged('codex', projectPath)
      }
    })
    const starting = adapter
      .start()
      .then(() => {
        this.#control = adapter
        return adapter
      })
      .catch((error: unknown) => {
        adapter.dispose()
        throw error
      })
      .finally(() => {
        if (this.#controlStarting === starting) this.#controlStarting = undefined
      })
    this.#controlStarting = starting
    return starting
  }

  async listModels(provider: ProviderId, agent?: string): Promise<Model[]> {
    // Codex has a control adapter already running; everything else asks its
    // own runtime, which is free to answer with nothing.
    if (provider === 'codex') return (await this.#controlAdapter()).listModels()
    // The injected seam, not the module function — otherwise tests spawn the
    // real vendor CLIs just to draw a model list.
    return this.#runtimeFor(provider, this.#onLog).listModels(agent)
  }

  listModelConnections() {
    return this.#modelConnections.list()
  }

  upsertModelConnection(connection: Parameters<ModelConnectionStore['upsert']>[0]) {
    return this.#modelConnections.upsert(connection)
  }

  setModelConnectionCredential(connectionId: string, apiKey: string): void {
    this.#modelConnections.setCredential(connectionId, apiKey)
  }

  removeModelConnection(connectionId: string): void {
    this.#modelConnections.remove(connectionId)
  }

  async listConnectionModels(connectionId: string): Promise<Model[]> {
    const connection = this.#modelConnections.get(connectionId)
    const apiKey = this.#readCredential(connection.credentialRef)
    return apiRuntime(connection, apiKey, this.#onLog).listModels()
  }

  async listMcpServers(
    provider: ProviderId,
    projectPath: string,
  ): Promise<{ capabilities: McpCapabilities; servers: McpServer[] }> {
    if (provider === 'opencode') {
      // No vendor inventory over this surface, but the harness-managed
      // project servers are real: they are handed to every opencode launch
      // through its own config.
      this.#watchedMcpProjects.add(projectPath)
      return {
        capabilities: OPENCODE_MCP_MANAGEMENT_CAPABILITIES,
        servers: this.#mcpConfig.list(provider, projectPath).map((config) => ({
          id: config.id,
          scope: 'project' as const,
          enabled: config.enabled,
          auth: { status: 'not_required' as const },
          startup: { state: 'stopped' as const },
          tools: [],
          resources: [],
          resourceTemplates: [],
          ...(config.enabled
            ? {
                transport: config.transport,
                ...(config.displayName ? { displayName: config.displayName } : {}),
              }
            : {}),
        })),
      }
    }
    if (provider !== 'codex') {
      return { capabilities: UNSUPPORTED_MCP_CAPABILITIES, servers: [] }
    }
    this.#watchedMcpProjects.add(projectPath)
    const active = [...this.#threads.values()].find(
      ({ thread, session }) =>
        thread.provider === provider &&
        this.#store.thread(thread.id)?.projectPath === projectPath &&
        session.listMcpServers,
    )
    const inherited = active?.session.listMcpServers
      ? await active.session.listMcpServers(active.thread.id)
      : await (await this.#controlAdapter()).listMcpServers()
    const servers = new Map(inherited.map((server) => [server.id, server]))
    for (const config of this.#mcpConfig.list(provider, projectPath)) {
      const current = servers.get(config.id)
      const base: McpServer = current ?? {
        id: config.id,
        scope: 'project',
        enabled: config.enabled,
        auth: { status: 'not_required' },
        startup: { state: 'stopped' },
        tools: [],
        resources: [],
        resourceTemplates: [],
      }
      servers.set(config.id, {
        ...base,
        scope: 'project',
        enabled: config.enabled,
        ...(!config.enabled
          ? { startup: { state: 'stopped' as const } }
          : {
              transport: config.transport,
              ...(config.displayName ? { displayName: config.displayName } : {}),
            }),
      })
    }
    return { capabilities: CODEX_MCP_CAPABILITIES, servers: [...servers.values()] }
  }

  async listSkills(
    provider: ProviderId,
    projectPath: string,
  ): Promise<{
    capabilities: SkillCapabilities
    skills: Skill[]
    errors: SkillDiscoveryError[]
  }> {
    if (provider !== 'codex') {
      return { capabilities: UNSUPPORTED_SKILL_CAPABILITIES, skills: [], errors: [] }
    }
    this.#watchedSkillProjects.add(projectPath)
    return {
      capabilities: CODEX_SKILL_CAPABILITIES,
      ...(await (await this.#controlAdapter()).listSkills(projectPath)),
    }
  }

  async setSkillEnabled(
    provider: ProviderId,
    projectPath: string,
    skillId: string,
    enabled: boolean,
  ): Promise<boolean> {
    if (provider !== 'codex') {
      throw new Error(`provider "${provider}" cannot configure skills yet`)
    }
    this.#watchedSkillProjects.add(projectPath)
    return (await this.#controlAdapter()).setSkillEnabled(skillId, enabled)
  }

  async installSkillFromFolder(
    provider: ProviderId,
    projectPath: string,
    folderPath: string,
  ): Promise<Skill> {
    if (provider !== 'codex') {
      throw new Error(`provider "${provider}" cannot install skills yet`)
    }

    const destination = await installLocalSkill(projectPath, folderPath)
    try {
      this.#watchedSkillProjects.add(projectPath)
      const inventory = await (await this.#controlAdapter()).listSkills(projectPath)
      const installed = inventory.skills.find(
        (skill) =>
          skill.source.type === 'folder' &&
          path.resolve(skill.source.path) === path.resolve(destination),
      )
      if (installed) return installed

      const discoveryError = inventory.errors.find((error) =>
        path.resolve(error.path).startsWith(`${path.resolve(destination)}${path.sep}`),
      )
      throw new Error(discoveryError?.message ?? 'Codex did not discover the installed skill')
    } catch (error) {
      await rm(destination, { recursive: true, force: true })
      throw error
    }
  }

  addMcpServer(provider: ProviderId, projectPath: string, server: McpServerConfig): void {
    this.#requireMcpManagement(provider)
    this.#mcpConfig.add(provider, projectPath, server)
  }

  updateMcpServer(provider: ProviderId, projectPath: string, server: McpServerConfig): void {
    this.#requireMcpManagement(provider)
    this.#mcpConfig.update(provider, projectPath, server)
  }

  removeMcpServer(provider: ProviderId, projectPath: string, serverId: string): void {
    this.#requireMcpManagement(provider)
    this.#mcpConfig.remove(provider, projectPath, serverId)
  }

  async reloadMcpServers(provider: ProviderId, projectPath: string): Promise<void> {
    this.#requireMcpManagement(provider)
    const active = [...this.#threads.values()].find(
      ({ thread }) =>
        thread.provider === provider && this.#store.thread(thread.id)?.projectPath === projectPath,
    )
    if (!active?.session.reloadMcpServers) {
      throw new Error('start a Codex session for this project before reloading MCP servers')
    }
    const options = this.#mcpRuntimeOptions(provider, projectPath)
    await active.session.reloadMcpServers(
      active.thread.id,
      options.mcpServers ?? [],
      options.mcpCredentials ?? {},
    )
  }

  async startMcpOAuth(
    provider: ProviderId,
    projectPath: string,
    serverId: string,
  ): Promise<{ loginId: string; authUrl: string }> {
    this.#requireMcpManagement(provider)
    const active = [...this.#threads.values()].find(
      ({ thread }) =>
        thread.provider === provider && this.#store.thread(thread.id)?.projectPath === projectPath,
    )
    if (!active?.session.startMcpOAuth) {
      throw new Error('start a Codex session for this project before signing in to an MCP server')
    }
    return active.session.startMcpOAuth(serverId, active.thread.id)
  }

  cancelMcpOAuth(provider: ProviderId): never {
    throw new Error(
      `provider "${provider}" cannot cancel MCP OAuth; close the browser flow instead`,
    )
  }

  #requireMcpManagement(provider: ProviderId): void {
    if (provider !== 'codex' && provider !== 'opencode')
      throw new Error(`provider "${provider}" cannot manage MCP servers yet`)
  }

  #mcpRuntimeOptions(provider: ProviderId, projectPath: string): StartOptions {
    if (provider !== 'codex' && provider !== 'opencode') return {}
    const mcpServers = this.#mcpConfig.list(provider, projectPath)
    const mcpCredentials: Record<string, string> = {}
    for (const server of mcpServers) {
      if (!server.enabled) continue
      const values =
        server.transport.type === 'stdio'
          ? Object.values(server.transport.environment ?? {})
          : Object.values(server.transport.headers ?? {})
      for (const value of values) {
        if (value.source === 'credential' && mcpCredentials[value.credentialRef] === undefined) {
          mcpCredentials[value.credentialRef] = this.#readCredential(value.credentialRef)
        }
      }
    }
    return { mcpServers, mcpCredentials }
  }

  async account(provider: ProviderId, agent?: string): Promise<Account> {
    if (provider === 'codex') return (await this.#controlAdapter()).account()
    if (provider === 'claude-code') return claudeAccount()
    if (provider === 'cursor') return cursorAccount()
    if (provider === 'grok') return grokAccount()
    if (provider === 'acp' && agent) return acpAccount(agent)
    return { signedIn: false }
  }

  async usageLimitSource(provider: ProviderId): Promise<ProviderLimitSource> {
    const readers: Partial<Record<ProviderId, () => Promise<AdapterLimitSource>>> = {
      codex: async () => (await this.#controlAdapter()).rateLimitSource(),
      'claude-code': claudeLimitSource,
      grok: grokLimitSource,
    }
    const source = await (readers[provider]?.() ?? Promise.resolve({ status: 'unavailable' }))
    return source.status === 'ready'
      ? { provider, status: 'ready', limits: source.limits }
      : { provider, status: 'unavailable' }
  }

  async startLogin(provider: ProviderId): Promise<{ loginId: string; authUrl?: string }> {
    if (provider === 'codex') return (await this.#controlAdapter()).startLogin()
    const start =
      provider === 'claude-code'
        ? startClaudeLogin
        : provider === 'cursor'
          ? startCursorLogin
          : undefined
    if (!start) throw new Error(`provider "${provider}" cannot sign in yet`)
    this.#providerLogins.get(provider)?.cancel()
    const login = start((result) => {
      if (this.#providerLogins.get(provider)?.loginId === result.loginId) {
        this.#providerLogins.delete(provider)
      }
      this.#onLogin(provider, result)
    })
    this.#providerLogins.set(provider, login)
    return { loginId: login.loginId }
  }

  async cancelLogin(provider: ProviderId, loginId: string): Promise<void> {
    if (provider === 'codex') {
      await (await this.#controlAdapter()).cancelLogin(loginId)
      return
    }
    const login = this.#providerLogins.get(provider)
    if (login?.loginId !== loginId) return
    login.cancel()
    this.#providerLogins.delete(provider)
  }

  async useApiKey(provider: ProviderId, apiKey: string): Promise<Account> {
    if (provider !== 'codex') throw new Error(`provider "${provider}" cannot sign in yet`)
    return (await this.#controlAdapter()).useApiKey(apiKey)
  }

  async signOut(provider: ProviderId, agent?: string): Promise<void> {
    if (provider === 'codex') return (await this.#controlAdapter()).signOut()
    if (provider === 'claude-code') return signOutClaude()
    if (provider === 'cursor') return signOutCursor()
    if (provider === 'grok') return signOutGrok()
    if (provider === 'acp' && agent) return acpSignOut(agent)
  }

  async voiceStatus(provider: ProviderId): Promise<{
    available: boolean
    reason?: 'provider_unsupported' | 'sign_in_required' | 'unsupported_auth' | 'codex_too_old'
  }> {
    if (provider !== 'codex') return { available: false, reason: 'provider_unsupported' }
    return (await this.#controlAdapter()).voiceCapability()
  }

  async transcribeVoice(input: ParamsOf<'voice.transcribe'>): Promise<{ text: string }> {
    if (this.#voiceRequests.has(input.requestId)) {
      throw new Error('A voice transcription with this request id is already running.')
    }
    const controller = new AbortController()
    this.#voiceRequests.set(input.requestId, controller)
    try {
      const text = await (
        await this.#controlAdapter()
      ).transcribeVoice(
        {
          audioBase64: input.audioBase64,
          mimeType: input.mimeType,
          sampleRateHz: input.sampleRateHz,
          durationMs: input.durationMs,
        },
        controller.signal,
      )
      return { text }
    } finally {
      this.#voiceRequests.delete(input.requestId)
    }
  }

  cancelVoice(requestId: string): void {
    this.#voiceRequests.get(requestId)?.abort()
  }

  async startThread(
    provider: ProviderId,
    workspacePath: string,
    options: StartOptions = {},
  ): Promise<Thread> {
    // The id has to exist before the worktree, and the worktree before the
    // agent — it is the directory the agent will be spawned in.
    const threadId = `${provider}-${crypto.randomUUID()}`
    const resolvedWorkspacePath = resolveWorkspacePath(workspacePath)
    const worktree = options.isolate
      ? await createWorktree(resolvedWorkspacePath, threadId, this.#worktreeRoot)
      : undefined

    const runtime =
      provider === 'api' && !this.#runtimeForInjected
        ? this.#apiRuntime(options.connectionId)
        : this.#runtimeFor(provider, this.#onLog)
    const runtimeOptions = {
      ...options,
      instructions: REPLY_STYLE_INSTRUCTIONS,
      ...this.#mcpRuntimeOptions(provider, workspacePath),
    }
    let started
    try {
      started = await runtime.start(worktree?.path ?? resolvedWorkspacePath, runtimeOptions)
    } catch (error) {
      // A worktree for a session that never started is litter, and the next
      // attempt would trip over it.
      if (worktree) await removeWorktree(worktree, true).catch(() => undefined)
      throw error
    }

    const { thread, session } = started
    this.#store.addProject(workspacePath)
    this.#store.addThread({
      id: thread.id,
      // The project is the repository, not the private checkout. A session
      // still belongs to the folder the user chose.
      projectPath: workspacePath,
      provider,
      ...(options.agent ? { agent: options.agent } : {}),
      title: 'New session',
      createdAt: thread.createdAt,
      ...(worktree ? { worktreePath: worktree.path, worktreeBranch: worktree.branch } : {}),
    })
    this.#attachThread(thread, session, workspacePath, worktree)
    if (options.approval) this.#threadApprovals.set(thread.id, options.approval)
    return thread
  }

  #apiRuntime(connectionId: string | undefined): ProviderRuntime {
    if (!connectionId) throw new Error('connectionId is required for direct API sessions')
    const connection = this.#modelConnections.get(connectionId)
    if (!connection.enabled) throw new Error(`model connection "${connectionId}" is disabled`)
    const apiKey = this.#readCredential(connection.credentialRef)
    return apiRuntime(connection, apiKey, this.#onLog)
  }

  async sendTurn(
    threadId: string,
    text: string,
    attachments: string[] = [],
    options: TurnOptions = {},
    submission?: UserSubmission,
  ): Promise<string> {
    if (this.#panicStopping) throw new Error('turn cancelled by panic stop')
    if (this.#reviewingDiffs.has(threadId)) {
      throw new Error('cannot start a turn while a diff rejection is running')
    }
    if (this.#restoringThreads.has(threadId)) {
      throw new Error('cannot start a turn while restoring a checkpoint')
    }
    this.#wakeForActivity(threadId)
    const panicGeneration = this.#panicGeneration
    const pendingStart = this.#beginTurnStart(threadId, submission)
    this.#startingTurns.add(threadId)
    try {
      // Before the agent writes, not after. A checkpoint taken afterwards would
      // record the damage rather than the state worth returning to.
      await this.#checkpoint(threadId, text)
      if (panicGeneration !== this.#panicGeneration) {
        throw new Error('turn cancelled by panic stop')
      }
      const design = attachments.includes(DESIGN_BRIEF_ATTACHMENT)
      if (design) {
        this.#stopDesignPreview(threadId)
        // The flow keeps the user's own options; only brief-phase turns force
        // low effort (see #designTurnOptions). Storing the lowered options
        // here made Brand, Page, Build, and Review inherit the fast briefing
        // setting for the whole run.
        const flow: DesignFlow = {
          workspacePath: this.#repoPath(threadId),
          originalRequest: text,
          options,
          phase: 'brief',
          askedQuestions: false,
          finalAsked: false,
          explicitAnswers: [],
          correcting: false,
          repairAttempt: 0,
        }
        this.#designFlows.set(threadId, flow)
        this.#saveDesignFlow(threadId)
        const turnId = await this.#sendDesignTurn(
          threadId,
          designBriefingPrompt(text),
          attachments.filter((path) => path !== DESIGN_BRIEF_ATTACHMENT),
          this.#designTurnOptions(flow),
          pendingStart,
        )
        // Ask-first cannot answer a permission prompt on an agent without
        // interactive approvals, so its Build writes get denied one by one.
        // Say so up front instead of letting the run die on it.
        if (
          this.#threadApprovals.get(threadId) === 'ask' &&
          !this.#get(threadId).session.capabilities.approvals
        ) {
          this.#recordDesignNote(
            threadId,
            turnId,
            'Heads up: this agent cannot ask for permission mid-run, so Ask-first may block its file writes during the build. Auto or Full approval works better for Design mode.',
          )
        }
        return turnId
      }
      const turnId = await this.#get(threadId).session.sendTurn(
        threadId,
        text,
        attachments,
        options,
      )
      this.#acceptTurnStart(threadId, turnId, pendingStart)
      return turnId
    } catch (error) {
      this.#forgetPendingTurnStart(threadId, pendingStart)
      throw error
    } finally {
      this.#startingTurns.delete(threadId)
    }
  }

  /** Send now when idle, otherwise put the prompt behind the active turn. */
  async submitTurn(
    threadId: string,
    text: string,
    attachments: string[] = [],
    options: TurnOptions = {},
    clientSubmissionId?: string,
  ): Promise<{ queued: false; turnId: string } | { queued: true; queuedTurn: QueuedTurn }> {
    await this.#ensureThread(threadId)
    if (clientSubmissionId) this.#assertFreshSubmissionId(threadId, clientSubmissionId)
    const submittedAt = Date.now()
    const submission = clientSubmissionId
      ? { id: clientSubmissionId, text, createdAt: submittedAt }
      : undefined
    const queue = this.#queueEntries(threadId)
    if (
      this.#activeTurns.has(threadId) ||
      this.#startingTurns.has(threadId) ||
      this.#drainingQueues.has(threadId) ||
      this.#designFlows.has(threadId) ||
      this.#designInputByThread.has(threadId) ||
      queue.length > 0
    ) {
      const queuedTurn: QueuedTurnEntry = {
        id: clientSubmissionId ?? crypto.randomUUID(),
        text,
        attachments,
        createdAt: submittedAt,
        options,
        ...(clientSubmissionId ? { clientSubmissionId } : {}),
      }
      this.#store.enqueueQueuedTurn({ ...queuedTurn, threadId })
      queue.push(queuedTurn)
      this.#queuedTurns.set(threadId, queue)
      this.#notifyQueue(threadId)
      if (
        !this.#activeTurns.has(threadId) &&
        !this.#startingTurns.has(threadId) &&
        !this.#designFlows.has(threadId) &&
        !this.#designInputByThread.has(threadId)
      ) {
        void this.#drainQueue(threadId)
      }
      return { queued: true, queuedTurn: this.#publicQueuedTurn(queuedTurn) }
    }

    const turnId = await this.sendTurn(threadId, text, attachments, options, submission)
    this.#activeTurns.add(threadId)
    return { queued: false, turnId }
  }

  queue(threadId: string): QueueState {
    const session = this.#threads.get(threadId)?.session
    return {
      items: this.#queueEntries(threadId).map((item) => this.#publicQueuedTurn(item)),
      canSteer: session?.capabilities.steer === true && session.steer !== undefined,
    }
  }

  deleteQueuedTurn(threadId: string, queuedTurnId: string): void {
    const queue = this.#queueEntries(threadId)
    const index = queue.findIndex((item) => item.id === queuedTurnId)
    if (index < 0) return
    if (!this.#store.deleteQueuedTurn(threadId, queuedTurnId)) return
    queue.splice(index, 1)
    this.#notifyQueue(threadId)
  }

  moveQueuedTurn(threadId: string, queuedTurnId: string, direction: 'up' | 'down'): void {
    const queue = this.#queueEntries(threadId)
    const from = queue.findIndex((item) => item.id === queuedTurnId)
    const to = from + (direction === 'up' ? -1 : 1)
    if (from < 0 || to < 0 || to >= queue.length) return
    if (!this.#store.moveQueuedTurn(threadId, queuedTurnId, direction)) return
    ;[queue[from], queue[to]] = [queue[to]!, queue[from]!]
    this.#notifyQueue(threadId)
  }

  async steerQueuedTurn(threadId: string, queuedTurnId: string): Promise<void> {
    const session = this.#get(threadId).session
    if (!this.#activeTurns.has(threadId)) throw new Error('there is no running turn to steer')
    if (!session.capabilities.steer || !session.steer) {
      throw new Error('this agent does not support steering a running turn')
    }
    if (this.#drainingQueues.has(threadId))
      throw new Error('a queued prompt is already being steered')

    const queue = this.#queueEntries(threadId)
    const index = queue.findIndex((item) => item.id === queuedTurnId)
    if (index < 0) throw new Error('queued prompt not found')
    const queued = queue[index]!
    const activeTurnId = this.#activeTurnIds.get(threadId)
    if (queued.clientSubmissionId && !activeTurnId) {
      throw new Error('running turn identity is not available yet')
    }
    const claimed = this.#store.claimQueuedTurn(threadId, queuedTurnId, 'steer')
    if (!claimed) throw new Error('queued prompt is no longer available')
    const [item] = queue.splice(index, 1)
    if (!item) return
    const claimedIds = this.#inFlightSubmissionIds.get(threadId) ?? new Set<string>()
    if (item.clientSubmissionId) {
      claimedIds.add(item.clientSubmissionId)
      this.#inFlightSubmissionIds.set(threadId, claimedIds)
    }
    this.#notifyQueue(threadId)
    const ownedTurnKey = activeTurnId ? userTurnKey(threadId, activeTurnId) : undefined
    const alreadyOwned = ownedTurnKey ? this.#serverOwnedUserTurns.has(ownedTurnKey) : false
    if (ownedTurnKey && item.clientSubmissionId) this.#serverOwnedUserTurns.add(ownedTurnKey)
    this.#drainingQueues.add(threadId)
    try {
      await session.steer(threadId, item.text, item.attachments)
      if (!this.#threads.has(threadId)) return
      if (!this.#activeTurns.has(threadId) || this.#activeTurnIds.get(threadId) !== activeTurnId) {
        this.#store.restoreQueuedTurn(threadId, item.id)
        queue.splice(index, 0, item)
        this.#notifyQueue(threadId)
      } else if (activeTurnId && item.clientSubmissionId) {
        this.#recordUserSubmission(threadId, activeTurnId, {
          id: item.clientSubmissionId,
          text: item.text,
          createdAt: item.createdAt,
          queueId: item.id,
        })
      } else {
        this.#store.completeQueuedTurn(threadId, item.id)
      }
    } catch (error) {
      if (!this.#threads.has(threadId)) throw error
      if (ownedTurnKey && !alreadyOwned) this.#serverOwnedUserTurns.delete(ownedTurnKey)
      this.#store.restoreQueuedTurn(threadId, item.id)
      queue.splice(index, 0, item)
      this.#notifyQueue(threadId)
      throw error
    } finally {
      if (item.clientSubmissionId) {
        claimedIds.delete(item.clientSubmissionId)
        if (claimedIds.size === 0 && this.#inFlightSubmissionIds.get(threadId) === claimedIds)
          this.#inFlightSubmissionIds.delete(threadId)
      }
      this.#drainingQueues.delete(threadId)
      void this.#drainQueue(threadId)
    }
  }

  /**
   * Log first, then broadcast.
   *
   * A client that reconnects mid-turn catches up from the log. An event that
   * went out but was never recorded would be one it can never get back, so the
   * write has to happen first even though it is the slower half.
   */
  #record(threadId: string, event: DomainEvent): void {
    let matchedStart: PendingTurnStart | undefined
    if (event.type === 'turn.started') {
      const acceptedStarts = this.#acceptedTurnStarts.get(threadId)
      matchedStart = acceptedStarts?.get(event.turn.id)
      if (matchedStart) {
        acceptedStarts?.delete(event.turn.id)
      } else {
        matchedStart = this.#pendingTurnStarts.get(threadId)
        if (matchedStart) this.#pendingTurnStarts.delete(threadId)
      }
      if (matchedStart) {
        event = { ...event, turn: { ...event.turn, createdAt: matchedStart.acceptedAt } }
      }
    }
    if (event.type === 'turn.completed') {
      this.#acceptedTurnStarts.get(threadId)?.delete(event.turnId)
      event = { ...event, completedAt: Date.now() }
    }
    if (event.type === 'thread.error') {
      this.#pendingTurnStarts.delete(threadId)
      this.#acceptedTurnStarts.delete(threadId)
    }
    if (event.type === 'turn.started') {
      this.#activeTurns.add(threadId)
      this.#activeTurnIds.set(threadId, event.turn.id)
    }
    if (event.type === 'turn.completed' || event.type === 'thread.error') {
      this.#activeTurns.delete(threadId)
      const activeTurnId =
        event.type === 'turn.completed' ? event.turnId : this.#activeTurnIds.get(threadId)
      this.#activeTurnIds.delete(threadId)
      if (activeTurnId) this.#serverOwnedUserTurns.delete(userTurnKey(threadId, activeTurnId))
      this.#suppressedUserItems.delete(threadId)
    }
    const seq = this.#store.append(threadId, event)
    if (
      event.type === 'turn.started' ||
      event.type === 'approval.requested' ||
      event.type === 'user_input.requested'
    ) {
      this.#wakeForActivity(threadId)
    }
    if (event.type === 'turn.completed' || event.type === 'thread.error') {
      this.#wakeForActivity(threadId, true)
    }
    this.#onEvent(threadId, event, seq)
    if (
      event.type === 'turn.started' &&
      matchedStart?.submission &&
      !this.#serverOwnedUserTurns.has(userTurnKey(threadId, event.turn.id))
    ) {
      this.#recordUserSubmission(threadId, event.turn.id, matchedStart.submission)
    }
    if (
      event.type === 'turn.completed' &&
      !this.#designFlows.has(threadId) &&
      !this.#designInputByThread.has(threadId)
    ) {
      void this.#drainQueue(threadId)
    }
  }

  #recordUserSubmission(threadId: string, turnId: string, submission: UserSubmission): void {
    this.#serverOwnedUserTurns.add(userTurnKey(threadId, turnId))
    const event: DomainEvent = {
      type: 'item.completed',
      item: {
        id: submission.id,
        turnId,
        type: 'message',
        role: 'user',
        status: 'completed',
        text: submission.text,
        createdAt: submission.createdAt,
      },
    }
    if (submission.queueId) {
      const seq = this.#store.appendAndCompleteQueuedTurn(threadId, submission.queueId, event)
      this.#onEvent(threadId, event, seq)
    } else {
      this.#record(threadId, event)
    }
  }

  /** A thread's history, for a client opening or reattaching to it. */
  async history(
    threadId: string,
    afterSeq = 0,
  ): Promise<Array<{ seq: number; event: DomainEvent }>> {
    await this.#restoringThreads.get(threadId)
    return this.#store.history(threadId, afterSeq)
  }

  async diff(threadId: string): Promise<SessionDiff> {
    return readSessionDiff(this.#diffRepoPath(threadId), threadId, this.#store)
  }

  async reviewHunk(
    threadId: string,
    version: string,
    filePath: string,
    hunkId: string,
    decision: DiffDecision,
  ): Promise<SessionDiff> {
    const review = () =>
      reviewDiffHunk(
        this.#diffRepoPath(threadId),
        threadId,
        version,
        filePath,
        hunkId,
        decision,
        this.#store,
      )
    return decision === 'reject' ? this.#rejectDiff(threadId, review) : review()
  }

  async reviewFile(
    threadId: string,
    version: string,
    filePath: string,
    decision: DiffDecision,
  ): Promise<SessionDiff> {
    const review = () =>
      reviewDiffFile(
        this.#diffRepoPath(threadId),
        threadId,
        version,
        filePath,
        decision,
        this.#store,
      )
    return decision === 'reject' ? this.#rejectDiff(threadId, review) : review()
  }

  /** Whether a session is still live, as opposed to merely on record. */
  isRunning(threadId: string): boolean {
    return this.#threads.has(threadId)
  }

  /** Whether the agent is inside a turn, rather than merely attached to the session. */
  isTurnRunning(threadId: string): boolean {
    return (
      this.#activeTurns.has(threadId) ||
      this.#startingTurns.has(threadId) ||
      this.#designStartingThreads.has(threadId)
    )
  }

  inboxStatus(threadId: string): ThreadInboxStatus {
    if (this.#startingTurns.has(threadId) || this.#designStartingThreads.has(threadId)) {
      return 'starting'
    }
    if (this.#activeTurns.has(threadId)) return 'working'
    if (this.#queueEntries(threadId).length > 0) return 'queued'

    // Incremental projection over the durable log. The fold is append-only,
    // so each call replays only events after the last consumed seq — the
    // full-history replay per sidebar refresh was the first thing to hurt on
    // long transcripts. History rewrites (restore/undo) drop the projection.
    const projection = this.#inboxProjections.get(threadId) ?? {
      seq: 0,
      approvals: new Set<string>(),
      inputs: new Set<string>(),
      last: 'idle' as 'idle' | 'failed',
    }
    for (const { seq, event } of this.#store.history(threadId, projection.seq)) {
      projection.seq = seq
      if (event.type === 'approval.requested') projection.approvals.add(event.request.id)
      if (event.type === 'approval.resolved') projection.approvals.delete(event.id)
      if (event.type === 'user_input.requested') projection.inputs.add(event.request.id)
      if (event.type === 'user_input.resolved') projection.inputs.delete(event.id)
      if (event.type === 'thread.error') projection.last = 'failed'
      if (event.type === 'turn.completed') {
        projection.last = event.status === 'failed' ? 'failed' : 'idle'
      }
    }
    this.#inboxProjections.set(threadId, projection)
    if (projection.approvals.size > 0) return 'approval'
    if (projection.inputs.size > 0) return 'input'
    if (projection.last === 'failed') return 'failed'
    return this.#store.thread(threadId)?.unread ? 'ready' : projection.last
  }

  /** Forget the inbox projection after anything that rewrites history. */
  #dropInboxProjection(threadId: string): void {
    this.#inboxProjections.delete(threadId)
  }

  settleThread(threadId: string): ThreadLifecycle {
    this.#assertLifecycleState(threadId, 'active')
    this.#assertCanHide(threadId)
    return this.#notifyLifecycle(threadId, this.#store.settleThread(threadId, 'manual'))
  }

  unsettleThread(threadId: string): ThreadLifecycle {
    this.#assertLifecycleState(threadId, 'settled')
    return this.#notifyLifecycle(threadId, this.#store.activateThread(threadId))
  }

  snoozeThread(threadId: string, wakeAt: number): ThreadLifecycle {
    if (wakeAt <= Date.now()) throw new Error('wake time must be in the future')
    this.#assertLifecycleState(threadId, 'active')
    this.#assertCanHide(threadId)
    return this.#notifyLifecycle(threadId, this.#store.snoozeThread(threadId, wakeAt))
  }

  unsnoozeThread(threadId: string): ThreadLifecycle {
    this.#assertLifecycleState(threadId, 'snoozed')
    return this.#notifyLifecycle(threadId, this.#store.activateThread(threadId))
  }

  setThreadKeepActive(threadId: string, keepActive: boolean): ThreadLifecycle {
    this.#assertLifecycleState(threadId, 'active')
    return this.#notifyLifecycle(threadId, this.#store.setThreadKeepActive(threadId, keepActive))
  }

  markThreadRead(threadId: string): void {
    this.#store.markThreadRead(threadId)
  }

  refreshLifecycle(now = Date.now()): void {
    for (const thread of this.#store.dueSnoozedThreads(now)) {
      this.#notifyLifecycle(thread.id, this.#store.touchThread(thread.id, false, now))
    }

    const days = this.#store.sidebarSettings().autoSettleDays
    if (days === null) return
    const cutoff = now - days * 24 * 60 * 60 * 1_000
    for (const thread of this.#store.inactiveThreads(cutoff)) {
      if (!this.#canHide(thread.id)) continue
      this.#notifyLifecycle(thread.id, this.#store.settleThread(thread.id, 'inactivity', now))
    }
  }

  #wakeForActivity(threadId: string, unread = false): void {
    const before = this.#store.thread(threadId)
    if (!before) return
    const lifecycle = this.#store.touchThread(threadId, unread)
    if (before.lifecycle.state !== 'active') this.#notifyLifecycle(threadId, lifecycle)
  }

  #assertCanHide(threadId: string): void {
    const thread = this.#store.thread(threadId)
    if (!thread) throw new Error('thread not found')
    if (thread.closedAt !== undefined) throw new Error('archived threads cannot change inbox shelf')
    const status = this.inboxStatus(threadId)
    if (['starting', 'working', 'queued', 'approval', 'input'].includes(status)) {
      throw new Error(`cannot hide a thread while its status is ${status}`)
    }
  }

  #assertLifecycleState(threadId: string, expected: 'active' | 'settled' | 'snoozed'): void {
    const thread = this.#store.thread(threadId)
    if (!thread) throw new Error('thread not found')
    if (thread.closedAt !== undefined) throw new Error('archived threads cannot change inbox shelf')
    if (thread.lifecycle.state !== expected) {
      throw new Error(`thread is ${thread.lifecycle.state}, expected ${expected}`)
    }
  }

  #canHide(threadId: string): boolean {
    try {
      this.#assertCanHide(threadId)
      return true
    } catch {
      return false
    }
  }

  #notifyLifecycle(threadId: string, lifecycle: ThreadLifecycle): ThreadLifecycle {
    this.#onLifecycle(threadId, lifecycle)
    return lifecycle
  }

  openTerminal(threadId: string, columns: number, rows: number): string {
    return this.#terminals.open(threadId, this.#repoPath(threadId), columns, rows)
  }

  /**
   * Run a provider install command in its own terminal session. Keyed by
   * target so clicking install twice attaches to the run already going, and
   * rooted in the home directory because a global CLI install has no business
   * inside any particular project checkout.
   */
  installProvider(target: string, command: string, columns: number, rows: number): string {
    return this.#terminals.run(`install:${target}`, command, os.homedir(), columns, rows)
  }

  /**
   * Run a provider's interactive sign-in CLI in its own terminal session.
   * Keyed by target so a second Sign in click reattaches to the session
   * already going, and rooted in the home directory because signing in to a
   * global CLI has no business inside any particular project checkout.
   */
  launchProviderLogin(target: string, command: string, columns: number, rows: number): string {
    return this.#terminals.run(`login:${target}`, command, os.homedir(), columns, rows)
  }

  writeTerminal(terminalId: string, data: string): void {
    this.#terminals.write(terminalId, data)
  }

  resizeTerminal(terminalId: string, columns: number, rows: number): void {
    this.#terminals.resize(terminalId, columns, rows)
  }

  closeTerminal(terminalId: string): void {
    void this.#terminals
      .close(terminalId)
      .catch((error) => this.#onLog(`[terminal] close failed: ${errorMessage(error)}`))
  }

  #repoPath(threadId: string): string {
    const stored = this.#store.thread(threadId)
    if (!stored) throw new Error(`no such thread: ${threadId}`)
    return stored.worktreePath ?? resolveWorkspacePath(stored.projectPath)
  }

  #diffRepoPath(threadId: string): string {
    const worktreePath = this.#store.thread(threadId)?.worktreePath
    if (!worktreePath) throw new Error('diff review requires an isolated session')
    return worktreePath
  }

  async #rejectDiff(threadId: string, review: () => Promise<SessionDiff>): Promise<SessionDiff> {
    if (this.isTurnRunning(threadId)) {
      throw new Error('cannot reject a diff while the agent turn is running')
    }
    if (this.#restoringThreads.has(threadId)) throw new StaleDiffSnapshotError()
    // One rejection at a time per thread: two concurrent reverse-applies pass
    // the same staleness check and then patch the same worktree, and git's
    // fuzz can land the second one at the wrong offset silently. The client
    // retries with a fresh diff on this error.
    if (this.#reviewingDiffs.has(threadId)) throw new StaleDiffSnapshotError()
    this.#reviewingDiffs.add(threadId)
    try {
      return await review()
    } finally {
      this.#reviewingDiffs.delete(threadId)
    }
  }

  async #drainQueue(threadId: string): Promise<void> {
    if (
      !this.#threads.has(threadId) ||
      // A panic stop empties every queue; a drain that was already in flight
      // must not start the turn it grabbed before the panic landed.
      this.#panicStopping ||
      this.#drainingQueues.has(threadId) ||
      this.isTurnRunning(threadId) ||
      this.#designInputByThread.has(threadId)
    ) {
      return
    }
    const queue = this.#queueEntries(threadId)
    const next = queue[0]
    if (!queue || !next) return

    const claimed = this.#store.claimQueuedTurn(threadId, next.id, 'normal')
    if (!claimed) return
    queue.shift()

    this.#drainingQueues.add(threadId)
    this.#notifyQueue(threadId)
    const generation = this.#panicGeneration
    try {
      await this.sendTurn(
        threadId,
        next.text,
        next.attachments,
        next.options,
        next.clientSubmissionId
          ? {
              id: next.clientSubmissionId,
              text: next.text,
              createdAt: next.createdAt,
              queueId: next.id,
            }
          : undefined,
      )
      if (!this.#threads.has(threadId)) return
      if (generation !== this.#panicGeneration) {
        // A panic landed while the adapter call was in flight: the user said
        // stop-everything, so this turn must neither run on nor re-queue.
        await this.#threads.get(threadId)?.session.interrupt(threadId)
        return
      }
      if (!next.clientSubmissionId && !this.#store.completeQueuedTurn(threadId, next.id)) return
      if (!this.#threads.has(threadId) || this.#store.thread(threadId)?.closedAt !== undefined)
        return
      this.#activeTurns.add(threadId)
    } catch {
      if (!this.#threads.has(threadId)) return
      // After a panic the queue was emptied on purpose; putting the grabbed
      // prompt back would resurrect it.
      let restored = false
      if (generation === this.#panicGeneration) {
        restored = this.#store.restoreQueuedTurn(threadId, next.id)
        if (restored) {
          queue.unshift(next)
          this.#notifyQueue(threadId)
        }
      }
      this.#onLog(
        restored
          ? 'could not start queued turn; it remains queued'
          : 'queued turn ended after acceptance or cancellation',
      )
    } finally {
      this.#drainingQueues.delete(threadId)
    }
  }

  #notifyQueue(threadId: string): void {
    if (!this.#threads.has(threadId)) return
    this.#onQueue(threadId, this.queue(threadId))
  }

  #publicQueuedTurn(item: QueuedTurnEntry): QueuedTurn {
    return {
      id: item.id,
      text: item.text,
      attachments: item.attachments.filter((path) => path !== DESIGN_BRIEF_ATTACHMENT),
      createdAt: item.createdAt,
    }
  }

  #queueEntries(threadId: string): QueuedTurnEntry[] {
    const cached = this.#queuedTurns.get(threadId)
    if (cached) return cached
    const restored = this.#store.queuedTurns(threadId).map((turn) => {
      const { threadId: _threadId, intent: _intent, clientSubmissionId, ...entry } = turn
      return { ...entry, ...(clientSubmissionId ? { clientSubmissionId } : {}) }
    })
    this.#queuedTurns.set(threadId, restored)
    return restored
  }

  /** Where the working tree stood before a turn. Silent when there is no repo. */
  async #checkpoint(threadId: string, label: string): Promise<void> {
    const stored = this.#store.thread(threadId)
    if (!stored) return
    const repoPath = this.#repoPath(threadId)

    try {
      const snapshot = await takeSnapshot(repoPath)
      this.#store.addCheckpoint({
        threadId,
        seq: this.#store.lastSeq(threadId),
        commit: snapshot.commit,
        label: label.trim().slice(0, 60) || 'Turn',
      })
    } catch {
      // A folder that is not a repository is a normal case. Failing the turn
      // over a backup the user never asked for would be the wrong trade.
    }
  }

  checkpoints(threadId: string): StoredCheckpoint[] {
    return this.#store.checkpoints(threadId)
  }

  /**
   * Put a session back to a checkpoint — files and conversation together.
   *
   * Returns where the replaced state was saved, because restoring is itself an
   * action someone can regret. Nothing reachable this way is unrecoverable.
   */
  async restoreCheckpoint(threadId: string, checkpointId: number): Promise<{ undo: string }> {
    if (this.isTurnRunning(threadId)) {
      throw new Error('cannot restore during a running turn')
    }
    if (this.#restoringThreads.has(threadId)) {
      throw new Error('cannot restore while another restore is running')
    }
    if (this.#reviewingDiffs.has(threadId)) {
      throw new Error('cannot restore while a diff rejection is running')
    }
    let finishRestore!: () => void
    this.#restoringThreads.set(threadId, new Promise((resolve) => (finishRestore = resolve)))
    try {
      const stored = this.#store.thread(threadId)
      const checkpoint = this.#store.checkpoint(checkpointId)
      if (!stored || !checkpoint || checkpoint.threadId !== threadId) {
        throw new Error('no such checkpoint')
      }

      const repoPath = this.#repoPath(threadId)
      const replaced = await restoreSnapshot(repoPath, checkpoint.commit)

      // Rolling the files back without this would leave the transcript
      // describing work that no longer exists on disk.
      try {
        this.#dropInboxProjection(threadId)
        return { undo: this.#store.saveRestoreUndo(threadId, checkpoint.seq, replaced.commit) }
      } catch (error) {
        await restoreSnapshot(repoPath, replaced.commit)
        throw error
      }
    } finally {
      this.#restoringThreads.delete(threadId)
      finishRestore()
    }
  }

  /** Reverse the latest restore, including both files and conversation. */
  async undoRestore(threadId: string, token: string): Promise<void> {
    if (this.isTurnRunning(threadId)) {
      throw new Error('cannot restore during a running turn')
    }
    if (this.#restoringThreads.has(threadId)) {
      throw new Error('cannot restore while another restore is running')
    }
    if (this.#reviewingDiffs.has(threadId)) {
      throw new Error('cannot restore while a diff rejection is running')
    }
    let finishRestore!: () => void
    this.#restoringThreads.set(threadId, new Promise((resolve) => (finishRestore = resolve)))
    try {
      const stored = this.#store.thread(threadId)
      const undo = this.#store.restoreUndo(threadId, token)
      if (!stored || !undo) throw new Error('restore can no longer be undone')

      const repoPath = this.#repoPath(threadId)
      const replaced = await restoreSnapshot(repoPath, undo.commit)
      try {
        this.#store.applyRestoreUndo(threadId, token)
        this.#dropInboxProjection(threadId)
      } catch (error) {
        await restoreSnapshot(repoPath, replaced.commit)
        throw error
      }
    } finally {
      this.#restoringThreads.delete(threadId)
      finishRestore()
    }
  }

  /** What the agent has changed since a checkpoint, so a restore is informed. */
  async changedSinceCheckpoint(threadId: string, checkpointId: number): Promise<string[]> {
    const stored = this.#store.thread(threadId)
    const checkpoint = this.#store.checkpoint(checkpointId)
    if (!stored || !checkpoint || checkpoint.threadId !== threadId) {
      throw new Error('no such checkpoint')
    }
    return changedSince(this.#repoPath(threadId), checkpoint.commit)
  }

  respondToApproval(threadId: string, approvalId: string, decision: ApprovalDecision): void {
    this.#get(threadId).session.respondToApproval(approvalId, decision)
  }

  /**
   * Change the access level of a live thread. The mode is recorded for the
   * design-flow note and pushed to sessions that keep approval state
   * mutable; engines that mapped the mode onto launch switches keep the
   * sandbox they started with.
   */
  setThreadApproval(threadId: string, approval: ApprovalMode): void {
    const session = this.#get(threadId).session
    this.#threadApprovals.set(threadId, approval)
    session.setApproval?.(approval)
  }

  respondToUserInput(threadId: string, requestId: string, answers: Record<string, string[]>): void {
    const designInput = this.#designInputs.get(requestId)
    if (designInput?.threadId === threadId) {
      this.#designInputs.delete(requestId)
      this.#designInputByThread.delete(threadId)
      this.#record(threadId, { type: 'user_input.resolved', id: requestId })
      const flow = this.#designFlows.get(threadId)
      if (!flow) return

      const noMoreDetails =
        designInput.final &&
        (answers[FINAL_BRIEFING_QUESTION.id] ?? []).some((answer) =>
          answer.startsWith("No, that's everything"),
        )
      if (!noMoreDetails) {
        flow.explicitAnswers.push(
          ...designInput.questions.flatMap((question) => {
            const answer = (answers[question.id] ?? []).join(', ').trim()
            return answer ? [{ question: question.question, answer }] : []
          }),
        )
        this.#saveDesignFlow(threadId)
        this.#recordDesignNote(threadId, designInput.turnId, 'Got it, thanks.')
      }
      if (noMoreDetails && flow.pendingBrief) {
        try {
          this.#completeDesignBrief(threadId, designInput.turnId, flow.pendingBrief)
        } catch (error) {
          const prompt = this.#queueDesignCorrection(threadId, flow, error)
          if (!prompt) {
            this.#failDesignFlow(threadId, error)
            return
          }
          delete flow.pendingPrompt
          this.#saveDesignFlow(threadId)
          void this.#sendDesignTurn(threadId, prompt, [], this.#designTurnOptions(flow)).catch(
            (sendError: unknown) => this.#failDesignFlow(threadId, sendError),
          )
        }
        return
      }

      void this.#sendDesignTurn(
        threadId,
        designBriefingContinuation(designInput.questions, answers),
        [],
        this.#designTurnOptions(flow),
      ).catch((error: unknown) => this.#failDesignFlow(threadId, error))
      return
    }

    const session = this.#get(threadId).session
    if (!session.respondToUserInput) throw new Error('this agent does not support structured input')
    session.respondToUserInput(requestId, answers)
  }

  async interrupt(threadId: string): Promise<void> {
    // "Stop" on a thread that is not live must be a no-op, not an error the
    // user cannot act on.
    const entry = this.#threads.get(threadId)
    if (!entry) return
    await entry.session.interrupt(threadId)
  }

  async panicStop(): Promise<PanicStopResult> {
    const sessions = [...this.#threads.entries()]
    this.#panicStopping = true
    this.#panicGeneration += 1

    try {
      let queueClearFailed = false
      const hideQueues = (threadIds: Iterable<string>) => {
        for (const threadId of threadIds) {
          const cached = this.#queuedTurns.get(threadId)
          this.#queuedTurns.set(threadId, [])
          if (!cached) continue
          try {
            this.#notifyQueue(threadId)
          } catch {
            queueClearFailed = true
          }
        }
      }
      try {
        hideQueues(this.#store.clearAllQueuedTurns())
      } catch {
        queueClearFailed = true
        hideQueues(
          new Set([...sessions.map(([threadId]) => threadId), ...this.#queuedTurns.keys()]),
        )
      }

      const stoppedSessions = await Promise.all(
        sessions.map(async ([threadId, entry]) => {
          let timeout: NodeJS.Timeout | undefined
          try {
            await Promise.race([
              entry.session.interrupt(threadId),
              new Promise<never>((_, reject) => {
                timeout = setTimeout(
                  () => reject(new Error('interrupt timed out; session was force-stopped')),
                  PANIC_STOP_TIMEOUT_MS,
                )
              }),
            ])
            return { threadId, status: 'interrupted' as const }
          } catch (error) {
            this.close(threadId)
            return {
              threadId,
              status: 'failed' as const,
              error: (error instanceof Error ? error.message : String(error)) || 'Unknown error',
            }
          } finally {
            if (timeout) clearTimeout(timeout)
          }
        }),
      )
      if (queueClearFailed) throw new Error('could not clear every queued prompt during Stop all')
      return { sessions: stoppedSessions }
    } finally {
      this.#panicStopping = false
    }
  }

  close(threadId: string): void {
    void this.#terminals
      .closeThread(threadId)
      .catch((error) => this.#onLog(`[terminal] thread close failed: ${errorMessage(error)}`))
    this.#stopDesignPreview(threadId)
    this.#inboxProjections.delete(threadId)
    const entry = this.#threads.get(threadId)
    if (entry) {
      entry.session.dispose()
      this.#threads.delete(threadId)
    }
    this.#threadApprovals.delete(threadId)
    this.#activeTurns.delete(threadId)
    const activeTurnId = this.#activeTurnIds.get(threadId)
    this.#activeTurnIds.delete(threadId)
    if (activeTurnId) this.#serverOwnedUserTurns.delete(userTurnKey(threadId, activeTurnId))
    this.#suppressedUserItems.delete(threadId)
    this.#inFlightSubmissionIds.delete(threadId)
    this.#startingTurns.delete(threadId)
    this.#pendingTurnStarts.delete(threadId)
    this.#acceptedTurnStarts.delete(threadId)
    this.#designStartingThreads.delete(threadId)
    this.#reviewingDiffs.delete(threadId)
    this.#queuedTurns.delete(threadId)
    this.#drainingQueues.delete(threadId)
    this.#clearDesignFlow(threadId)
    // Always mark closed, live entry or not: closing is the user's statement
    // about the thread. Early-returning when no session was attached left a
    // thread mid-resume unmarked, so the resume guard never saw the close
    // and attached a zombie anyway.
    //
    // Marked closed, not deleted. Ending the process is not the same as
    // wanting the transcript gone.
    //
    // The worktree deliberately survives: it may hold work the agent did not
    // commit, and closing a session is not a statement about that work.
    this.#store.closeThread(threadId)
  }

  /**
   * Whether a session's private checkout still holds work nobody has seen.
   *
   * Asked before offering to discard it, so the choice is put to the user in
   * terms of what they would lose rather than as a routine tidy-up.
   */
  async hasUnsavedWork(threadId: string): Promise<boolean> {
    const stored = this.#store.thread(threadId)
    if (!stored?.worktreePath) return false
    return hasUncommittedChanges(stored.worktreePath)
  }

  /**
   * Remove a session's private checkout.
   *
   * Refuses when the agent left uncommitted work unless `force` — which is the
   * user answering "yes, discard it", never a default. The branch is kept
   * either way; it holds whatever was committed.
   */
  async discardWorktree(threadId: string, force = false): Promise<void> {
    const stored = this.#store.thread(threadId)
    if (!stored?.worktreePath || !stored.worktreeBranch) return

    await this.#terminals.closeThread(threadId)

    await removeWorktree(
      {
        path: stored.worktreePath,
        branch: stored.worktreeBranch,
        repoPath: resolveWorkspacePath(stored.projectPath),
      },
      force,
    )
    this.#store.forgetWorktree(threadId)
  }

  /**
   * Clear up after a crash.
   *
   * A process killed mid-session leaves git believing in checkouts that are
   * gone, and the next session on that path fails with a message about a path
   * being "already registered" — our leftovers, reported to someone who did
   * nothing wrong. Only worktrees whose directory has already vanished are
   * forgotten; anything still on disk may hold work.
   */
  async recoverWorktrees(): Promise<void> {
    const repos = new Set(
      this.#store.worktrees().map((entry) => resolveWorkspacePath(entry.repoPath)),
    )
    for (const repo of repos) {
      await pruneWorktrees(repo).catch(() => undefined)
    }

    for (const entry of this.#store.worktrees()) {
      if (!existsSync(entry.path)) this.#store.forgetWorktree(entry.threadId)
    }
  }

  async disposeAll(): Promise<void> {
    const terminalsClosed = this.#terminals.closeAll()
    for (const controller of this.#voiceRequests.values()) controller.abort()
    this.#voiceRequests.clear()
    for (const [, entry] of this.#threads) entry.session.dispose()
    this.#threads.clear()
    this.#activeTurns.clear()
    this.#activeTurnIds.clear()
    this.#serverOwnedUserTurns.clear()
    this.#suppressedUserItems.clear()
    this.#inFlightSubmissionIds.clear()
    this.#startingTurns.clear()
    this.#pendingTurnStarts.clear()
    this.#acceptedTurnStarts.clear()
    this.#reviewingDiffs.clear()
    this.#queuedTurns.clear()
    this.#drainingQueues.clear()
    this.#designFlows.clear()
    this.#designTurns.clear()
    this.#designStartingThreads.clear()
    this.#designMessageItems.clear()
    this.#acceptedDesignOutputs.clear()
    this.#designOutputErrors.clear()
    this.#designActivityItems.clear()
    this.#designInputs.clear()
    this.#designInputByThread.clear()
    for (const preview of this.#designPreviews.values()) void preview.stop()
    this.#designPreviews.clear()
    this.#resumingThreads.clear()
    void this.#controlStarting?.then(
      (adapter) => adapter.dispose(),
      () => undefined,
    )
    this.#controlStarting = undefined
    this.#control?.dispose()
    this.#control = undefined
    await terminalsClosed
  }

  #get(threadId: string) {
    const entry = this.#threads.get(threadId)
    if (!entry) throw new Error(`no such thread: ${threadId}`)
    return entry
  }

  async #ensureThread(threadId: string): Promise<void> {
    if (this.#threads.has(threadId)) return
    const existing = this.#resumingThreads.get(threadId)
    if (existing) return existing

    const pending = this.#resumeThread(threadId).finally(() =>
      this.#resumingThreads.delete(threadId),
    )
    this.#resumingThreads.set(threadId, pending)
    return pending
  }

  async #resumeThread(threadId: string): Promise<void> {
    const stored = this.#store.thread(threadId)
    if (!stored || stored.closedAt !== undefined) throw new Error(`no such thread: ${threadId}`)

    const runtime = this.#runtimeFor(stored.provider, this.#onLog)
    if (!runtime.resume) {
      throw new Error(`${stored.provider} sessions cannot resume after Harness restarts yet`)
    }
    const workspacePath = stored.worktreePath ?? resolveWorkspacePath(stored.projectPath)
    const result = await runtime.resume(threadId, workspacePath, {
      ...(stored.agent ? { agent: stored.agent } : {}),
      instructions: REPLY_STYLE_INSTRUCTIONS,
      ...this.#mcpRuntimeOptions(stored.provider, stored.projectPath),
    })
    if (result.thread.id !== threadId) {
      result.session.dispose()
      throw new Error(`provider resumed unexpected thread ${result.thread.id}`)
    }
    // The thread may have been closed while the provider was resuming; a
    // late attach would leave a zombie agent process nobody can reach.
    if (this.#store.thread(threadId)?.closedAt !== undefined) {
      result.session.dispose()
      throw new Error(`thread ${threadId} was closed while resuming`)
    }
    this.#attachThread(result.thread, result.session, stored.projectPath)
    this.#restoreDesignFlow(threadId, workspacePath)
  }

  #restoreDesignFlow(threadId: string, workspacePath: string): void {
    const flow = parseStoredDesignFlow(this.#store.designRun(threadId), workspacePath)
    if (!flow) return
    this.#designFlows.set(threadId, flow)

    const unresolved = unresolvedDesignInput(this.#store.history(threadId))
    if (unresolved) {
      this.#designInputs.set(unresolved.id, {
        threadId,
        turnId: unresolved.turnId,
        questions: unresolved.questions,
        final: unresolved.questions.every((question) => question.id === FINAL_BRIEFING_QUESTION.id),
      })
      this.#designInputByThread.set(threadId, unresolved.id)
      return
    }

    const openTurnId = openTurn(this.#store.history(threadId))
    if (openTurnId) {
      this.#designTurns.set(openTurnId, threadId)
      return
    }

    if (flow.completion) {
      this.#finishDesignFlow(threadId, `design-resumed-${crypto.randomUUID()}`, flow.completion)
      return
    }

    // Building the prompt reads .design/*.json from the workspace — files the
    // user may have deleted since the run was persisted. A throw here would
    // leave #designFlows set with nothing to ever clear it, and the send
    // guard would silently queue every future prompt on this thread forever.
    let prompt: string
    try {
      prompt = flow.pendingPrompt ?? this.#designPromptFor(flow)
    } catch (error) {
      this.#failDesignFlow(threadId, error)
      return
    }
    delete flow.pendingPrompt
    this.#saveDesignFlow(threadId)
    void this.#sendDesignTurn(
      threadId,
      prompt,
      this.#designAttachmentsFor(flow),
      this.#designTurnOptions(flow),
    ).catch((error: unknown) => this.#failDesignFlow(threadId, error))
  }

  /**
   * Qualification and briefing deliberately run fast; every phase after the
   * validated brief gets the user's own effort back. Storing lowered options
   * on the flow instead used to give the whole run briefing effort
   * (docs/DESIGN-AGENT.md, critical gap 3).
   */
  #designTurnOptions(flow: DesignFlow): TurnOptions {
    return flow.phase === 'brief' ? { ...flow.options, effort: 'low' } : flow.options
  }

  #designPromptFor(flow: DesignFlow): string {
    if (flow.phase === 'brief') return designBriefingPrompt(flow.originalRequest)
    const brief = readDesignBrief(flow.workspacePath)
    if (flow.phase === 'brand') return designBrandPrompt(brief)
    const brand = readBrandSystem(flow.workspacePath)
    if (flow.phase === 'page') return designPagePrompt(brief, brand)
    const page = readPageBlueprint(flow.workspacePath)
    if (flow.phase === 'assets') return designAssetPrompt(brief, brand, page)
    if (flow.phase === 'build') {
      return designBuildPrompt(brief, brand, page, readAssetManifest(flow.workspacePath))
    }
    if (flow.phase === 'preview') return designPreviewPrompt()
    if (flow.phase === 'review' && flow.screenshots) {
      return designReviewPrompt(brief, brand, page, flow.screenshots)
    }
    if (flow.phase === 'repair' && flow.review) {
      return designRepairPrompt(flow.review, flow.repairAttempt, DESIGN_REPAIR_LIMIT)
    }
    throw new Error(`cannot resume design phase ${flow.phase}`)
  }

  #designAttachmentsFor(flow: DesignFlow): string[] {
    return flow.phase === 'review' ? (flow.screenshots?.map(({ path }) => path) ?? []) : []
  }

  async #sendDesignTurn(
    threadId: string,
    prompt: string,
    attachments: string[],
    options: TurnOptions,
    pendingStart = this.#beginTurnStart(threadId),
  ): Promise<string> {
    for (const [turnId, owner] of this.#designTurns) {
      if (owner === threadId) {
        this.#acceptedDesignOutputs.delete(turnId)
        this.#designOutputErrors.delete(turnId)
      }
    }
    this.#designStartingThreads.add(threadId)
    try {
      const turnId = await this.#get(threadId).session.sendTurn(
        threadId,
        prompt,
        attachments,
        options,
      )
      this.#acceptTurnStart(threadId, turnId, pendingStart)
      this.#designTurns.set(turnId, threadId)
      const flow = this.#designFlows.get(threadId)
      if (flow) {
        const item: Item = {
          id: `design-activity-${crypto.randomUUID()}`,
          turnId,
          type: 'tool_call',
          status: 'started',
          text: `design:${flow.phase}`,
          createdAt: Date.now(),
        }
        this.#designActivityItems.set(turnId, item)
        this.#record(threadId, { type: 'item.started', item })
      }
      return turnId
    } finally {
      this.#forgetPendingTurnStart(threadId, pendingStart)
      this.#designStartingThreads.delete(threadId)
    }
  }

  #acceptTurnStart(threadId: string, turnId: string, pendingStart: PendingTurnStart): void {
    if (this.#pendingTurnStarts.get(threadId) !== pendingStart) return
    this.#pendingTurnStarts.delete(threadId)
    this.#activeTurnIds.set(threadId, turnId)
    const starts = this.#acceptedTurnStarts.get(threadId) ?? new Map<string, PendingTurnStart>()
    starts.set(turnId, pendingStart)
    this.#acceptedTurnStarts.set(threadId, starts)
    if (pendingStart.submission) {
      this.#recordUserSubmission(threadId, turnId, pendingStart.submission)
    }
  }

  #beginTurnStart(threadId: string, submission?: UserSubmission): PendingTurnStart {
    const pending = { acceptedAt: Date.now(), ...(submission ? { submission } : {}) }
    this.#pendingTurnStarts.set(threadId, pending)
    return pending
  }

  #forgetPendingTurnStart(threadId: string, pending: PendingTurnStart): void {
    if (this.#pendingTurnStarts.get(threadId) === pending) {
      this.#pendingTurnStarts.delete(threadId)
    }
  }

  #assertFreshSubmissionId(threadId: string, clientSubmissionId: string): void {
    const pending = this.#pendingTurnStarts.get(threadId)?.submission?.id === clientSubmissionId
    const accepted = [...(this.#acceptedTurnStarts.get(threadId)?.values() ?? [])].some(
      (start) => start.submission?.id === clientSubmissionId,
    )
    const queued = this.#queueEntries(threadId).some(
      (turn) => turn.clientSubmissionId === clientSubmissionId,
    )
    const inFlight = this.#inFlightSubmissionIds.get(threadId)?.has(clientSubmissionId)
    if (
      pending ||
      accepted ||
      queued ||
      inFlight ||
      this.#store.hasQueuedSubmission(threadId, clientSubmissionId) ||
      this.#store.hasItem(threadId, clientSubmissionId)
    ) {
      throw new Error(`clientSubmissionId "${clientSubmissionId}" was already used for this thread`)
    }
  }

  #handleSessionEvent(threadId: string, event: DomainEvent): void {
    const suppressedUserItems = this.#suppressedUserItems.get(threadId)
    if (event.type === 'item.delta' && suppressedUserItems?.has(event.itemId)) return
    if (
      (event.type === 'item.started' || event.type === 'item.completed') &&
      event.item.type === 'message' &&
      event.item.role === 'user' &&
      (this.#serverOwnedUserTurns.has(userTurnKey(threadId, event.item.turnId)) ||
        this.#pendingTurnStarts.get(threadId)?.submission !== undefined ||
        this.#acceptedTurnStarts.get(threadId)?.get(event.item.turnId)?.submission !== undefined)
    ) {
      if (event.type === 'item.started') {
        const itemIds = suppressedUserItems ?? new Set<string>()
        itemIds.add(event.item.id)
        this.#suppressedUserItems.set(threadId, itemIds)
      } else {
        suppressedUserItems?.delete(event.item.id)
      }
      return
    }
    if (event.type === 'thread.error' && this.#designFlows.has(threadId)) {
      this.#clearDesignFlow(threadId)
      this.#record(threadId, event)
      void this.#drainQueue(threadId)
      return
    }
    if (event.type === 'turn.started' && this.#designStartingThreads.has(threadId)) {
      this.#designTurns.set(event.turn.id, threadId)
    }

    const turnId =
      event.type === 'turn.started'
        ? event.turn.id
        : 'turnId' in event
          ? event.turnId
          : event.type === 'item.started' || event.type === 'item.completed'
            ? event.item.turnId
            : undefined
    if (!turnId || this.#designTurns.get(turnId) !== threadId) {
      this.#record(threadId, event)
      return
    }

    if (
      (event.type === 'item.started' || event.type === 'item.completed') &&
      event.item.type === 'message' &&
      event.item.role === 'user'
    ) {
      const flow = this.#designFlows.get(threadId)
      if (flow && !flow.askedQuestions) {
        this.#record(threadId, { ...event, item: { ...event.item, text: flow.originalRequest } })
      }
      return
    }

    if (
      event.type === 'item.started' &&
      event.item.type === 'message' &&
      event.item.role === 'assistant'
    ) {
      this.#designMessageItems.add(event.item.id)
      return
    }
    if (event.type === 'item.delta' && this.#designMessageItems.has(event.itemId)) return
    if (
      event.type === 'item.completed' &&
      event.item.type === 'message' &&
      event.item.role === 'assistant'
    ) {
      this.#designMessageItems.delete(event.item.id)
      if (this.#acceptedDesignOutputs.has(turnId)) return
      try {
        this.#handleDesignOutput(threadId, turnId, event.item.text ?? '')
        // Only while the flow is still ours. A 'not a design task' verdict
        // clears the flow inside the call above, which detaches this turn —
        // re-adding it here left an entry only disposeAll could release.
        if (this.#designTurns.get(turnId) === threadId) {
          this.#acceptedDesignOutputs.add(turnId)
        }
      } catch (error) {
        this.#designOutputErrors.set(turnId, error)
      }
      return
    }
    if (event.type === 'turn.completed') {
      const acceptedOutput = this.#acceptedDesignOutputs.delete(turnId)
      const outputError = this.#designOutputErrors.get(turnId)
      this.#designOutputErrors.delete(turnId)
      this.#completeDesignActivity(
        threadId,
        turnId,
        event.status === 'completed' ? 'completed' : 'failed',
      )
      this.#designTurns.delete(turnId)
      if (event.status !== 'completed') {
        this.#clearDesignFlow(threadId)
        this.#record(threadId, event)
        void this.#drainQueue(threadId)
        return
      }
      let flow = this.#designFlows.get(threadId)
      if (!acceptedOutput && outputError && flow) {
        if (!this.#queueDesignCorrection(threadId, flow, outputError)) {
          this.#failDesignFlow(threadId, outputError)
          return
        }
        flow = this.#designFlows.get(threadId)
      }
      if (flow?.completion) {
        this.#record(threadId, event)
        this.#finishDesignFlow(threadId, turnId, flow.completion)
        return
      }
      if (flow?.pendingPrompt) {
        const prompt = flow.pendingPrompt
        delete flow.pendingPrompt
        this.#saveDesignFlow(threadId)
        this.#record(threadId, event)
        void this.#sendDesignTurn(
          threadId,
          prompt,
          this.#designAttachmentsFor(flow),
          this.#designTurnOptions(flow),
        ).catch((error: unknown) => this.#failDesignFlow(threadId, error))
        return
      }
    }
    this.#record(threadId, event)
  }

  #handleDesignOutput(threadId: string, turnId: string, text: string): void {
    const flow = this.#designFlows.get(threadId)
    if (!flow) return

    if (flow.phase !== 'brief') {
      this.#completeDesignPhase(threadId, turnId, flow, text)
      return
    }
    const output = parseBriefingOutput(text)
    flow.correcting = false
    if (output.status === 'questions') {
      const round = flow.askedQuestions ? 'follow-up' : 'first'
      flow.askedQuestions = true
      flow.finalAsked = false
      flow.pendingBrief = undefined
      this.#saveDesignFlow(threadId)
      this.#requestDesignInput(threadId, turnId, output.questions, false, round)
      return
    }
    if (output.status === 'not_design') {
      this.#clearDesignFlow(threadId)
      this.#record(threadId, {
        type: 'item.completed',
        item: {
          id: `design-not-applicable-${crypto.randomUUID()}`,
          turnId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          text: 'Design mode was turned off because this request is not a website design task.',
          createdAt: Date.now(),
        },
      })
      return
    }
    if (flow.askedQuestions && !flow.finalAsked) {
      flow.pendingBrief = output.brief
      flow.finalAsked = true
      this.#saveDesignFlow(threadId)
      this.#requestDesignInput(threadId, turnId, [FINAL_BRIEFING_QUESTION], true)
      return
    }
    this.#completeDesignBrief(threadId, turnId, output.brief)
  }

  #recordDesignNote(threadId: string, turnId: string, text: string): void {
    this.#record(threadId, {
      type: 'item.completed',
      item: {
        id: `design-note-${crypto.randomUUID()}`,
        turnId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        text,
        createdAt: Date.now(),
      },
    })
  }

  #requestDesignInput(
    threadId: string,
    turnId: string,
    questions: BriefingQuestion[],
    final: boolean,
    round: 'first' | 'follow-up' | 'final' = 'final',
  ): void {
    if (round === 'first') {
      this.#recordDesignNote(
        threadId,
        turnId,
        'I have a few questions before designing — they are right below.',
      )
    }
    if (round === 'follow-up') {
      this.#recordDesignNote(
        threadId,
        turnId,
        'Some answers need one more pass — please take another look below.',
      )
    }
    const id = crypto.randomUUID()
    this.#designInputs.set(id, { threadId, turnId, questions, final })
    this.#designInputByThread.set(threadId, id)
    this.#record(threadId, {
      type: 'user_input.requested',
      request: {
        id,
        turnId,
        questions: questions.map((question): UserInputQuestion => ({
          id: question.id,
          header: question.header,
          question: question.question,
          allowOther: question.allowOther,
          secret: false,
          options: question.options,
        })),
        autoResolutionMs: null,
        createdAt: Date.now(),
      },
    })
  }

  #completeDesignBrief(threadId: string, turnId: string, brief: unknown): void {
    const flow = this.#designFlows.get(threadId)
    if (!flow) return
    const saved = writeDesignBrief(
      flow.workspacePath,
      typeof brief === 'object' && brief !== null && !Array.isArray(brief)
        ? { ...brief, explicitAnswers: flow.explicitAnswers }
        : brief,
    )
    this.#recordDesignNote(threadId, turnId, 'Brief locked in. Starting the design.')
    flow.phase = 'brand'
    const prompt = designBrandPrompt(saved)
    if (this.#activeTurns.has(threadId)) {
      flow.pendingPrompt = prompt
      this.#saveDesignFlow(threadId)
      return
    }
    this.#saveDesignFlow(threadId)
    void this.#sendDesignTurn(threadId, prompt, [], this.#designTurnOptions(flow)).catch(
      (error: unknown) => this.#failDesignFlow(threadId, error),
    )
  }

  #completeDesignPhase(threadId: string, turnId: string, flow: DesignFlow, text: string): void {
    if (flow.phase === 'brand') {
      const output = parseBrandPhaseOutput(text)
      flow.correcting = false
      const brand = writeBrandSystem(flow.workspacePath, output)
      flow.phase = 'page'
      flow.pendingPrompt = designPagePrompt(readDesignBrief(flow.workspacePath), brand)
      this.#saveDesignFlow(threadId)
      return
    }
    if (flow.phase === 'page') {
      const output = parsePagePhaseOutput(text)
      flow.correcting = false
      const page = writePageBlueprint(flow.workspacePath, output)
      flow.phase = 'assets'
      flow.pendingPrompt = designAssetPrompt(
        readDesignBrief(flow.workspacePath),
        readBrandSystem(flow.workspacePath),
        page,
      )
      this.#saveDesignFlow(threadId)
      return
    }
    if (flow.phase === 'assets') {
      const output = parseAssetPhaseOutput(text)
      flow.correcting = false
      const assets = writeAssetManifest(flow.workspacePath, output)
      flow.phase = 'build'
      flow.pendingPrompt = designBuildPrompt(
        readDesignBrief(flow.workspacePath),
        readBrandSystem(flow.workspacePath),
        readPageBlueprint(flow.workspacePath),
        assets,
      )
      this.#saveDesignFlow(threadId)
      return
    }
    if (flow.phase === 'build') {
      const output = parseBuildPhaseOutput(text)
      if (output.status === 'failed') throw new Error(output.error)
      validateExactBuildFiles(flow.workspacePath, readDesignBrief(flow.workspacePath))
      flow.correcting = false
      flow.phase = 'preview'
      flow.pendingPrompt = designPreviewPrompt()
      this.#saveDesignFlow(threadId)
      return
    }
    if (flow.phase === 'preview') {
      const plan = parsePreviewPhaseOutput(text)
      flow.correcting = false
      void this.#startDesignPreview(threadId, turnId, flow, plan).catch((error: unknown) =>
        this.#failDesignFlow(threadId, error),
      )
      return
    }
    if (flow.phase === 'review') {
      const review = writeVisualReview(flow.workspacePath, parseReviewPhaseOutput(text))
      flow.correcting = false
      flow.review = review
      if (review.verdict === 'pass') {
        flow.phase = 'complete'
        flow.completion = `Preview ready at ${flow.previewUrl}. Visual review passed${
          flow.repairAttempt
            ? ` after ${flow.repairAttempt} repair attempt${flow.repairAttempt === 1 ? '' : 's'}`
            : ''
        }.`
      } else if (flow.repairAttempt >= DESIGN_REPAIR_LIMIT) {
        flow.phase = 'complete'
        flow.completion = `Preview ready at ${flow.previewUrl}. Visual review stopped after ${DESIGN_REPAIR_LIMIT} repair attempts with ${review.findings.length} finding${review.findings.length === 1 ? '' : 's'} remaining.`
      } else {
        flow.phase = 'repair'
        flow.repairAttempt += 1
        flow.pendingPrompt = designRepairPrompt(review, flow.repairAttempt, DESIGN_REPAIR_LIMIT)
      }
      this.#saveDesignFlow(threadId)
      return
    }
    if (flow.phase === 'repair') {
      const output = parseRepairPhaseOutput(text)
      flow.correcting = false
      if (output.status === 'failed') throw new Error(output.summary)
      void this.#captureDesignReview(threadId, turnId, flow).catch((error: unknown) =>
        this.#failDesignFlow(threadId, error),
      )
      return
    }
    throw new Error(`unexpected design phase ${flow.phase}`)
  }

  #finishDesignFlow(threadId: string, turnId: string, summary: string): void {
    this.#clearDesignFlow(threadId)
    this.#record(threadId, {
      type: 'item.completed',
      item: {
        id: `design-complete-${crypto.randomUUID()}`,
        turnId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        text: `Website built. ${summary}`,
        createdAt: Date.now(),
      },
    })
    void this.#drainQueue(threadId)
  }

  async #startDesignPreview(
    threadId: string,
    turnId: string,
    flow: DesignFlow,
    plan: ReturnType<typeof parsePreviewPhaseOutput>,
  ): Promise<void> {
    const preview = await startDesignPreview(flow.workspacePath, plan)
    this.#designPreviews.set(threadId, preview)
    flow.previewPlan = plan
    flow.previewUrl = preview.url
    if (!this.#get(threadId).session.capabilities.images) {
      this.#finishWithoutVisualReview(
        threadId,
        turnId,
        flow,
        'the selected provider does not declare image support',
      )
      return
    }
    await this.#captureDesignReview(threadId, turnId, flow)
  }

  async #captureDesignReview(threadId: string, turnId: string, flow: DesignFlow): Promise<void> {
    if (!flow.previewPlan || !flow.previewUrl) throw new Error('Preview plan is unavailable')
    if (!this.#capturePreview) {
      this.#finishWithoutVisualReview(threadId, turnId, flow, 'desktop capture is unavailable')
      return
    }
    if (!this.#designPreviews.has(threadId)) {
      const preview = await startDesignPreview(flow.workspacePath, flow.previewPlan)
      this.#designPreviews.set(threadId, preview)
      flow.previewUrl = preview.url
    }
    const screenshots = await this.#capturePreview(
      flow.previewUrl,
      flow.previewPlan.viewports.map(({ width, height }) => ({ width, height })),
    )
    if (!screenshots) {
      this.#finishWithoutVisualReview(threadId, turnId, flow, 'desktop capture is unavailable')
      return
    }
    flow.phase = 'review'
    flow.screenshots = screenshots
    flow.pendingPrompt = designReviewPrompt(
      readDesignBrief(flow.workspacePath),
      readBrandSystem(flow.workspacePath),
      readPageBlueprint(flow.workspacePath),
      screenshots,
    )
    this.#saveDesignFlow(threadId)
    this.#completeDesignActivity(threadId, turnId)
    if (this.#activeTurns.has(threadId)) return

    const prompt = flow.pendingPrompt
    delete flow.pendingPrompt
    this.#saveDesignFlow(threadId)
    await this.#sendDesignTurn(
      threadId,
      prompt,
      this.#designAttachmentsFor(flow),
      this.#designTurnOptions(flow),
    )
  }

  #finishWithoutVisualReview(
    threadId: string,
    turnId: string,
    flow: DesignFlow,
    reason: string,
  ): void {
    flow.phase = 'complete'
    flow.completion = `Preview ready at ${flow.previewUrl}. Visual review skipped because ${reason}.`
    this.#saveDesignFlow(threadId)
    this.#completeDesignActivity(threadId, turnId)
    this.#finishDesignFlow(threadId, turnId, flow.completion)
  }

  #failDesignFlow(threadId: string, error: unknown): void {
    this.#clearDesignFlow(threadId)
    const detail = error instanceof Error ? error.message : String(error)
    // A raw JSON.parse message reads as gibberish in the transcript; name
    // what actually happened before quoting it.
    const message = /JSON|Unexpected token/i.test(detail)
      ? `Design mode failed: the agent answered in prose instead of the structured report Harness expects. Running the design again usually recovers. (${detail})`
      : `Design mode failed: ${detail}`
    this.#record(threadId, { type: 'thread.error', threadId, message })
    // Prompts typed during the flow queued behind the design guard; every
    // other design exit drains, and this one stranding them meant a failed
    // design run left "queued" messages sitting until the user sent another.
    void this.#drainQueue(threadId)
  }

  #queueDesignCorrection(threadId: string, flow: DesignFlow, error: unknown): string | undefined {
    if (flow.correcting) return undefined
    flow.correcting = true
    const detail = error instanceof Error ? error.message : String(error)
    const prompt =
      flow.phase === 'build' && error instanceof ExactBuildFilesError
        ? designBuildCorrectionPrompt(detail)
        : designPhaseCorrectionPrompt(detail)
    flow.pendingPrompt = prompt
    this.#saveDesignFlow(threadId)
    return prompt
  }

  /**
   * Stop the dev server a design run started, if any.
   *
   * It is a real spawned process with its cwd inside the session's worktree.
   * Left running it holds a port and, on Windows, a lock on the checkout —
   * which then makes removing that worktree fail with a git error the user
   * cannot act on.
   */
  #stopDesignPreview(threadId: string): void {
    const preview = this.#designPreviews.get(threadId)
    if (!preview) return
    this.#designPreviews.delete(threadId)
    void preview.stop()
  }

  #clearDesignFlow(threadId: string): void {
    // The flow is over however it ended — completed, failed, or "not a design
    // task". Its preview server has no owner left to stop it.
    this.#stopDesignPreview(threadId)
    this.#designFlows.delete(threadId)
    this.#store.deleteDesignRun(threadId)
    const requestId = this.#designInputByThread.get(threadId)
    if (requestId) this.#designInputs.delete(requestId)
    this.#designInputByThread.delete(threadId)
    for (const [turnId, owner] of this.#designTurns) {
      if (owner === threadId) {
        this.#designTurns.delete(turnId)
        this.#acceptedDesignOutputs.delete(turnId)
        this.#designOutputErrors.delete(turnId)
        this.#designActivityItems.delete(turnId)
      }
    }
    // Item ids normally self-delete on item.completed; a design turn that
    // died mid-item leaves its entry behind. Only safe to empty the whole set
    // when no flow anywhere is live — it is global, and clearing it per
    // thread would drop another thread's in-flight ids.
    if (this.#designFlows.size === 0) this.#designMessageItems.clear()
  }

  /** Drop per-project watch state when a project leaves the sidebar. */
  forgetProject(projectPath: string): void {
    this.#watchedSkillProjects.delete(projectPath)
    this.#watchedMcpProjects.delete(projectPath)
  }

  #completeDesignActivity(
    threadId: string,
    turnId: string,
    status: 'completed' | 'failed' = 'completed',
  ): void {
    const item = this.#designActivityItems.get(turnId)
    if (!item) return
    this.#designActivityItems.delete(turnId)
    this.#record(threadId, {
      type: 'item.completed',
      item: { ...item, status },
    })
  }

  #saveDesignFlow(threadId: string): void {
    const flow = this.#designFlows.get(threadId)
    if (flow) this.#store.setDesignRun(threadId, flow)
  }

  #attachThread(
    thread: Thread,
    session: AgentSession,
    projectPath: string,
    worktree?: Worktree,
  ): void {
    // A racing double-attach must not silently drop the previous session's
    // process — dispose it before overwriting.
    this.#threads.get(thread.id)?.session.dispose()
    this.#threads.set(thread.id, { thread, session, ...(worktree ? { worktree } : {}) })
    session.onMcpOAuth?.((result) => this.#onMcpOAuth(thread.provider, projectPath, result))
    session.onUsageChanged?.(() => {
      if (this.#threads.get(thread.id)?.session === session) {
        this.#onUsageChanged(thread.provider)
      }
    })
    session.on('event', (event) => this.#handleSessionEvent(thread.id, event))
  }
}
