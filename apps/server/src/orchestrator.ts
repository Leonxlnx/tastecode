import {
  CODEX_MCP_CAPABILITIES,
  CODEX_SKILL_CAPABILITIES,
  CodexAdapter,
} from '@harness/adapter-codex'
import {
  DESIGN_BRIEF_ATTACHMENT,
  FINAL_BRIEFING_QUESTION,
  designBriefingContinuation,
  designBriefingPrompt,
  parseBriefingOutput,
  writeDesignBrief,
  type BriefingQuestion,
} from '@harness/design-agent'
import {
  providerRuntime,
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
  DiffDecision,
  DomainEvent,
  McpCapabilities,
  McpServer,
  McpServerConfig,
  Model,
  PanicStopResult,
  ParamsOf,
  ProviderId,
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
import { readSessionDiff, reviewDiffFile, reviewDiffHunk } from './diff-review.js'
import { McpConfigStore } from './mcp-config.js'
import { readCredential } from './credentials.js'
import { TerminalManager } from './terminal.js'
import { installLocalSkill } from './skill-install.js'

type QueuedTurnEntry = QueuedTurn & { options: TurnOptions }
type QueueState = { items: QueuedTurn[]; canSteer: boolean }
type DesignFlow = {
  workspacePath: string
  options: TurnOptions
  askedQuestions: boolean
  finalAsked: boolean
  pendingBrief?: unknown
}
type DesignInput = {
  threadId: string
  turnId: string
  questions: BriefingQuestion[]
  final: boolean
}
const PANIC_STOP_TIMEOUT_MS = 5_000
const UNSUPPORTED_MCP_CAPABILITIES: McpCapabilities = {
  inventory: false,
  add: false,
  update: false,
  remove: false,
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
  #activeTurns = new Set<string>()
  #startingTurns = new Set<string>()
  #reviewingDiffs = new Set<string>()
  #queuedTurns = new Map<string, QueuedTurnEntry[]>()
  #drainingQueues = new Set<string>()
  #designFlows = new Map<string, DesignFlow>()
  #designTurns = new Map<string, string>()
  #designStartingThreads = new Set<string>()
  #designMessageItems = new Set<string>()
  #designInputs = new Map<string, DesignInput>()
  #designInputByThread = new Map<string, string>()
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
  #onSkillsChanged: (provider: ProviderId, projectPath: string) => void
  #onLifecycle: (threadId: string, lifecycle: ThreadLifecycle) => void
  #watchedSkillProjects = new Set<string>()
  #mcpConfig: McpConfigStore
  #readCredential: (reference: string) => string
  #terminals: TerminalManager

  /**
   * How a provider is turned into a running session. Injectable so the
   * concurrency behaviour can be tested without spawning real agents — the
   * property worth protecting is that sessions do not block or cross-wire each
   * other, and that is about this class, not about any vendor.
   */
  #runtimeFor: (provider: ProviderId, onLog: (line: string) => void) => ProviderRuntime

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
      onSkillsChanged?: (provider: ProviderId, projectPath: string) => void
      onLifecycle?: (threadId: string, lifecycle: ThreadLifecycle) => void
      mcpConfig?: McpConfigStore
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
    this.#onSkillsChanged = handlers.onSkillsChanged ?? (() => {})
    this.#onLifecycle = handlers.onLifecycle ?? (() => {})
    this.#mcpConfig = handlers.mcpConfig ?? new McpConfigStore()
    this.#readCredential = handlers.readCredential ?? readCredential
    this.#terminals = new TerminalManager({
      onOutput: handlers.onTerminalOutput ?? (() => {}),
      onExit: handlers.onTerminalExit ?? (() => {}),
    })
    this.#runtimeFor = handlers.runtimeFor ?? providerRuntime
  }

  /**
   * A single long-lived adapter for everything that is not a thread: models,
   * account, sign-in. It has to outlive a request because the OAuth completion
   * arrives as a notification minutes later, on the same connection that
   * started the flow.
   */
  #control: CodexAdapter | undefined
  #voiceRequests = new Map<string, AbortController>()

  async #controlAdapter(): Promise<CodexAdapter> {
    if (this.#control) return this.#control
    const adapter = new CodexAdapter()
    adapter.on('log', (line) => this.#onLog(line))
    adapter.on('login', (result) => this.#onLogin('codex', result))
    adapter.on('skillsChanged', () => {
      for (const projectPath of this.#watchedSkillProjects) {
        this.#onSkillsChanged('codex', projectPath)
      }
    })
    await adapter.start()
    this.#control = adapter
    return adapter
  }

  async listModels(provider: ProviderId): Promise<Model[]> {
    // Codex has a control adapter already running; everything else asks its
    // own runtime, which is free to answer with nothing.
    if (provider === 'codex') return (await this.#controlAdapter()).listModels()
    return providerRuntime(provider, this.#onLog).listModels()
  }

  async listMcpServers(
    provider: ProviderId,
    projectPath: string,
  ): Promise<{ capabilities: McpCapabilities; servers: McpServer[] }> {
    if (provider !== 'codex') {
      return { capabilities: UNSUPPORTED_MCP_CAPABILITIES, servers: [] }
    }

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
    if (provider !== 'codex')
      throw new Error(`provider "${provider}" cannot manage MCP servers yet`)
  }

  #mcpRuntimeOptions(provider: ProviderId, projectPath: string): StartOptions {
    if (provider !== 'codex') return {}
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

  async account(provider: ProviderId): Promise<Account> {
    if (provider !== 'codex') return { signedIn: false }
    return (await this.#controlAdapter()).account()
  }

  async usageLimits(
    provider: ProviderId,
  ): Promise<Array<{ label: string; usedPercent: number; resetsAt?: number | undefined }>> {
    if (provider !== 'codex') return []
    return (await this.#controlAdapter()).rateLimits()
  }

  async startLogin(provider: ProviderId): Promise<{ loginId: string; authUrl: string }> {
    if (provider !== 'codex') throw new Error(`provider "${provider}" cannot sign in yet`)
    return (await this.#controlAdapter()).startLogin()
  }

  async cancelLogin(provider: ProviderId, loginId: string): Promise<void> {
    if (provider !== 'codex') return
    await (await this.#controlAdapter()).cancelLogin(loginId)
  }

  async useApiKey(provider: ProviderId, apiKey: string): Promise<Account> {
    if (provider !== 'codex') throw new Error(`provider "${provider}" cannot sign in yet`)
    return (await this.#controlAdapter()).useApiKey(apiKey)
  }

  async signOut(provider: ProviderId): Promise<void> {
    if (provider !== 'codex') return
    await (await this.#controlAdapter()).signOut()
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
    const worktree = options.isolate
      ? await createWorktree(workspacePath, threadId, this.#worktreeRoot)
      : undefined

    const runtime = this.#runtimeFor(provider, this.#onLog)
    const runtimeOptions = { ...options, ...this.#mcpRuntimeOptions(provider, workspacePath) }
    let started
    try {
      started = await runtime.start(worktree?.path ?? workspacePath, runtimeOptions)
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
    return thread
  }

  async sendTurn(
    threadId: string,
    text: string,
    attachments: string[] = [],
    options: TurnOptions = {},
  ): Promise<string> {
    if (this.#panicStopping) throw new Error('turn cancelled by panic stop')
    if (this.#reviewingDiffs.has(threadId)) {
      throw new Error('cannot start a turn while a diff rejection is running')
    }
    this.#wakeForActivity(threadId)
    const panicGeneration = this.#panicGeneration
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
        this.#designFlows.set(threadId, {
          workspacePath: this.#repoPath(threadId),
          options,
          askedQuestions: false,
          finalAsked: false,
        })
      }
      const prompt = design ? designBriefingPrompt(text) : text
      const visibleAttachments = attachments.filter((path) => path !== DESIGN_BRIEF_ATTACHMENT)
      return await (design
        ? this.#sendDesignTurn(threadId, prompt, visibleAttachments, options)
        : this.#get(threadId).session.sendTurn(threadId, prompt, visibleAttachments, options))
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
  ): Promise<{ queued: false; turnId: string } | { queued: true; queuedTurn: QueuedTurn }> {
    await this.#ensureThread(threadId)
    const queue = this.#queuedTurns.get(threadId) ?? []
    if (
      this.#activeTurns.has(threadId) ||
      this.#startingTurns.has(threadId) ||
      this.#designInputByThread.has(threadId) ||
      queue.length > 0
    ) {
      const queuedTurn: QueuedTurnEntry = {
        id: crypto.randomUUID(),
        text,
        attachments,
        createdAt: Date.now(),
        options,
      }
      queue.push(queuedTurn)
      this.#queuedTurns.set(threadId, queue)
      this.#notifyQueue(threadId)
      if (!this.#activeTurns.has(threadId) && !this.#startingTurns.has(threadId)) {
        void this.#drainQueue(threadId)
      }
      return { queued: true, queuedTurn: this.#publicQueuedTurn(queuedTurn) }
    }

    const turnId = await this.sendTurn(threadId, text, attachments, options)
    this.#activeTurns.add(threadId)
    return { queued: false, turnId }
  }

  queue(threadId: string): QueueState {
    const session = this.#threads.get(threadId)?.session
    return {
      items: (this.#queuedTurns.get(threadId) ?? []).map((item) => this.#publicQueuedTurn(item)),
      canSteer: session?.capabilities.steer === true && session.steer !== undefined,
    }
  }

  deleteQueuedTurn(threadId: string, queuedTurnId: string): void {
    const queue = this.#queuedTurns.get(threadId) ?? []
    const index = queue.findIndex((item) => item.id === queuedTurnId)
    if (index < 0) return
    queue.splice(index, 1)
    this.#notifyQueue(threadId)
  }

  moveQueuedTurn(threadId: string, queuedTurnId: string, direction: 'up' | 'down'): void {
    const queue = this.#queuedTurns.get(threadId) ?? []
    const from = queue.findIndex((item) => item.id === queuedTurnId)
    const to = from + (direction === 'up' ? -1 : 1)
    if (from < 0 || to < 0 || to >= queue.length) return
    ;[queue[from], queue[to]] = [queue[to]!, queue[from]!]
    this.#notifyQueue(threadId)
  }

  async steerQueuedTurn(threadId: string, queuedTurnId: string): Promise<void> {
    const session = this.#get(threadId).session
    if (!this.#activeTurns.has(threadId)) throw new Error('there is no running turn to steer')
    if (!session.capabilities.steer || !session.steer) {
      throw new Error('this agent does not support steering a running turn')
    }

    const queue = this.#queuedTurns.get(threadId) ?? []
    const index = queue.findIndex((item) => item.id === queuedTurnId)
    if (index < 0) throw new Error('queued prompt not found')
    const [item] = queue.splice(index, 1)
    if (!item) return
    this.#notifyQueue(threadId)
    try {
      await session.steer(threadId, item.text, item.attachments)
    } catch (error) {
      queue.splice(index, 0, item)
      this.#notifyQueue(threadId)
      throw error
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
    if (event.type === 'turn.started') this.#activeTurns.add(threadId)
    if (event.type === 'turn.completed' || event.type === 'thread.error') {
      this.#activeTurns.delete(threadId)
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
    if (event.type === 'turn.completed' && !this.#designInputByThread.has(threadId)) {
      void this.#drainQueue(threadId)
    }
  }

  /** A thread's history, for a client opening or reattaching to it. */
  history(threadId: string, afterSeq = 0): Array<{ seq: number; event: DomainEvent }> {
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
    return this.#activeTurns.has(threadId) || this.#startingTurns.has(threadId)
  }

  inboxStatus(threadId: string): ThreadInboxStatus {
    if (this.#startingTurns.has(threadId)) return 'starting'
    if (this.#activeTurns.has(threadId)) return 'working'
    if ((this.#queuedTurns.get(threadId)?.length ?? 0) > 0) return 'queued'

    // ponytail: replay the durable log here; add a status projection only if large histories
    // make project-list latency measurable.
    const approvals = new Set<string>()
    const inputs = new Set<string>()
    let last: ThreadInboxStatus = 'idle'
    for (const { event } of this.#store.history(threadId)) {
      if (event.type === 'approval.requested') approvals.add(event.request.id)
      if (event.type === 'approval.resolved') approvals.delete(event.id)
      if (event.type === 'user_input.requested') inputs.add(event.request.id)
      if (event.type === 'user_input.resolved') inputs.delete(event.id)
      if (event.type === 'thread.error') last = 'failed'
      if (event.type === 'turn.completed') {
        last = event.status === 'failed' ? 'failed' : 'idle'
      }
    }
    if (approvals.size > 0) return 'approval'
    if (inputs.size > 0) return 'input'
    if (last === 'failed') return 'failed'
    return this.#store.thread(threadId)?.unread ? 'ready' : last
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

  writeTerminal(terminalId: string, data: string): void {
    this.#terminals.write(terminalId, data)
  }

  resizeTerminal(terminalId: string, columns: number, rows: number): void {
    this.#terminals.resize(terminalId, columns, rows)
  }

  closeTerminal(terminalId: string): void {
    this.#terminals.close(terminalId)
  }

  #repoPath(threadId: string): string {
    const stored = this.#store.thread(threadId)
    if (!stored) throw new Error(`no such thread: ${threadId}`)
    return stored.worktreePath ?? stored.projectPath
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
    this.#reviewingDiffs.add(threadId)
    try {
      return await review()
    } finally {
      this.#reviewingDiffs.delete(threadId)
    }
  }

  async #drainQueue(threadId: string): Promise<void> {
    if (
      this.#drainingQueues.has(threadId) ||
      this.#activeTurns.has(threadId) ||
      this.#startingTurns.has(threadId) ||
      this.#designInputByThread.has(threadId)
    ) {
      return
    }
    const queue = this.#queuedTurns.get(threadId)
    const next = queue?.shift()
    if (!queue || !next) return

    this.#drainingQueues.add(threadId)
    this.#notifyQueue(threadId)
    try {
      await this.sendTurn(threadId, next.text, next.attachments, next.options)
      this.#activeTurns.add(threadId)
    } catch (error) {
      queue.unshift(next)
      this.#notifyQueue(threadId)
      this.#onLog(
        `could not start queued turn: ${error instanceof Error ? error.message : String(error)}`,
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

  /** Where the working tree stood before a turn. Silent when there is no repo. */
  async #checkpoint(threadId: string, label: string): Promise<void> {
    const stored = this.#store.thread(threadId)
    if (!stored) return
    const repoPath = stored.worktreePath ?? stored.projectPath

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
    if (this.#activeTurns.has(threadId)) throw new Error('cannot restore during a running turn')
    const stored = this.#store.thread(threadId)
    const checkpoint = this.#store.checkpoint(checkpointId)
    if (!stored || !checkpoint || checkpoint.threadId !== threadId) {
      throw new Error('no such checkpoint')
    }

    const repoPath = stored.worktreePath ?? stored.projectPath
    const replaced = await restoreSnapshot(repoPath, checkpoint.commit)

    // Rolling the files back without this would leave the transcript
    // describing work that no longer exists on disk.
    try {
      return { undo: this.#store.saveRestoreUndo(threadId, checkpoint.seq, replaced.commit) }
    } catch (error) {
      await restoreSnapshot(repoPath, replaced.commit)
      throw error
    }
  }

  /** Reverse the latest restore, including both files and conversation. */
  async undoRestore(threadId: string, token: string): Promise<void> {
    if (this.#activeTurns.has(threadId)) throw new Error('cannot restore during a running turn')
    const stored = this.#store.thread(threadId)
    const undo = this.#store.restoreUndo(threadId, token)
    if (!stored || !undo) throw new Error('restore can no longer be undone')

    const repoPath = stored.worktreePath ?? stored.projectPath
    const replaced = await restoreSnapshot(repoPath, undo.commit)
    try {
      this.#store.applyRestoreUndo(threadId, token)
    } catch (error) {
      await restoreSnapshot(repoPath, replaced.commit)
      throw error
    }
  }

  /** What the agent has changed since a checkpoint, so a restore is informed. */
  async changedSinceCheckpoint(threadId: string, checkpointId: number): Promise<string[]> {
    const stored = this.#store.thread(threadId)
    const checkpoint = this.#store.checkpoint(checkpointId)
    if (!stored || !checkpoint || checkpoint.threadId !== threadId) return []
    return changedSince(stored.worktreePath ?? stored.projectPath, checkpoint.commit).catch(
      () => [],
    )
  }

  respondToApproval(threadId: string, approvalId: string, decision: ApprovalDecision): void {
    this.#get(threadId).session.respondToApproval(approvalId, decision)
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
      if (noMoreDetails && flow.pendingBrief) {
        this.#completeDesignBrief(threadId, designInput.turnId, flow.pendingBrief)
        void this.#drainQueue(threadId)
        return
      }

      void this.#sendDesignTurn(
        threadId,
        designBriefingContinuation(designInput.questions, answers),
        [],
        flow.options,
      ).catch((error: unknown) => this.#failDesignFlow(threadId, error))
      return
    }

    const session = this.#get(threadId).session
    if (!session.respondToUserInput) throw new Error('this agent does not support structured input')
    session.respondToUserInput(requestId, answers)
  }

  async interrupt(threadId: string): Promise<void> {
    await this.#get(threadId).session.interrupt(threadId)
  }

  async panicStop(): Promise<PanicStopResult> {
    const sessions = [...this.#threads.entries()]
    this.#panicStopping = true
    this.#panicGeneration += 1
    for (const [threadId] of sessions) {
      if (this.#queuedTurns.delete(threadId)) this.#notifyQueue(threadId)
    }

    try {
      return {
        sessions: await Promise.all(
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
        ),
      }
    } finally {
      this.#panicStopping = false
    }
  }

  close(threadId: string): void {
    this.#terminals.closeThread(threadId)
    const entry = this.#threads.get(threadId)
    if (!entry) return
    entry.session.dispose()
    this.#threads.delete(threadId)
    this.#activeTurns.delete(threadId)
    this.#startingTurns.delete(threadId)
    this.#reviewingDiffs.delete(threadId)
    this.#queuedTurns.delete(threadId)
    this.#drainingQueues.delete(threadId)
    this.#clearDesignFlow(threadId)
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

    this.#terminals.closeThread(threadId)

    await removeWorktree(
      { path: stored.worktreePath, branch: stored.worktreeBranch, repoPath: stored.projectPath },
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
    const repos = new Set(this.#store.worktrees().map((entry) => entry.repoPath))
    for (const repo of repos) {
      await pruneWorktrees(repo).catch(() => undefined)
    }

    for (const entry of this.#store.worktrees()) {
      if (!existsSync(entry.path)) this.#store.forgetWorktree(entry.threadId)
    }
  }

  disposeAll(): void {
    for (const controller of this.#voiceRequests.values()) controller.abort()
    this.#voiceRequests.clear()
    this.#terminals.closeAll()
    for (const [, entry] of this.#threads) entry.session.dispose()
    this.#threads.clear()
    this.#activeTurns.clear()
    this.#startingTurns.clear()
    this.#reviewingDiffs.clear()
    this.#queuedTurns.clear()
    this.#drainingQueues.clear()
    this.#designFlows.clear()
    this.#designTurns.clear()
    this.#designStartingThreads.clear()
    this.#designMessageItems.clear()
    this.#designInputs.clear()
    this.#designInputByThread.clear()
    this.#resumingThreads.clear()
    this.#control?.dispose()
    this.#control = undefined
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
    const workspacePath = stored.worktreePath ?? stored.projectPath
    const result = await runtime.resume(threadId, workspacePath, {
      ...(stored.agent ? { agent: stored.agent } : {}),
      ...this.#mcpRuntimeOptions(stored.provider, stored.projectPath),
    })
    if (result.thread.id !== threadId) {
      result.session.dispose()
      throw new Error(`provider resumed unexpected thread ${result.thread.id}`)
    }
    this.#attachThread(result.thread, result.session, stored.projectPath)
  }

  async #sendDesignTurn(
    threadId: string,
    prompt: string,
    attachments: string[],
    options: TurnOptions,
  ): Promise<string> {
    this.#designStartingThreads.add(threadId)
    try {
      const turnId = await this.#get(threadId).session.sendTurn(
        threadId,
        prompt,
        attachments,
        options,
      )
      this.#designTurns.set(turnId, threadId)
      return turnId
    } finally {
      this.#designStartingThreads.delete(threadId)
    }
  }

  #handleSessionEvent(threadId: string, event: DomainEvent): void {
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
      this.#handleDesignOutput(threadId, turnId, event.item.text ?? '')
      return
    }
    if (event.type === 'turn.completed') this.#designTurns.delete(turnId)
    this.#record(threadId, event)
  }

  #handleDesignOutput(threadId: string, turnId: string, text: string): void {
    const flow = this.#designFlows.get(threadId)
    if (!flow) return

    try {
      const output = parseBriefingOutput(text)
      if (output.status === 'questions') {
        flow.askedQuestions = true
        flow.finalAsked = false
        flow.pendingBrief = undefined
        this.#requestDesignInput(threadId, turnId, output.questions, false)
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
        this.#requestDesignInput(threadId, turnId, [FINAL_BRIEFING_QUESTION], true)
        return
      }
      this.#completeDesignBrief(threadId, turnId, output.brief)
    } catch (error) {
      this.#failDesignFlow(threadId, error)
    }
  }

  #requestDesignInput(
    threadId: string,
    turnId: string,
    questions: BriefingQuestion[],
    final: boolean,
  ): void {
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
    writeDesignBrief(flow.workspacePath, brief)
    this.#clearDesignFlow(threadId)
    this.#record(threadId, {
      type: 'item.completed',
      item: {
        id: `design-complete-${crypto.randomUUID()}`,
        turnId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        text: 'Brief complete.\nDEBUG FINISHED · NO WEBSITE BUILT',
        createdAt: Date.now(),
      },
    })
  }

  #failDesignFlow(threadId: string, error: unknown): void {
    this.#clearDesignFlow(threadId)
    this.#record(threadId, {
      type: 'thread.error',
      threadId,
      message: `Design briefing failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  #clearDesignFlow(threadId: string): void {
    this.#designFlows.delete(threadId)
    const requestId = this.#designInputByThread.get(threadId)
    if (requestId) this.#designInputs.delete(requestId)
    this.#designInputByThread.delete(threadId)
    for (const [turnId, owner] of this.#designTurns) {
      if (owner === threadId) this.#designTurns.delete(turnId)
    }
  }

  #attachThread(
    thread: Thread,
    session: AgentSession,
    projectPath: string,
    worktree?: Worktree,
  ): void {
    this.#threads.set(thread.id, { thread, session, ...(worktree ? { worktree } : {}) })
    session.onMcpOAuth?.((result) => this.#onMcpOAuth(thread.provider, projectPath, result))
    session.on('event', (event) => this.#handleSessionEvent(thread.id, event))
  }
}
