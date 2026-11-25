import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest'
import { z } from 'zod'
import { CLAUDE_MCP_CAPABILITIES } from '@harness/adapter-claude-code/capabilities'
import { GROK_MCP_CAPABILITIES } from '@harness/adapter-grok/mcp'
import { OPENCODE_MCP_CAPABILITIES } from '@harness/adapter-opencode/inventory'
import { DomainEventSchema, ProviderIdSchema } from '@harness/contracts'
import type {
  Account,
  ApprovalMode,
  Capabilities,
  DomainEvent,
  McpServer,
  McpServerConfig,
  Model,
  ProviderCommand,
  ProviderId,
  ThreadLifecycle,
} from '@harness/contracts'
import {
  providerRuntime,
  type AgentSession,
  type ProviderRuntime,
  type StartOptions,
  type TurnOptions,
} from './adapters.js'
import { DESIGN_BRIEF_ATTACHMENT } from '@harness/design-agent'
import { encodeHistoryCursor, readHistoryPage } from './history-page.js'
import { compactHistoryReplay } from './history-replay.js'
import { CREATIFY_ATTACHMENT, CREATIFY_NOTE_CLOSE, CREATIFY_NOTE_OPEN } from './creatify.js'
import { writeDefaultSkillsFixture } from './default-skills.test-support.js'
import { McpConfigStore } from './mcp-config.js'
import { Orchestrator } from './orchestrator.js'
import { PROVIDER_CAPABILITIES } from './provider-capabilities.js'
import type {
  CodexControlAdapter,
  ProviderControlsOptions,
  ProviderServices,
} from './provider-controls.js'
import { StartupCleanupError } from './provider-session.js'
import { REPLY_STYLE_INSTRUCTIONS } from './reply-style.js'
import { DatabaseSync } from './sqlite.js'
import { Store } from './store.js'
import { subagentRunItem } from './subagent-runs.js'
import type { StoredSubagentRun } from './subagent-runs.js'
import * as checkpoint from './checkpoint.js'
import { beginOptimisticTurn, emptyThread, reduceEventLog } from '../../web/src/thread-store.js'
import { projectThreadItems } from '../../web/src/ui/turns.js'

/**
 * What must stay true when several sessions run at once.
 *
 * Verified against two real Claude Code sessions before these were written —
 * both turns dispatched in 27ms and neither saw the other's output. These
 * exist so that stays true: the tempting future change is a shared lock or a
 * single reused adapter, and either would pass every other test in the repo.
 */

const CAPABILITIES: Capabilities = {
  steer: true,
  fork: false,
  interrupt: true,
  reasoningItems: false,
  approvals: false,
  images: true,
}

/** A session that answers when told to, so turns can be interleaved by hand. */
class FakeSession implements AgentSession {
  /** Set before attach to model an agent that negotiated no session reload. */
  static nextResumable: boolean | undefined
  readonly resumable = FakeSession.nextResumable
  emit: (event: DomainEvent) => void = () => {}
  disposed = false
  disposeBarrier: Promise<void> | undefined
  interrupted = false
  interruptBarrier: Promise<void> | undefined
  interruptError: Error | undefined
  sent: string[] = []
  sentAttachments: string[][] = []
  sentOptions: Array<TurnOptions | undefined> = []
  steered: string[] = []
  steeredAttachments: string[][] = []
  userInputs: Array<{ requestId: string; answers: Record<string, string[]> }> = []
  approvalModes: ApprovalMode[] = []
  mcpServers: McpServer[] = []
  mcpReloads: Array<{
    threadId: string
    servers: McpServerConfig[]
    credentials: Record<string, string>
  }> = []
  mcpReloadBarrier: Promise<void> | undefined
  mcpReloadError: Error | undefined
  mcpOAuthStarts: Array<{ serverId: string; threadId: string }> = []
  emitMcpOAuth: (result: {
    serverId: string
    loginId: string
    success: boolean
    error: string | null
  }) => void = () => {}
  turnIds: string[] = []
  sendError: Error | undefined
  eventDuringSend: DomainEvent | undefined
  lateSendError: Error | undefined
  emitUsageChanged: () => void = () => {}
  emitMcpChanged: () => void = () => {}
  commands: ProviderCommand[] = []
  commandReads: Array<string | undefined> = []
  emitCommandsChanged: () => void = () => {}
  backgroundWork = false
  emitBackgroundWorkChanged: () => void = () => {}
  emitDisconnected: () => void = () => {}
  emitProviderSessionId: (providerSessionId: string) => void = () => {}
  afterEventBarrier: Promise<void> | undefined
  steerBarriers: Promise<void>[] = []
  /** Resolves the pending sendTurn, letting a test hold one open. */
  release: (() => void) | undefined

  #listeners: Array<(event: DomainEvent) => void> = []

  constructor(
    readonly id: string,
    readonly capabilities = CAPABILITIES,
  ) {}

  async sendTurn(
    _threadId: string,
    text: string,
    attachments: string[] = [],
    options?: TurnOptions,
  ): Promise<string> {
    this.sent.push(text)
    this.sentAttachments.push(attachments)
    this.sentOptions.push(options)
    if (this.release) await new Promise<void>((resolve) => (this.release = resolve))
    if (this.sendError) throw this.sendError
    if (this.eventDuringSend) this.emit(this.eventDuringSend)
    if (this.afterEventBarrier) await this.afterEventBarrier
    if (this.lateSendError) throw this.lateSendError
    return this.turnIds.shift() ?? `${this.id}-turn`
  }

  async steer(_threadId: string, text: string, attachments: string[] = []): Promise<void> {
    this.steered.push(text)
    this.steeredAttachments.push(attachments)
    const barrier = this.steerBarriers.shift()
    if (barrier) await barrier
  }

  async interrupt(_threadId: string): Promise<void> {
    this.interrupted = true
    await this.interruptBarrier
    if (this.interruptError) throw this.interruptError
  }
  async listMcpServers(): Promise<McpServer[]> {
    return this.mcpServers
  }
  mcpLoading = false
  isMcpLoading(): boolean {
    return this.mcpLoading
  }
  async reloadMcpServers(
    threadId: string,
    servers: McpServerConfig[],
    credentials: Record<string, string>,
  ): Promise<void> {
    this.mcpReloads.push({ threadId, servers, credentials })
    await this.mcpReloadBarrier
    if (this.mcpReloadError) throw this.mcpReloadError
  }
  async startMcpOAuth(
    serverId: string,
    threadId: string,
  ): Promise<{ loginId: string; authUrl: string }> {
    this.mcpOAuthStarts.push({ serverId, threadId })
    return { loginId: `login-${serverId}`, authUrl: `https://example.com/${serverId}` }
  }
  respondToApproval(): void {}
  respondToUserInput(requestId: string, answers: Record<string, string[]>): void {
    this.userInputs.push({ requestId, answers })
  }
  setApproval(approval: ApprovalMode): void {
    this.approvalModes.push(approval)
  }
  dispose(): void | Promise<void> {
    this.disposed = true
    return this.disposeBarrier
  }

  on(_event: 'event' | 'log', listener: (value: never) => void): void {
    this.#listeners.push(listener as (event: DomainEvent) => void)
    this.emit = (event) => {
      for (const l of this.#listeners) l(event)
    }
  }

  onUsageChanged(listener: () => void): void {
    this.emitUsageChanged = listener
  }

  onMcpChanged(listener: () => void): void {
    this.emitMcpChanged = listener
  }

  async listCommands(threadId?: string): Promise<ProviderCommand[]> {
    this.commandReads.push(threadId)
    return this.commands
  }

  onCommandsChanged(listener: () => void): void {
    this.emitCommandsChanged = listener
  }

  hasBackgroundWork(): boolean {
    return this.backgroundWork
  }

  onBackgroundWorkChanged(listener: () => void): void {
    this.emitBackgroundWorkChanged = listener
  }

  /** Work a turn started keeps running in the background, or stops. */
  runInBackground(running: boolean): void {
    this.backgroundWork = running
    this.emitBackgroundWorkChanged()
  }

  onDisconnected(listener: () => void): () => void {
    this.emitDisconnected = listener
    return () => {
      if (this.emitDisconnected === listener) this.emitDisconnected = () => {}
    }
  }

  onProviderSessionId(listener: (providerSessionId: string) => void): void {
    this.emitProviderSessionId = listener
  }

  onMcpOAuth(listener: Parameters<NonNullable<AgentSession['onMcpOAuth']>>[0]): void {
    this.emitMcpOAuth = listener
  }
}

/** A test that needs a provider to sign in or change its settings passes its own service. */
function unavailableInTests(what: string) {
  return async (): Promise<never> => {
    throw new Error(`${what} is not available in orchestrator tests.`)
  }
}
const signedOut = async (): Promise<Account> => ({ signedIn: false })
const noLimits = async () => ({ status: 'unavailable' as const })
const noCommands = async () => ({ commands: [], loading: false })

/**
 * Each provider service that would start an installed CLI or read its sign-in or
 * folders answers with nothing here, so no test depends on the providers installed
 * on the machine that runs it. Services that read nothing (Codex's static commands,
 * MCP validation, the sign-out notices) stay. A test's own services win.
 */
const quietServices = {
  antigravity: { listCommands: noCommands, account: signedOut, usageLimitSource: noLimits },
  api: {},
  // Everything else Codex answers comes from its control process: see QuietCodexControl.
  codex: {},
  opencode: {
    projectInventory: {
      mcpCapabilities: OPENCODE_MCP_CAPABILITIES,
      skillCapabilities: { inventory: true, configure: false, install: false },
      discover: async () => ({ commands: [], servers: [], skills: [] }),
    },
    account: signedOut,
  },
  pi: {},
  'claude-code': {
    projectInventory: {
      mcpCapabilities: CLAUDE_MCP_CAPABILITIES,
      discover: async () => ({ commands: [], servers: [] }),
    },
    account: signedOut,
    usageLimitSource: noLimits,
    startLogin: unavailableInTests('Claude Code sign-in'),
    signOut: unavailableInTests('Claude Code sign-out'),
  },
  cursor: {
    listCommands: noCommands,
    account: signedOut,
    usageLimitSource: noLimits,
    startLogin: unavailableInTests('Cursor sign-in'),
    signOut: unavailableInTests('Cursor sign-out'),
  },
  grok: {
    projectInventory: {
      mcpCapabilities: GROK_MCP_CAPABILITIES,
      skillCapabilities: { inventory: true, configure: false, install: false },
      discover: async () => ({ commands: [], servers: [], skills: [] }),
    },
    account: signedOut,
    usageLimitSource: noLimits,
    signOut: unavailableInTests('Grok sign-out'),
  },
  acp: { account: signedOut, signOut: unavailableInTests('ACP sign-out') },
} satisfies Record<ProviderId, ProviderServices>

/** Codex's control process would start the installed CLI; this one has nothing to report. */
class QuietCodexControl extends EventEmitter implements CodexControlAdapter {
  readonly #models: readonly Model[]
  constructor(models: readonly Model[] = []) {
    super()
    this.#models = models
  }
  async start(): Promise<void> {}
  async dispose(): Promise<void> {}
  onUsageChanged(): void {}
  account = signedOut
  async listModels(): Promise<Model[]> {
    return [...this.#models]
  }
  async listMcpServers(): Promise<McpServer[]> {
    return []
  }
  isMcpLoading(): boolean {
    return false
  }
  async whenMcpServersListed(): Promise<boolean> {
    return true
  }
  async listSkills() {
    return { skills: [], errors: [] }
  }
  rateLimitSource = noLimits
  setSkillEnabled = unavailableInTests('Codex skill settings')
  consumeRateLimitReset = unavailableInTests('Codex limit resets')
  startLogin = unavailableInTests('Codex sign-in')
  cancelLogin = unavailableInTests('Codex sign-in')
  useApiKey = unavailableInTests('Codex sign-in')
  signOut = unavailableInTests('Codex sign-out')
}

// Every orchestrator under test gets its own MCP config folder. Remove them when the file is done:
// one run builds a few hundred, and each was left behind in the temp directory.
const mcpConfigDirectories: string[] = []
function temporaryMcpConfig(): McpConfigStore {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-mcp-'))
  mcpConfigDirectories.push(directory)
  return new McpConfigStore(path.join(directory, 'mcp.json'))
}
afterAll(() => {
  for (const directory of mcpConfigDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
})

type QueueNotificationError = { current?: Error }
type CredentialFailure = { current?: Error }
type LifecycleHook = {
  current?: (threadId: string, lifecycle: ThreadLifecycle) => void
}

function harness(
  worktreeRoot?: string,
  store = new Store(':memory:'),
  maxIdleThreadRuntimes?: number,
  idleThreadRuntimeMs?: number,
  providerServices?: ProviderControlsOptions['services'],
  defaultSkillsRoot?: string,
  stopSettleMs?: number,
) {
  const sessions: FakeSession[] = []
  const sessionCapabilities: Capabilities[] = []
  const received: Array<{
    threadId: string
    event: DomainEvent
    seq: number
    serializedEvent?: string
  }> = []
  const sideReceived: Array<{ threadId: string; event: DomainEvent }> = []
  const lifecycles: Array<{ threadId: string; lifecycle: ThreadLifecycle }> = []
  const lifecycleScheduleChanges: Array<'later' | number | undefined> = []
  const logs: string[] = []
  const queueChanges: Array<{ threadId: string; itemIds: string[] }> = []
  const queueStates: Array<{ threadId: string; itemIds: string[]; canSteer: boolean }> = []
  const usageChanges: ProviderId[] = []
  const mcpChanges: Array<{ provider: ProviderId; projectPath: string }> = []
  const commandChanges: Array<{ provider: ProviderId; projectPath: string }> = []
  const queueNotificationError: QueueNotificationError = {}
  const lifecycleHook: LifecycleHook = {}

  /** Where each session was actually told to run. */
  const startedIn: string[] = []
  const startedOptions: StartOptions[] = []
  const startBarriers: Promise<void>[] = []
  const credentialFailure: CredentialFailure = {}
  const resumedIds: string[] = []
  const resumedIn: string[] = []
  const resumedOptions: StartOptions[] = []
  const resumeBarriers: Promise<void>[] = []
  /** What every provider's model list reports. */
  const models: Model[] = []
  const runtimeFor = (provider: ProviderId): ProviderRuntime => ({
    async start(workspacePath, options) {
      startedIn.push(workspacePath)
      startedOptions.push(options)
      const barrier = startBarriers.shift()
      if (barrier) await barrier
      const session = new FakeSession(`s${sessions.length + 1}`, sessionCapabilities.shift())
      sessions.push(session)
      return {
        thread: {
          id: `thread-${sessions.length}`,
          provider,
          ...(provider === 'api'
            ? { connectionId: options.connectionId ?? 'test-connection' }
            : {}),
          workspacePath,
          createdAt: Date.now(),
        },
        session,
      }
    },
    async listModels() {
      return models
    },
    ...(provider === 'codex' || provider === 'grok'
      ? {
          async resume(threadId: string, workspacePath: string, options: StartOptions) {
            resumedIds.push(threadId)
            resumedIn.push(workspacePath)
            resumedOptions.push(options)
            const barrier = resumeBarriers.shift()
            if (barrier) await barrier
            const session = new FakeSession(`s${sessions.length + 1}`, sessionCapabilities.shift())
            sessions.push(session)
            return {
              thread: {
                id: threadId,
                provider,
                workspacePath,
                createdAt: Date.now(),
              },
              session,
            }
          },
        }
      : {}),
  })

  const orchestrator = new Orchestrator(store, {
    onEvent: (threadId, event, seq, serializedEvent) =>
      received.push({
        threadId,
        event,
        seq,
        ...(serializedEvent === undefined ? {} : { serializedEvent }),
      }),
    onQueue: (threadId, state) => {
      const itemIds = state.items.map(({ id }) => id)
      queueChanges.push({ threadId, itemIds })
      queueStates.push({ threadId, itemIds, canSteer: state.canSteer })
      if (queueNotificationError.current) throw queueNotificationError.current
    },
    onSideEvent: (threadId, event) => sideReceived.push({ threadId, event }),
    onLifecycle: (threadId, lifecycle) => {
      lifecycles.push({ threadId, lifecycle })
      lifecycleHook.current?.(threadId, lifecycle)
    },
    onLifecycleScheduleChanged: (hint) => lifecycleScheduleChanges.push(hint),
    onLog: (line) => logs.push(line),
    onLogin: () => {},
    onUsageChanged: (provider) => usageChanges.push(provider),
    onMcpChanged: (provider, projectPath) => mcpChanges.push({ provider, projectPath }),
    onCommandsChanged: (provider, projectPath) => commandChanges.push({ provider, projectPath }),
    mcpConfig: temporaryMcpConfig(),
    readCredential: (reference) => {
      if (credentialFailure.current) throw credentialFailure.current
      return `secret:${reference}`
    },
    runtimeFor,
    ...(maxIdleThreadRuntimes === undefined ? {} : { maxIdleThreadRuntimes }),
    ...(idleThreadRuntimeMs === undefined ? {} : { idleThreadRuntimeMs }),
    ...(stopSettleMs === undefined ? {} : { stopSettleMs }),
    providerServices: Object.fromEntries(
      ProviderIdSchema.options.map((provider) => {
        // tsc skips the server's tests, so a provider added without an entry is caught here.
        const quiet = Object.hasOwn(quietServices, provider) ? quietServices[provider] : undefined
        if (!quiet) throw new Error(`The test harness has no quiet services for ${provider}.`)
        return [provider, { ...quiet, ...providerServices?.[provider] }]
      }),
    ),
    createCodex: () => new QuietCodexControl(models),
    ...(worktreeRoot ? { worktreeRoot } : {}),
    ...(defaultSkillsRoot ? { defaultSkillsRoot } : {}),
  })

  return {
    store,
    models,
    sessions,
    sessionCapabilities,
    received,
    sideReceived,
    lifecycles,
    lifecycleScheduleChanges,
    logs,
    queueChanges,
    queueStates,
    usageChanges,
    mcpChanges,
    commandChanges,
    queueNotificationError,
    lifecycleHook,
    orchestrator,
    startedIn,
    startedOptions,
    startBarriers,
    credentialFailure,
    resumedIds,
    resumedIn,
    resumedOptions,
    resumeBarriers,
  }
}

describe('queue steering capability lifecycle', () => {
  it.each(['new', 'persisted'] as const)(
    'pushes steering availability for the first turn of a %s chat without queueing',
    async (kind) => {
      const { orchestrator, store, sessions, queueStates } = harness()
      try {
        let threadId: string
        if (kind === 'persisted') {
          store.addProject('/repo')
          store.addThread({
            id: 'persisted',
            projectPath: '/repo',
            provider: 'codex',
            title: 'Old',
          })
          threadId = 'persisted'
          expect(orchestrator.queue(threadId).canSteer).toBe(false)
        } else {
          threadId = (await orchestrator.startThread('codex', '/repo')).id
        }
        await orchestrator.submitTurn(threadId, 'First')

        expect(orchestrator.queue(threadId)).toEqual({ items: [], canSteer: true })
        expect(queueStates).toEqual([{ threadId, itemIds: [], canSteer: true }])
        sessions[0]!.emit(turnStarted(threadId, 's1-turn'))
        sessions[0]!.emit(message('Streaming', 's1-turn'))
        expect(queueStates).toHaveLength(1)
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    },
  )

  it.each(['close', 'disconnect', 'idle', 'dispose'] as const)(
    'pushes loss of steering availability on runtime %s',
    async (reason) => {
      const { orchestrator, store, sessions, queueStates } = harness(undefined, undefined, 1)
      try {
        const { id } = await orchestrator.startThread('codex', '/repo')
        if (reason === 'idle') await orchestrator.startThread('codex', '/repo')
        queueStates.length = 0
        if (reason === 'close') await orchestrator.close(id)
        else if (reason === 'disconnect') sessions[0]!.emitDisconnected()
        else if (reason === 'dispose') await orchestrator.disposeAll()
        else {
          sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
          sessions[1]!.emit({ type: 'turn.completed', turnId: 's2-turn', status: 'completed' })
        }

        expect(orchestrator.queue(id).canSteer).toBe(false)
        expect(queueStates).toEqual([{ threadId: id, itemIds: [], canSteer: false }])
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    },
  )

  it('publishes the replacement session capability when a chat moves providers', async () => {
    const { orchestrator, store, sessionCapabilities, queueStates } = harness()
    try {
      const { id } = await orchestrator.startThread('codex', '/repo')
      queueStates.length = 0
      sessionCapabilities.push({ ...CAPABILITIES, steer: false })
      await orchestrator.changeProvider(id, { provider: 'grok' })
      expect(orchestrator.queue(id).canSteer).toBe(false)
      expect(queueStates).toEqual([{ threadId: id, itemIds: [], canSteer: false }])

      await orchestrator.changeProvider(id, { provider: 'codex', model: 'next-model' })
      expect(orchestrator.queue(id).canSteer).toBe(true)
      expect(queueStates.at(-1)).toEqual({ threadId: id, itemIds: [], canSteer: true })
    } finally {
      await orchestrator.disposeAll()
      store.close()
    }
  })

  it.each(['attach', 'close', 'disconnect', 'idle', 'dispose'] as const)(
    'finishes runtime %s when the steering listener throws',
    async (reason) => {
      const { orchestrator, store, sessions, queueNotificationError } = harness(
        undefined,
        undefined,
        1,
      )
      try {
        if (reason === 'attach') queueNotificationError.current = new Error('listener failed')
        const { id } = await orchestrator.startThread('codex', '/repo')
        if (reason === 'idle') await orchestrator.startThread('codex', '/repo')
        queueNotificationError.current = new Error('listener failed')

        if (reason === 'close') await orchestrator.close(id)
        else if (reason === 'disconnect') sessions[0]!.emitDisconnected()
        else if (reason === 'idle') {
          sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
          sessions[1]!.emit({ type: 'turn.completed', turnId: 's2-turn', status: 'completed' })
        } else await orchestrator.disposeAll()

        await vi.waitFor(() => expect(sessions[0]!.disposed).toBe(true))
        expect(orchestrator.queue(id).canSteer).toBe(false)
        // Cleanup must also let a later shutdown finish, including any remaining runtime.
        await orchestrator.disposeAll()
        expect(sessions.every((session) => session.disposed)).toBe(true)
      } finally {
        queueNotificationError.current = undefined
        await orchestrator.disposeAll()
        store.close()
      }
    },
  )

  it.each(['grok', 'api'] as const)(
    'keeps unsupported %s sessions unavailable and refuses to steer their queued prompts',
    async (provider) => {
      const { orchestrator, store, sessions, sessionCapabilities, queueStates } = harness()
      try {
        sessionCapabilities.push({ ...CAPABILITIES, steer: false })
        const { id } = await orchestrator.startThread(provider, '/repo')
        await orchestrator.submitTurn(id, 'First')
        const queued = await orchestrator.submitTurn(id, 'Next')
        if (!queued.queued) throw new Error('expected queued prompt')
        expect(queueStates).toEqual([
          { threadId: id, itemIds: [queued.queuedTurn.id], canSteer: false },
        ])
        await expect(orchestrator.steerQueuedTurn(id, queued.queuedTurn.id)).rejects.toThrow(
          'this agent does not support steering a running turn',
        )
        expect(sessions[0]!.steered).toEqual([])
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    },
  )
})

describe('failed provider starts', () => {
  const cleanupFailure = (message: string, dispose: () => Promise<void>) => {
    const failure = Promise.reject(
      new StartupCleanupError(new Error(message), new Error('process group survived'), {
        dispose,
      }),
    )
    failure.catch(() => {})
    return failure
  }
  const failingOnce = () =>
    vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('process group survived'))
      .mockResolvedValue(undefined)

  it('keeps a session whose cleanup failed until a later stop confirms it', async () => {
    const { orchestrator, startBarriers, logs } = harness()
    const dispose = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('process group survived'))
      .mockResolvedValue(undefined)
    const barrier = Promise.reject(
      new StartupCleanupError(
        new Error('session/new failed'),
        new Error('process group survived'),
        {
          dispose,
        },
      ),
    )
    barrier.catch(() => {})
    startBarriers.push(barrier)

    await expect(orchestrator.startThread('codex', process.cwd())).rejects.toThrow(
      'session/new failed',
    )
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
    expect(logs.some((line) => line.includes('process group survived'))).toBe(true)
    await orchestrator.disposeAll()
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('keeps a resumed session whose cleanup failed until a later stop confirms it', async () => {
    const { orchestrator, store, resumeBarriers } = harness()
    store.addProject('/repo')
    store.addThread({ id: 'saved', projectPath: '/repo', provider: 'codex', title: 'Saved' })
    const dispose = failingOnce()
    resumeBarriers.push(cleanupFailure('thread/resume failed', dispose))

    await expect(orchestrator.submitTurn('saved', 'continue')).rejects.toThrow(
      'thread/resume failed',
    )
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
    await orchestrator.disposeAll()
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  // #2190: Codex answered the resume with "no rollout found for thread id …".
  const missingSession = () => {
    const missing = Promise.reject(
      Object.assign(new Error('no rollout found for thread id saved'), {
        code: 'provider_session_missing',
      }),
    )
    missing.catch(() => {})
    return missing
  }

  it('replaces a missing session silently when the chat never completed a turn', async () => {
    const { orchestrator, store, sessions, resumeBarriers, received, logs } = harness()
    store.addProject('/repo')
    store.addThread({ id: 'saved', projectPath: '/repo', provider: 'codex', title: 'Saved' })
    resumeBarriers.push(missingSession())
    try {
      await orchestrator.submitTurn('saved', 'Build the page')
      expect(sessions).toHaveLength(1)
      expect(sessions[0]!.sent).toEqual(['Build the page'])
      expect(store.thread('saved')?.providerSessionId).toBe('thread-1')
      expect(store.threadNeedsHandover('saved')).toBe(false)
      expect(
        received.some(({ event }) => event.type === 'item.completed' && event.item.notice),
      ).toBe(false)
      expect(logs.some((line) => line.includes('continuing in a new codex session'))).toBe(true)
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('carries a chat with turns to a new session and says so when its saved one is missing', async () => {
    const store = new Store(':memory:')
    const first = harness(undefined, store)
    const thread = await first.orchestrator.startThread('codex', process.cwd())
    await first.orchestrator.submitTurn(thread.id, 'First question', [], {}, 'first-question')
    first.sessions[0]!.emit(message('First answer.', 's1-turn'))
    first.sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    await vi.waitFor(() => expect(first.orchestrator.isTurnRunning(thread.id)).toBe(false))
    await first.orchestrator.disposeAll()

    const restarted = harness(undefined, store)
    restarted.resumeBarriers.push(missingSession())
    try {
      await restarted.orchestrator.submitTurn(thread.id, 'Second question')
      const sent = restarted.sessions[0]!.sent[0] ?? ''
      // The new session gets the conversation so far, then the new prompt.
      expect(sent).toContain('First question')
      expect(sent).toContain('Second question')
      expect(sent).not.toBe('Second question')
      const notice = restarted.received.find(
        ({ event }) => event.type === 'item.completed' && event.item.type === 'notice',
      )?.event
      expect(notice).toMatchObject({
        item: { notice: { kind: 'provider', provider: 'codex', reason: 'session_missing' } },
      })
      expect(restarted.logs.some((line) => line.includes('with the conversation so far'))).toBe(
        true,
      )
    } finally {
      await restarted.orchestrator.disposeAll()
    }
  })

  it('starts a Side chat for a resting main chat without resuming the main chat', async () => {
    const { orchestrator, sessions, store } = harness()
    store.addProject('/repo')
    store.addThread({
      id: 'persisted-thread',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Persisted',
    })
    store.append('persisted-thread', userMessage('u1', 'Main question', 't1'))
    try {
      const side = await orchestrator.startSideThread('persisted-thread')
      // One agent process: the Side chat's own. It reads the main chat's saved history.
      expect(sessions).toHaveLength(1)
      expect(store.thread(side.id)).toMatchObject({
        ephemeral: true,
        parentThreadId: 'persisted-thread',
        provider: 'codex',
      })
    } finally {
      await orchestrator.disposeAll()
      store.close()
    }
  })

  it('keeps a Side chat session whose cleanup failed until a later stop confirms it', async () => {
    const { orchestrator, sessions, startBarriers } = harness()
    const parent = await orchestrator.startThread('codex', process.cwd())
    await orchestrator.submitTurn(parent.id, 'Main question', [], {}, 'main-question')
    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    const dispose = failingOnce()
    startBarriers.push(cleanupFailure('session/new failed', dispose))

    await expect(orchestrator.startSideThread(parent.id)).rejects.toThrow('session/new failed')
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
    await orchestrator.disposeAll()
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('stops a started agent when its thread cannot be saved', async () => {
    const { orchestrator, sessions, store } = harness()
    vi.spyOn(store, 'addThread').mockImplementationOnce(() => {
      throw new Error('SQLITE_FULL')
    })
    try {
      await expect(orchestrator.startThread('codex', process.cwd())).rejects.toThrow('SQLITE_FULL')
      expect(sessions[0]?.disposed).toBe(true)
      expect(orchestrator.isTurnRunning(sessions[0]!.id)).toBe(false)
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('keeps a started agent attached when a later settings read fails', async () => {
    const { orchestrator, sessions, store } = harness()
    vi.spyOn(store, 'sidebarSettings').mockImplementationOnce(() => {
      throw new Error('disk I/O error')
    })
    await expect(orchestrator.startThread('codex', process.cwd())).rejects.toThrow('disk I/O error')
    expect(sessions[0]?.disposed).toBe(false)
    await orchestrator.disposeAll()
    expect(sessions[0]?.disposed).toBe(true)
  })
})

describe('provider usage changes', () => {
  it('forwards a live session signal with its provider identity', async () => {
    const { orchestrator, sessions, usageChanges } = harness()
    await orchestrator.startThread('codex', process.cwd())

    sessions[0]?.emitUsageChanged()

    expect(usageChanges).toEqual(['codex'])
  })

  it('ignores a signal from a closed session', async () => {
    const { orchestrator, sessions, usageChanges } = harness()
    const thread = await orchestrator.startThread('codex', process.cwd())
    const session = sessions[0]

    orchestrator.close(thread.id)
    session?.emitUsageChanged()

    expect(usageChanges).toEqual([])
  })
})

describe('provider disconnection recovery', () => {
  it('reports a visible failure and retains queued work when the provider cannot resume', async () => {
    const { orchestrator, sessions, received } = harness()
    const thread = await orchestrator.startThread('claude-code', '/repo')
    await orchestrator.submitTurn(thread.id, 'first')
    await orchestrator.submitTurn(thread.id, 'queued')
    sessions[0]!.emit({ type: 'thread.error', threadId: thread.id, message: 'Provider crashed' })
    sessions[0]!.emitDisconnected()
    await vi.waitFor(() =>
      expect(
        received.some(
          ({ event }) =>
            event.type === 'thread.error' &&
            event.message.startsWith('Could not resume queued prompts:'),
        ),
      ).toBe(true),
    )
    expect(orchestrator.queue(thread.id).items.map((item) => item.text)).toEqual(['queued'])
    await orchestrator.disposeAll()
  })

  it('resumes queued work after a crash without another user submission', async () => {
    const { orchestrator, sessions } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'first')
    await orchestrator.submitTurn(thread.id, 'queued')
    sessions[0]!.emit({ type: 'thread.error', threadId: thread.id, message: 'Provider crashed' })
    sessions[0]!.emitDisconnected()
    await vi.waitFor(() => expect(sessions[1]?.sent).toEqual(['queued']))
    await orchestrator.disposeAll()
  })

  it('waits for the dead session to stop before resuming the saved chat', async () => {
    const { orchestrator, sessions, store, resumedIds } = harness()
    let release: () => void = () => {}
    try {
      const thread = await orchestrator.startThread('codex', '/repo')
      await orchestrator.submitTurn(thread.id, 'first')
      const dead = sessions[0]!
      dead.disposeBarrier = new Promise<void>((resolve) => (release = resolve))
      dead.emit({ type: 'thread.error', threadId: thread.id, message: 'Provider disconnected' })
      dead.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'failed' })
      dead.emitDisconnected()

      expect(orchestrator.isRunning(thread.id)).toBe(false)
      expect(store.thread(thread.id)?.closedAt).toBeUndefined()
      expect(dead.disposed).toBe(true)
      const sending = orchestrator.submitTurn(thread.id, 'retry')
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(resumedIds).toEqual([])
      release()
      await expect(sending).resolves.toMatchObject({ queued: false })

      expect(resumedIds).toEqual([thread.id])
      expect(sessions[1]!.sent).toEqual(['retry'])
      dead.emitDisconnected()
      expect(orchestrator.isRunning(thread.id)).toBe(true)
      expect(sessions[1]!.disposed).toBe(false)
    } finally {
      release()
      await orchestrator.disposeAll()
      store.close()
    }
  })

  it('restores a queue claimed by crash completion and sends it once after resume', async () => {
    const { orchestrator, sessions, store, resumedIds, received } = harness()
    let release: (snapshot: checkpoint.Snapshot) => void = () => {}
    const snapshot = vi.spyOn(checkpoint, 'takeSnapshot')
    try {
      const thread = await orchestrator.startThread('codex', '/repo')
      await orchestrator.submitTurn(thread.id, 'A', [], {}, 'a')
      await orchestrator.submitTurn(thread.id, 'B', [], {}, 'b')
      snapshot.mockReturnValueOnce(
        new Promise<checkpoint.Snapshot>((resolve) => (release = resolve)),
      )
      const dead = sessions[0]!
      dead.emit({ type: 'thread.error', threadId: thread.id, message: 'Provider disconnected' })
      dead.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'failed' })
      dead.emitDisconnected()
      expect(store.queuedTurns(thread.id).map((item) => item.text)).toEqual(['B'])

      await expect(orchestrator.submitTurn(thread.id, 'C', [], {}, 'c')).resolves.toMatchObject({
        queued: true,
      })
      await vi.waitFor(() => expect(sessions[1]?.sent).toEqual(['B']))
      release({ commit: 'pre-crash-checkpoint', clean: true })
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(resumedIds).toEqual([thread.id])
      expect(dead.sent).toEqual(['A'])
      expect(sessions[1]!.sent).toEqual(['B'])
      expect(orchestrator.isTurnRunning(thread.id)).toBe(true)
      sessions[1]!.emit({ type: 'turn.completed', turnId: 's2-turn', status: 'completed' })
      await vi.waitFor(() => expect(sessions[1]!.sent).toEqual(['B', 'C']))
      expect(store.queuedTurns(thread.id)).toEqual([])
      expect(
        received.filter(({ event }) => event.type === 'item.completed' && event.item.id === 'b'),
      ).toHaveLength(1)
    } finally {
      release({ commit: 'pre-crash-checkpoint', clean: true })
      await new Promise<void>((resolve) => setImmediate(resolve))
      snapshot.mockRestore()
      await orchestrator.disposeAll()
      store.close()
    }
  })
})

describe('idle thread runtime retention', () => {
  it('keeps only the most recent completed resumable runtimes warm', async () => {
    const { orchestrator, sessions, received } = harness(undefined, new Store(':memory:'), 8)
    const threads = await Promise.all(
      Array.from({ length: 100 }, () => orchestrator.startThread('codex', process.cwd())),
    )

    for (let index = 0; index < threads.length; index += 1) {
      sessions[index]?.emit({
        type: 'turn.completed',
        turnId: `turn-${index}`,
        status: 'completed',
      })
    }

    expect(sessions.filter((session) => session.disposed)).toHaveLength(92)
    expect(threads.filter((thread) => orchestrator.isRunning(thread.id))).toEqual(threads.slice(-8))
    const receivedBeforeLateEvent = received.length
    sessions[0]?.emit(message('late disposed event'))
    expect(received).toHaveLength(receivedBeforeLateEvent)
    await orchestrator.disposeAll()
  })

  it('batches completion-burst pruning while another turn stays active', async () => {
    const { orchestrator, sessions } = harness(undefined, new Store(':memory:'), 1)
    const threads = await Promise.all(
      Array.from({ length: 3 }, () => orchestrator.startThread('codex', process.cwd())),
    )

    for (let index = 0; index < threads.length; index += 1) {
      sessions[index]?.emit(turnStarted(threads[index]!.id, `turn-${index}`))
    }
    sessions[0]?.emit({ type: 'turn.completed', turnId: 'turn-0', status: 'completed' })
    sessions[1]?.emit({ type: 'turn.completed', turnId: 'turn-1', status: 'completed' })

    expect(sessions.filter((session) => session.disposed)).toHaveLength(0)
    await Promise.resolve()
    expect(sessions.filter((session) => session.disposed)).toHaveLength(1)
    expect(orchestrator.isTurnRunning(threads[2]!.id)).toBe(true)

    sessions[2]?.emit({ type: 'turn.completed', turnId: 'turn-2', status: 'completed' })
    expect(sessions.filter((session) => session.disposed)).toHaveLength(2)
    await orchestrator.disposeAll()
  })

  it('keeps a recently viewed idle runtime ahead of an older one', async () => {
    const { orchestrator, sessions } = harness(undefined, new Store(':memory:'), 2)
    const threads = await Promise.all(
      Array.from({ length: 3 }, () => orchestrator.startThread('codex', process.cwd())),
    )

    sessions[0]?.emit({ type: 'turn.completed', turnId: 'turn-0', status: 'completed' })
    sessions[1]?.emit({ type: 'turn.completed', turnId: 'turn-1', status: 'completed' })
    await orchestrator.history(threads[0]!.id)
    sessions[2]?.emit({ type: 'turn.completed', turnId: 'turn-2', status: 'completed' })

    expect(sessions.map((session) => session.disposed)).toEqual([false, true, false])
    await orchestrator.disposeAll()
  })

  it('extends a viewed runtime through the existing earlier expiry timer', async () => {
    vi.useFakeTimers()
    const { orchestrator, sessions } = harness(undefined, new Store(':memory:'), 8, 1_000)
    try {
      const thread = await orchestrator.startThread('codex', process.cwd())
      sessions[0]?.emit({ type: 'turn.completed', turnId: 'turn-0', status: 'completed' })

      await vi.advanceTimersByTimeAsync(500)
      await orchestrator.history(thread.id)
      // The runtime's own timer, and the write of the replay that read built.
      expect(vi.getTimerCount()).toBe(2)

      await vi.advanceTimersByTimeAsync(500)
      expect(sessions[0]?.disposed).toBe(false)
      expect(vi.getTimerCount()).toBe(1)

      await vi.advanceTimersByTimeAsync(500)
      expect(sessions[0]?.disposed).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await orchestrator.disposeAll()
      vi.useRealTimers()
    }
  })

  it('releases the retained warm runtimes after the shared idle window', async () => {
    vi.useFakeTimers()
    const { orchestrator, sessions } = harness(undefined, new Store(':memory:'), 8, 1_000)
    try {
      const threads = await Promise.all(
        Array.from({ length: 100 }, () => orchestrator.startThread('codex', process.cwd())),
      )
      for (let index = 0; index < threads.length; index += 1) {
        sessions[index]?.emit({
          type: 'turn.completed',
          turnId: `turn-${index}`,
          status: 'completed',
        })
      }

      expect(sessions.filter((session) => session.disposed)).toHaveLength(92)
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(999)
      expect(sessions.filter((session) => session.disposed)).toHaveLength(92)
      await vi.advanceTimersByTimeAsync(1)
      expect(sessions.every((session) => session.disposed)).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await orchestrator.disposeAll()
      vi.useRealTimers()
    }
  })

  it('keeps an idle runtime whose agent negotiated no session reload', async () => {
    vi.useFakeTimers()
    const { orchestrator, sessions } = harness(undefined, new Store(':memory:'), 8, 1_000)
    FakeSession.nextResumable = false
    try {
      await orchestrator.startThread('codex', process.cwd())
      sessions[0]?.emit({ type: 'turn.completed', turnId: 'turn-0', status: 'completed' })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(sessions[0]?.disposed).toBe(false)
    } finally {
      FakeSession.nextResumable = undefined
      await orchestrator.disposeAll()
      vi.useRealTimers()
    }
  })

  it('does not schedule expiry before a resumable runtime has a safe resume point', async () => {
    vi.useFakeTimers()
    const { orchestrator, sessions } = harness(undefined, new Store(':memory:'), 8, 1_000)
    try {
      await orchestrator.startThread('codex', process.cwd())

      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(sessions[0]?.disposed).toBe(false)
    } finally {
      await orchestrator.disposeAll()
      vi.useRealTimers()
    }
  })

  it('expires a runtime after its provider rejects the first turn', async () => {
    vi.useFakeTimers()
    const { orchestrator, sessions } = harness(undefined, new Store(':memory:'), 8, 1_000)
    try {
      const thread = await orchestrator.startThread('codex', process.cwd())
      sessions[0]!.sendError = new Error('provider rejected the turn')

      await expect(orchestrator.sendTurn(thread.id, 'Fail')).rejects.toThrow(
        'provider rejected the turn',
      )
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(sessions[0]?.disposed).toBe(true)
    } finally {
      await orchestrator.disposeAll()
      vi.useRealTimers()
    }
  })

  it('expires a failed runtime that never reported turn completion', async () => {
    vi.useFakeTimers()
    const { orchestrator, sessions } = harness(undefined, new Store(':memory:'), 8, 1_000)
    try {
      const thread = await orchestrator.startThread('codex', process.cwd())
      sessions[0]?.emit({
        type: 'thread.error',
        threadId: thread.id,
        message: 'provider failed',
      })

      expect(sessions[0]?.disposed).toBe(false)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(sessions[0]?.disposed).toBe(true)
    } finally {
      await orchestrator.disposeAll()
      vi.useRealTimers()
    }
  })

  it('expires a one-shot resumed runtime after its operation', async () => {
    vi.useFakeTimers()
    const store = new Store(':memory:')
    store.addProject('/repo')
    store.addThread({ id: 'thread-1', projectPath: '/repo', provider: 'codex', title: 'T' })
    const { orchestrator, sessions, resumedIds } = harness(undefined, store, 8, 1_000)
    try {
      await orchestrator.setThreadApproval('thread-1', 'full')

      expect(resumedIds).toEqual(['thread-1'])
      expect(sessions[0]?.disposed).toBe(false)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(sessions[0]?.disposed).toBe(true)
    } finally {
      await orchestrator.disposeAll()
      vi.useRealTimers()
    }
  })

  it('keeps running work alive past the idle window', async () => {
    vi.useFakeTimers()
    const { orchestrator, sessions } = harness(undefined, new Store(':memory:'), 8, 1_000)
    try {
      const thread = await orchestrator.startThread('codex', process.cwd())
      sessions[0]?.emit({ type: 'turn.completed', turnId: 'first', status: 'completed' })
      sessions[0]?.emit({
        type: 'turn.started',
        turn: {
          id: 'working',
          threadId: thread.id,
          status: 'running',
          createdAt: Date.now(),
        },
      })

      await vi.advanceTimersByTimeAsync(10_000)
      expect(sessions[0]?.disposed).toBe(false)
      sessions[0]?.emit({ type: 'turn.completed', turnId: 'working', status: 'completed' })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(sessions[0]?.disposed).toBe(true)
    } finally {
      await orchestrator.disposeAll()
      vi.useRealTimers()
    }
  })

  it('keeps an idle runtime alive while its agent runs background work that will report', async () => {
    vi.useFakeTimers()
    const { orchestrator, sessions, received } = harness(undefined, new Store(':memory:'), 8, 1_000)
    try {
      const thread = await orchestrator.startThread('codex', process.cwd())
      const session = sessions[0]!
      // The turn starts a long check in the background and ends, waiting for it.
      session.emit(turnStarted(thread.id, 'waits'))
      session.runInBackground(true)
      session.emit({ type: 'turn.completed', turnId: 'waits', status: 'completed' })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(session.disposed).toBe(false)

      // The check ends and the agent reports it in a turn nobody sent.
      session.runInBackground(false)
      session.emit(turnStarted(thread.id, 'reports'))
      session.emit(message('The check passed.', 'reports'))
      session.emit({ type: 'turn.completed', turnId: 'reports', status: 'completed' })
      expect(
        received.flatMap(({ event }) => (event.type === 'turn.started' ? [event.turn.id] : [])),
      ).toEqual(['waits', 'reports'])
      expect(orchestrator.isTurnRunning(thread.id)).toBe(false)
      await vi.advanceTimersByTimeAsync(999)
      expect(session.disposed).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(session.disposed).toBe(true)
    } finally {
      await orchestrator.disposeAll()
      vi.useRealTimers()
    }
  })

  it('starts the idle window when background work ends without a turn', async () => {
    vi.useFakeTimers()
    const { orchestrator, sessions } = harness(undefined, new Store(':memory:'), 8, 1_000)
    try {
      const thread = await orchestrator.startThread('codex', process.cwd())
      const session = sessions[0]!
      session.emit(turnStarted(thread.id, 'waits'))
      session.runInBackground(true)
      session.emit({ type: 'turn.completed', turnId: 'waits', status: 'completed' })
      await vi.advanceTimersByTimeAsync(5_000)
      session.runInBackground(false)
      await vi.advanceTimersByTimeAsync(999)
      expect(session.disposed).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(session.disposed).toBe(true)
    } finally {
      await orchestrator.disposeAll()
      vi.useRealTimers()
    }
  })

  it('keeps a runtime with background work out of the warm-runtime limit', async () => {
    const { orchestrator, sessions } = harness(undefined, new Store(':memory:'), 1)
    const threads = await Promise.all(
      Array.from({ length: 3 }, () => orchestrator.startThread('codex', process.cwd())),
    )
    sessions[0]!.emit(turnStarted(threads[0]!.id, 'waits'))
    sessions[0]!.runInBackground(true)
    for (let index = 0; index < threads.length; index += 1) {
      sessions[index]!.emit({
        type: 'turn.completed',
        turnId: index === 0 ? 'waits' : `turn-${index}`,
        status: 'completed',
      })
    }
    // The newest idle runtime stays warm; the one still working is never counted.
    expect(sessions.map((session) => session.disposed)).toEqual([false, true, false])

    sessions[0]!.runInBackground(false)
    await vi.waitFor(() =>
      expect(sessions.map((session) => session.disposed)).toEqual([false, true, true]),
    )
    await orchestrator.disposeAll()
  })

  it('releases an expired runtime when its last queued prompt is removed', async () => {
    vi.useFakeTimers()
    const store = new Store(':memory:')
    const { orchestrator, sessions } = harness(undefined, store, 8, 1_000)
    try {
      const thread = { id: 'persisted-queued' }
      store.addProject(process.cwd())
      store.addThread({
        id: thread.id,
        projectPath: process.cwd(),
        provider: 'codex',
        title: 'Queued retry',
      })
      store.enqueueQueuedTurn({
        id: 'queued',
        threadId: thread.id,
        text: 'Keep me warm.',
        attachments: [],
        options: {},
        createdAt: Date.now(),
      })
      await orchestrator.setThreadApproval(thread.id, 'full')

      await vi.advanceTimersByTimeAsync(10_000)
      expect(sessions[0]?.disposed).toBe(false)
      orchestrator.deleteQueuedTurn(thread.id, 'queued')
      expect(sessions[0]?.disposed).toBe(true)
    } finally {
      await orchestrator.disposeAll()
      vi.useRealTimers()
    }
  })

  it('keeps chats resumable after their project is removed and added back', async () => {
    const store = new Store(':memory:')
    const { orchestrator, sessions, resumedIds } = harness(undefined, store)
    const project = process.cwd()
    try {
      store.addProject(project)
      const thread = await orchestrator.startThread('codex', project)

      // What projects.remove does.
      await Promise.all(store.threads(project).map((t) => orchestrator.stopThread(t.id)))
      orchestrator.forgetProject(project)
      store.removeProject(project)
      expect(sessions[0]?.disposed).toBe(true)
      expect(orchestrator.isRunning(thread.id)).toBe(false)

      store.addProject(project)
      expect(store.sidebarThreads().map((t) => t.id)).toContain(thread.id)
      await orchestrator.submitTurn(thread.id, 'continue')

      expect(resumedIds).toEqual([thread.id])
      expect(sessions[1]?.sent).toEqual(['continue'])
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('keeps a saved Design run when its project is removed', async () => {
    const store = new Store(':memory:')
    const { orchestrator } = harness(undefined, store)
    const project = process.cwd()
    try {
      store.addProject(project)
      const thread = await orchestrator.startThread('codex', project)
      const saved = { originalRequest: 'Build a site.', phase: 'build', suspended: true }
      store.setDesignRun(thread.id, saved)

      // What projects.remove does.
      await Promise.all(store.threads(project).map((t) => orchestrator.stopThread(t.id)))

      expect(store.designRun(thread.id)).toEqual(saved)
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('stops a Side chat with its parent without archiving the parent', async () => {
    const { orchestrator, sessions, store } = harness()
    try {
      const parent = await orchestrator.startThread('claude-code', process.cwd())
      store.append(parent.id, userMessage('parent-user', 'Explain this failure.', 'parent-turn'))
      await orchestrator.startSideThread(parent.id)

      await orchestrator.stopThread(parent.id)

      expect(sessions.every((session) => session.disposed)).toBe(true)
      expect(store.threads().filter((thread) => thread.ephemeral)).toEqual([])
      expect(store.thread(parent.id)?.closedAt).toBeUndefined()
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('resumes an evicted runtime on the next submission', async () => {
    const { orchestrator, sessions, resumedIds } = harness(undefined, new Store(':memory:'), 1)
    const first = await orchestrator.startThread('codex', process.cwd())
    const second = await orchestrator.startThread('codex', process.cwd())
    sessions[0]?.emit({ type: 'turn.completed', turnId: 'turn-0', status: 'completed' })
    sessions[1]?.emit({ type: 'turn.completed', turnId: 'turn-1', status: 'completed' })

    expect(sessions[0]?.disposed).toBe(true)
    await orchestrator.submitTurn(first.id, 'Resume me')

    expect(resumedIds).toEqual([first.id])
    expect(sessions[2]?.sent).toEqual(['Resume me'])
    expect(orchestrator.isRunning(first.id)).toBe(true)
    expect(orchestrator.isRunning(second.id)).toBe(false)
    await orchestrator.disposeAll()
  })

  it('waits for an evicted runtime to stop before resuming it', async () => {
    const { orchestrator, sessions, resumedIds } = harness(undefined, new Store(':memory:'), 1)
    try {
      const first = await orchestrator.startThread('codex', process.cwd())
      let releaseDispose = () => {}
      sessions[0]!.disposeBarrier = new Promise<void>((resolve) => (releaseDispose = resolve))
      await orchestrator.startThread('codex', process.cwd())
      sessions[0]?.emit({ type: 'turn.completed', turnId: 'turn-0', status: 'completed' })
      sessions[1]?.emit({ type: 'turn.completed', turnId: 'turn-1', status: 'completed' })
      expect(sessions[0]?.disposed).toBe(true)

      const resuming = orchestrator.submitTurn(first.id, 'Resume me')
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(resumedIds).toEqual([])
      releaseDispose()
      await resuming
      expect(resumedIds).toEqual([first.id])
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('retries a failed idle-runtime stop at shutdown', async () => {
    const { orchestrator, sessions, logs } = harness(undefined, new Store(':memory:'), 1)
    await orchestrator.startThread('codex', process.cwd())
    sessions[0]!.disposeBarrier = Promise.reject(new Error('agent did not exit'))
    sessions[0]!.disposeBarrier.catch(() => undefined)
    await orchestrator.startThread('codex', process.cwd())
    sessions[0]?.emit({ type: 'turn.completed', turnId: 'turn-0', status: 'completed' })
    sessions[1]?.emit({ type: 'turn.completed', turnId: 'turn-1', status: 'completed' })
    await vi.waitFor(() => expect(logs).toContain('Could not stop idle agent: agent did not exit'))
    sessions[0]!.disposed = false
    sessions[0]!.disposeBarrier = undefined

    await orchestrator.disposeAll()

    expect(sessions[0]?.disposed).toBe(true)
  })

  it('never evicts a running or open Side chat runtime', async () => {
    vi.useFakeTimers()
    const { orchestrator, sessions, store } = harness(undefined, new Store(':memory:'), 1, 1_000)
    try {
      const running = await orchestrator.startThread('codex', process.cwd())
      sessions[0]?.emit({ type: 'turn.completed', turnId: 'finished-once', status: 'completed' })
      sessions[0]?.emit({
        type: 'turn.started',
        turn: {
          id: 'working-now',
          threadId: running.id,
          status: 'running',
          createdAt: Date.now(),
        },
      })
      const parent = await orchestrator.startThread('codex', process.cwd())
      store.append(
        parent.id,
        userMessage('parent-prompt', 'Keep this side chat open.', 'parent-turn'),
      )
      const side = await orchestrator.startSideThread(parent.id)
      sessions[2]?.emit({ type: 'turn.completed', turnId: 'side-finished', status: 'completed' })
      const idle = await orchestrator.startThread('codex', process.cwd())
      sessions[3]?.emit({ type: 'turn.completed', turnId: 'idle-finished', status: 'completed' })

      expect(orchestrator.isRunning(running.id)).toBe(true)
      expect(orchestrator.isRunning(side.id)).toBe(true)
      expect(orchestrator.isRunning(idle.id)).toBe(true)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(orchestrator.isRunning(running.id)).toBe(true)
      expect(orchestrator.isRunning(side.id)).toBe(true)
      expect(orchestrator.isRunning(idle.id)).toBe(false)
      expect(sessions[0]?.disposed).toBe(false)
      expect(sessions[2]?.disposed).toBe(false)
    } finally {
      await orchestrator.disposeAll()
      vi.useRealTimers()
    }
  })

  it('logs and retries a background idle prune whose storage read fails', async () => {
    vi.useFakeTimers()
    const store = new Store(':memory:')
    const { orchestrator, sessions, logs } = harness(undefined, store, 1, 1_000)
    try {
      const thread = await orchestrator.startThread('codex', process.cwd())
      sessions[0]!.emit({ type: 'turn.completed', turnId: 'finished', status: 'completed' })
      await vi.advanceTimersByTimeAsync(0)
      vi.spyOn(store, 'queuedThreadIds').mockImplementationOnce(() => {
        throw new Error('disk I/O error')
      })

      await vi.advanceTimersByTimeAsync(1_000)
      expect(logs).toContain('Could not release idle agents: disk I/O error')
      expect(orchestrator.isRunning(thread.id)).toBe(true)

      await vi.advanceTimersByTimeAsync(30_000)
      expect(orchestrator.isRunning(thread.id)).toBe(false)
    } finally {
      await orchestrator.disposeAll()
      vi.useRealTimers()
    }
  })

  it('keeps a runtime with a pending MCP sign-in after another sign-in fails', async () => {
    vi.useFakeTimers()
    const { orchestrator, sessions } = harness(undefined, new Store(':memory:'), 1, 1_000)
    try {
      const thread = await orchestrator.startThread('codex', process.cwd())
      const session = sessions[0]!
      session.emit({ type: 'turn.completed', turnId: 'finished', status: 'completed' })
      await orchestrator.startMcpOAuth('codex', process.cwd(), 'first-server')
      vi.spyOn(session, 'startMcpOAuth').mockRejectedValueOnce(new Error('login refused'))
      await expect(
        orchestrator.startMcpOAuth('codex', process.cwd(), 'second-server'),
      ).rejects.toThrow('login refused')

      await vi.advanceTimersByTimeAsync(10_000)
      expect(orchestrator.isRunning(thread.id)).toBe(true)

      session.emitMcpOAuth({
        serverId: 'first-server',
        loginId: 'login-first-server',
        success: true,
        error: null,
      })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(orchestrator.isRunning(thread.id)).toBe(false)
    } finally {
      await orchestrator.disposeAll()
      vi.useRealTimers()
    }
  })

  it('never evicts a runtime with a durable queued prompt', async () => {
    const { orchestrator, sessions, store } = harness(undefined, new Store(':memory:'), 1)
    const queued = await orchestrator.startThread('codex', process.cwd())
    const olderIdle = await orchestrator.startThread('codex', process.cwd())
    const recentIdle = await orchestrator.startThread('codex', process.cwd())
    sessions[0]?.emit({ type: 'turn.completed', turnId: 'queued-finished', status: 'completed' })
    store.enqueueQueuedTurn({
      id: 'queued-prompt',
      threadId: queued.id,
      text: 'Keep this queued.',
      attachments: [],
      options: {},
      createdAt: Date.now(),
    })
    sessions[1]?.emit({ type: 'turn.completed', turnId: 'older-finished', status: 'completed' })
    sessions[2]?.emit({ type: 'turn.completed', turnId: 'recent-finished', status: 'completed' })

    expect(orchestrator.isRunning(queued.id)).toBe(true)
    expect(orchestrator.isRunning(olderIdle.id)).toBe(false)
    expect(orchestrator.isRunning(recentIdle.id)).toBe(true)
    await orchestrator.disposeAll()
  })

  it('does not evict sessions whose adapter cannot resume', async () => {
    vi.useFakeTimers()
    const { orchestrator, sessions } = harness(undefined, new Store(':memory:'), 1, 1_000)
    try {
      const threads = await Promise.all(
        Array.from({ length: 4 }, () => orchestrator.startThread('claude-code', process.cwd())),
      )

      for (let index = 0; index < threads.length; index += 1) {
        sessions[index]?.emit({
          type: 'turn.completed',
          turnId: `turn-${index}`,
          status: 'completed',
        })
      }

      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(sessions.every((session) => !session.disposed)).toBe(true)
    } finally {
      await orchestrator.disposeAll()
      vi.useRealTimers()
    }
  })
})

const message = (text: string, turnId = 't1'): DomainEvent => ({
  type: 'item.completed',
  item: {
    id: `i-${text}`,
    turnId,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    text,
    createdAt: 0,
  },
})

const fileEdit = (path: string, turnId: string): DomainEvent => ({
  type: 'item.completed',
  item: {
    id: `edit-${path}`,
    turnId,
    type: 'file_change',
    status: 'completed',
    path,
    createdAt: 0,
  },
})

const userMessage = (
  id: string,
  text: string,
  turnId: string,
  status: 'started' | 'completed' = 'completed',
): DomainEvent => ({
  type: status === 'started' ? 'item.started' : 'item.completed',
  item: {
    id,
    turnId,
    type: 'message',
    role: 'user',
    status,
    text,
    createdAt: 0,
  },
})
const turnStarted = (threadId: string, turnId: string): DomainEvent => ({
  type: 'turn.started',
  turn: { id: turnId, threadId, status: 'running', createdAt: Date.now() },
})
describe('structured user input', () => {
  it('returns answers to the session that owns the waiting request', async () => {
    const { orchestrator, sessions } = harness()
    const thread = await orchestrator.startThread('codex', process.cwd(), {})

    orchestrator.respondToUserInput(thread.id, 'brief-1', {
      palette: ['Decide for me'],
    })

    expect(sessions[0]?.userInputs).toEqual([
      { requestId: 'brief-1', answers: { palette: ['Decide for me'] } },
    ])
  })
})

describe('sidebar status revision', () => {
  it('advances across starting, working, and completed turn state', async () => {
    const { orchestrator, sessions } = harness()
    const thread = await orchestrator.startThread('codex', process.cwd())
    const session = sessions[0]!
    session.release = () => {}
    const initial = orchestrator.sidebarStatusRevision()

    const submitting = orchestrator.submitTurn(thread.id, 'Run')
    await vi.waitFor(() => expect(orchestrator.inboxStatus(thread.id)).toBe('starting'))
    const starting = orchestrator.sidebarStatusRevision()
    expect(starting).toBeGreaterThan(initial)
    expect(orchestrator.sidebarStatusChangesSince(initial)).toEqual([thread.id])

    // A real Git checkpoint precedes sendTurn; allow it to finish under suite load.
    await vi.waitFor(() => expect(session.sent).toEqual(['Run']), { timeout: 5_000 })
    session.release?.()
    const submitted = await submitting
    if (submitted.queued) throw new Error('expected an immediate turn')
    session.emit(turnStarted(thread.id, submitted.turnId))
    expect(orchestrator.inboxStatus(thread.id)).toBe('working')
    const working = orchestrator.sidebarStatusRevision()
    expect(working).toBeGreaterThan(starting)
    expect(orchestrator.sidebarStatusChangesSince(starting)).toEqual([thread.id])

    session.emit({ type: 'turn.completed', turnId: submitted.turnId, status: 'completed' })
    expect(orchestrator.sidebarStatusRevision()).toBeGreaterThan(working)
    expect(orchestrator.sidebarStatusChangesSince(working)).toEqual([thread.id])
    await orchestrator.disposeAll()
  })
})

describe('live access level', () => {
  it('serializes changes so a rejected older request cannot restore a stale mode', async () => {
    const { orchestrator, sessions, store, resumedOptions } = harness()
    const thread = await orchestrator.startThread('codex', '/repo', { approval: 'full' })
    let reject!: (error: Error) => void
    const apply = vi
      .spyOn(sessions[0]!, 'setApproval')
      .mockImplementationOnce(() => new Promise<void>((_resolve, fail) => (reject = fail)))
    const first = orchestrator.setThreadApproval(thread.id, 'auto')
    const failure = expect(first).rejects.toThrow('rejected')
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    const second = orchestrator.setThreadApproval(thread.id, 'ask')
    reject(new Error('rejected'))
    await failure
    await second
    sessions[0]!.emitDisconnected()
    await orchestrator.submitTurn(thread.id, 'next')
    expect(store.threadApproval(thread.id)).toBe('ask')
    expect(resumedOptions.at(-1)?.approval).toBe('ask')
    await orchestrator.disposeAll()
  })

  it('still starts the queued prompt when an access change fails as the turn ends', async () => {
    const { orchestrator, sessions, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo', { approval: 'ask' })
    const session = sessions[0]!
    let reject!: (error: Error) => void
    const apply = vi
      .spyOn(session, 'setApproval')
      .mockImplementationOnce(() => new Promise<void>((_resolve, fail) => (reject = fail)))
    session.turnIds = ['turn-1', 'turn-2']
    await orchestrator.submitTurn(thread.id, 'first')
    session.emit(turnStarted(thread.id, 'turn-1'))
    await expect(orchestrator.submitTurn(thread.id, 'second')).resolves.toMatchObject({
      queued: true,
    })
    const changing = orchestrator.setThreadApproval(thread.id, 'full')
    const failure = expect(changing).rejects.toThrow('permission mode change failed')
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    session.emit({ type: 'turn.completed', turnId: 'turn-1', status: 'completed' })
    reject(new Error('permission mode change failed'))
    await failure

    await vi.waitFor(() => expect(session.sent).toEqual(['first', 'second']))
    expect(orchestrator.queue(thread.id).items).toEqual([])
    expect(store.threadApproval(thread.id)).toBe('ask')
    await orchestrator.disposeAll()
  })

  it('sends a prompt submitted while an access change fails', async () => {
    const { orchestrator, sessions, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo', { approval: 'ask' })
    const session = sessions[0]!
    let reject!: (error: Error) => void
    const apply = vi
      .spyOn(session, 'setApproval')
      .mockImplementationOnce(() => new Promise<void>((_resolve, fail) => (reject = fail)))
    const changing = orchestrator.setThreadApproval(thread.id, 'full')
    const failure = expect(changing).rejects.toThrow('permission mode change failed')
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    const sending = orchestrator.submitTurn(thread.id, 'hello')
    reject(new Error('permission mode change failed'))
    await failure

    await expect(sending).resolves.toMatchObject({ queued: false })
    expect(session.sent).toEqual(['hello'])
    expect(store.threadApproval(thread.id)).toBe('ask')
    await orchestrator.disposeAll()
  })

  it('relaunches an idle session that cannot change its access mode', async () => {
    const { orchestrator, sessions, resumedOptions } = harness()
    const thread = await orchestrator.startThread('codex', '/repo', { approval: 'full' })
    Object.defineProperty(sessions[0], 'setApproval', { value: undefined })
    await orchestrator.setThreadApproval(thread.id, 'ask')
    await orchestrator.submitTurn(thread.id, 'next')
    expect(sessions[0]!.disposed).toBe(true)
    expect(resumedOptions.at(-1)?.approval).toBe('ask')
    await orchestrator.disposeAll()
  })

  it('rejects an unsupported live access change while a turn is running', async () => {
    const { orchestrator, sessions, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo', { approval: 'full' })
    Object.defineProperty(sessions[0], 'setApproval', { value: undefined })
    await orchestrator.submitTurn(thread.id, 'running')
    await expect(orchestrator.setThreadApproval(thread.id, 'ask')).rejects.toThrow(/stop.*turn/i)
    expect(store.threadApproval(thread.id)).toBe('full')
    expect(orchestrator.isTurnRunning(thread.id)).toBe(true)
    await orchestrator.disposeAll()
  })

  it.each(['ask', 'auto', 'auto-review', 'full'] as const)(
    'restores %s after the database and server reopen',
    async (mode) => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'approval-restart-'))
      const database = path.join(directory, 'state.db')
      let store = new Store(database)
      try {
        const first = harness(undefined, store)
        const thread = await first.orchestrator.startThread('codex', process.cwd(), {
          approval: mode,
        })
        await first.orchestrator.disposeAll()
        store.close()
        store = new Store(database)
        const second = harness(undefined, store)
        await second.orchestrator.submitTurn(thread.id, 'Continue')
        expect(second.resumedOptions[0]).toMatchObject({ approval: mode })
        await second.orchestrator.setThreadApproval(thread.id, 'auto')
        await second.orchestrator.disposeAll()
        store.close()
        store = new Store(database)
        expect(store.threadApproval(thread.id)).toBe('auto')
      } finally {
        store.close()
        rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    },
  )

  it('records the new mode and forwards it to the session', async () => {
    const { orchestrator, sessions } = harness()
    const thread = await orchestrator.startThread('codex', process.cwd(), { approval: 'ask' })

    await orchestrator.setThreadApproval(thread.id, 'full')

    expect(sessions[0]?.approvalModes).toEqual(['full'])
  })

  it('resumes a persisted thread with the selected mode', async () => {
    const store = new Store(':memory:')
    store.addProject('/repo')
    store.addThread({
      id: 'persisted-thread',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Persisted',
    })
    const { orchestrator, resumedIds, resumedOptions } = harness(undefined, store)

    await orchestrator.setThreadApproval('persisted-thread', 'full')

    expect(resumedIds).toEqual(['persisted-thread'])
    expect(resumedOptions[0]).toMatchObject({ approval: 'full' })
  })

  it('throws for a thread it does not know', async () => {
    const { orchestrator } = harness()

    await expect(orchestrator.setThreadApproval('missing-thread', 'auto')).rejects.toThrow(
      /no such thread/,
    )
  })
})

describe('reply style', () => {
  it.each(ProviderIdSchema.options)(
    'starts %s with the shared reply instructions',
    async (provider) => {
      const { orchestrator, startedOptions } = harness()
      await orchestrator.startThread(provider, process.cwd())

      expect(startedOptions[0]?.instructions).toContain('clear, capable teammate')
      expect(startedOptions[0]?.instructions).toContain('Do not use em dashes')
      expect(startedOptions[0]?.instructions).toContain(
        'When a task is done, end the turn with a short wrap-up',
      )
      expect(startedOptions[0]?.instructions).toContain('Skip file-by-file inventories')
    },
  )

  it('keeps the shared reply instructions free of the em dashes they forbid', () => {
    expect(REPLY_STYLE_INSTRUCTIONS).not.toContain('—')
  })
})

describe('default skills', () => {
  const skillsHarness = async (services?: ProviderControlsOptions['services']) => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'tc-orchestrator-skills-'))
    onTestFinished(() =>
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    )
    const root = await writeDefaultSkillsFixture(parent)
    // A provider that loads `.agents/skills` lists the user's and the project's; keep both empty.
    const project = path.join(parent, 'project')
    const home = path.join(parent, 'home')
    mkdirSync(project)
    mkdirSync(home)
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home)
    onTestFinished(() => homedir.mockRestore())
    return {
      root,
      project,
      ...harness(undefined, undefined, undefined, undefined, services, root),
    }
  }

  it.each(ProviderIdSchema.options)('lists the bundled skills for %s', async (provider) => {
    const { orchestrator, project } = await skillsHarness()
    const inventory = await orchestrator.listSkills(provider, project)

    expect(
      inventory.skills
        .filter((skill) => skill.id.startsWith('tastecode:'))
        .map((skill) => [skill.name, skill.scope]),
    ).toEqual([
      ['cinetic', 'system'],
      ['design-taste-frontend', 'system'],
      ['cook', 'system'],
    ])
    await orchestrator.disposeAll()
  })

  it.each(ProviderIdSchema.options)(
    'gives %s chats the default skills, but not a Side chat',
    async (provider) => {
      const { orchestrator, startedOptions, store, root } = await skillsHarness()
      const parent = await orchestrator.startThread(provider, process.cwd())
      store.append(parent.id, userMessage(`user-${provider}`, 'Question', 'parent-turn'))
      await orchestrator.startSideThread(parent.id)

      expect(startedOptions[0]?.instructions).toContain('Do not use em dashes')
      if (PROVIDER_CAPABILITIES[provider].defaultSkillsPlugin) {
        // Loaded natively as a plugin, so the catalog would only repeat it.
        expect(startedOptions[0]?.skillPlugin).toBe(root)
        expect(startedOptions[0]?.instructions).not.toContain('Skills included with TasteCode')
      } else {
        expect(startedOptions[0]?.instructions).toContain('Skills included with TasteCode')
        expect(startedOptions[0]?.instructions).toContain(path.join(root, 'skills'))
        expect(startedOptions[0]?.instructions).toContain('- cook: long reference-matching loops')
        expect(startedOptions[0]?.skillPlugin).toBeUndefined()
      }
      expect(startedOptions[1]?.instructions).not.toContain('Skills included with TasteCode')
      expect(startedOptions[1]?.skillPlugin).toBeUndefined()
      await orchestrator.disposeAll()
    },
  )

  it('starts without a catalog when no bundle was given', async () => {
    const { orchestrator, startedOptions } = harness()
    await orchestrator.startThread('cursor', process.cwd())
    expect(startedOptions[0]?.instructions).not.toContain('Skills included with TasteCode')
    await orchestrator.disposeAll()
  })

  describe('Creatify', () => {
    const userItems = (store: Store, threadId: string) =>
      store
        .history(threadId)
        .flatMap(({ event }) =>
          event.type === 'item.completed' && event.item.role === 'user' ? [event.item] : [],
        )
    const shown = (store: Store, threadId: string) =>
      userItems(store, threadId).map((item) => [item.text, item.attachments])

    it('puts the creative skills note behind the prompt and keeps the marker from the agent', async () => {
      const { orchestrator, sessions, store, root, project } = await skillsHarness()
      try {
        const thread = await orchestrator.startThread('codex', project)
        const sent = await orchestrator.submitTurn(
          thread.id,
          'Build a landing page for a bakery.',
          ['/shot.png', CREATIFY_ATTACHMENT],
          {},
          'creatify-1',
        )
        if (sent.queued) throw new Error('expected the turn to start')

        const prompt = sessions[0]!.sent[0]!
        // The words lead: a provider names its session after the start of the first prompt.
        expect(prompt.startsWith(`Build a landing page for a bakery.${CREATIFY_NOTE_OPEN}`)).toBe(
          true,
        )
        expect(prompt).toContain(
          `- cinetic: cinematic videos and motion design made in code (${path.join(root, 'skills', 'cinetic', 'SKILL.md')})`,
        )
        expect(prompt).toContain(path.join(root, 'skills', 'design-taste-frontend', 'SKILL.md'))
        expect(prompt.endsWith(CREATIFY_NOTE_CLOSE)).toBe(true)
        // The marker is TasteCode's own; an agent shown it as a file tries to read it.
        expect(sessions[0]!.sentAttachments[0]).toEqual(['/shot.png'])

        // The chat shows what the user wrote and attached, nothing of the note.
        sessions[0]!.emit(turnStarted(thread.id, sent.turnId))
        expect(shown(store, thread.id)).toEqual([
          ['Build a landing page for a bakery.', ['/shot.png']],
        ])
        sessions[0]!.emit({ type: 'turn.completed', turnId: sent.turnId, status: 'completed' })
      } finally {
        await orchestrator.disposeAll()
      }
    })

    it('shows only the words when the client names no submission and the agent echoes its prompt', async () => {
      const { orchestrator, sessions, store, project } = await skillsHarness()
      try {
        const thread = await orchestrator.startThread('codex', project)
        const turnId = await orchestrator.sendTurn(thread.id, 'Make a launch film.', [
          CREATIFY_ATTACHMENT,
        ])
        sessions[0]!.emit(turnStarted(thread.id, turnId))
        // The agent's own copy of the prompt carries the note; it must not become a row.
        sessions[0]!.emit(userMessage('provider-echo', sessions[0]!.sent[0]!, turnId))

        expect(shown(store, thread.id)).toEqual([['Make a launch film.', undefined]])
        sessions[0]!.emit({ type: 'turn.completed', turnId, status: 'completed' })
      } finally {
        await orchestrator.disposeAll()
      }
    })

    it('sends the prompt as written when no skill is installed', async () => {
      const { orchestrator, sessions } = harness()
      try {
        const thread = await orchestrator.startThread('codex', '/repo')
        await orchestrator.sendTurn(thread.id, 'Make a launch film.', [CREATIFY_ATTACHMENT])

        expect(sessions[0]!.sent).toEqual(['Make a launch film.'])
        expect(sessions[0]!.sentAttachments[0]).toEqual([])
      } finally {
        await orchestrator.disposeAll()
      }
    })

    it('is an ordinary turn even with the old Design marker beside it', async () => {
      const { orchestrator, sessions } = harness()
      try {
        const thread = await orchestrator.startThread('codex', '/repo')
        await orchestrator.sendTurn(thread.id, 'Build a site.', [
          DESIGN_BRIEF_ATTACHMENT,
          CREATIFY_ATTACHMENT,
        ])

        // Neither marker is handed over as a file.
        expect(sessions[0]!.sent).toEqual(['Build a site.'])
        expect(sessions[0]!.sentAttachments[0]).toEqual([])
      } finally {
        await orchestrator.disposeAll()
      }
    })

    it('adds the note to a queued prompt when its turn starts, and shows the queue without the marker', async () => {
      const { orchestrator, sessions, store, project } = await skillsHarness()
      try {
        const thread = await orchestrator.startThread('codex', project)
        sessions[0]!.turnIds.push('first-turn', 'second-turn')
        const first = await orchestrator.submitTurn(thread.id, 'Fix the header.', [], {}, 'first')
        if (first.queued) throw new Error('expected the first turn to start')
        sessions[0]!.emit(turnStarted(thread.id, 'first-turn'))
        // Queued without a submission id, as a client that names none sends it.
        const queued = await orchestrator.submitTurn(thread.id, 'Now a sound for the button.', [
          CREATIFY_ATTACHMENT,
        ])
        if (!queued.queued) throw new Error('expected the prompt to queue')
        expect(queued.queuedTurn.attachments).toEqual([])

        sessions[0]!.emit({ type: 'turn.completed', turnId: 'first-turn', status: 'completed' })
        await vi.waitFor(() => expect(sessions[0]!.sent).toHaveLength(2))

        expect(
          sessions[0]!.sent[1]!.startsWith(`Now a sound for the button.${CREATIFY_NOTE_OPEN}`),
        ).toBe(true)
        expect(sessions[0]!.sentAttachments[1]).toEqual([])

        // Its record takes it off the queue with the row, so a start that failed
        // after the record could not leave it queued and shown twice.
        sessions[0]!.emit(turnStarted(thread.id, 'second-turn'))
        expect(shown(store, thread.id).map(([text]) => text)).toEqual([
          'Fix the header.',
          'Now a sound for the button.',
        ])
        expect(orchestrator.queue(thread.id).items).toEqual([])
        expect(userItems(store, thread.id).at(-1)?.id).toBe(queued.queuedTurn.id)
        sessions[0]!.emit({ type: 'turn.completed', turnId: 'second-turn', status: 'completed' })
      } finally {
        await orchestrator.disposeAll()
      }
    })

    it('steers a queued prompt with its note, without the marker, and shows its words', async () => {
      const { orchestrator, sessions, store, project } = await skillsHarness()
      try {
        const thread = await orchestrator.startThread('codex', project)
        sessions[0]!.turnIds.push('running-turn')
        const first = await orchestrator.submitTurn(thread.id, 'Fix the header.', [], {}, 'first')
        if (first.queued) throw new Error('expected the first turn to start')
        sessions[0]!.emit(turnStarted(thread.id, 'running-turn'))
        // No submission id: TasteCode still has to record the words itself, because
        // the agent's copy of them carries the note.
        const queued = await orchestrator.submitTurn(thread.id, 'Make it calmer.', [
          CREATIFY_ATTACHMENT,
        ])
        if (!queued.queued) throw new Error('expected the prompt to queue')

        await orchestrator.steerQueuedTurn(thread.id, queued.queuedTurn.id)

        const steered = sessions[0]!.steered[0]!
        expect(steered.startsWith(`Make it calmer.${CREATIFY_NOTE_OPEN}`)).toBe(true)
        expect(steered.endsWith(CREATIFY_NOTE_CLOSE)).toBe(true)
        expect(sessions[0]!.steeredAttachments).toEqual([[]])
        sessions[0]!.emit(userMessage('steer-echo', steered, 'running-turn'))
        expect(shown(store, thread.id).map(([text]) => text)).toEqual([
          'Fix the header.',
          'Make it calmer.',
        ])
        sessions[0]!.emit({ type: 'turn.completed', turnId: 'running-turn', status: 'completed' })
      } finally {
        await orchestrator.disposeAll()
      }
    })
  })

  it('lists the bundled skills as commands where the provider loads them as a plugin', async () => {
    // Claude Code runs `/cook` as the plugin's `tastecode:cook`, but its probe
    // starts without the plugin. Without these rows the slash menu offered
    // `$cook` while the list loaded and after, which Claude does not expand.
    let finish: (() => void) | undefined
    const discover = vi.fn(
      () =>
        new Promise<{ commands: ProviderCommand[]; servers: McpServer[] }>((resolve) => {
          finish = () =>
            resolve({ commands: [{ name: 'context', description: 'Show context' }], servers: [] })
        }),
    )
    const { orchestrator, sessions, commandChanges } = await skillsHarness({
      'claude-code': { projectInventory: { mcpCapabilities: CLAUDE_MCP_CAPABILITIES, discover } },
    })
    const bundled: ProviderCommand[] = ['cinetic', 'design-taste-frontend', 'cook'].map((name) => ({
      name,
      description: `The long ${name} description.`,
      aliases: [`tastecode:${name}`],
      kind: 'skill',
      source: 'plugin',
    }))
    try {
      await expect(orchestrator.listCommands('claude-code', '/repo')).resolves.toEqual({
        commands: bundled,
        loading: true,
      })
      await vi.waitFor(() => expect(finish).toBeDefined())
      finish!()
      await vi.waitFor(() =>
        expect(commandChanges).toEqual([{ provider: 'claude-code', projectPath: '/repo' }]),
      )
      await expect(orchestrator.listCommands('claude-code', '/repo')).resolves.toEqual({
        commands: [{ name: 'context', description: 'Show context' }, ...bundled],
        loading: false,
      })

      // A chat that loaded the plugin reports its qualified name; keep one bare row.
      const chat = await orchestrator.startThread('claude-code', '/repo')
      const live: ProviderCommand = {
        name: 'tastecode:cook',
        aliases: ['cook'],
        description: '(tastecode) Cook.',
        kind: 'skill',
        source: 'plugin',
      }
      sessions[0]!.commands = [live]
      const inventory = await orchestrator.listCommands('claude-code', '/repo', chat.id)
      expect(inventory).toEqual({
        commands: bundled,
        loading: false,
      })
      expect(sessions[0]!.commands).toEqual([live])
      const selected = inventory.commands.find((command) => command.name === 'cook')!
      await orchestrator.submitTurn(chat.id, `/${selected.name} Build a site`)
      expect(sessions[0]!.sent).toEqual(['/cook Build a site'])

      // A provider that reads them from the catalog has no such commands.
      for (const provider of ProviderIdSchema.options) {
        if (PROVIDER_CAPABILITIES[provider].defaultSkillsPlugin) continue
        const { commands } = await orchestrator.listCommands(provider, '/repo')
        expect(
          commands.filter((command) =>
            command.aliases?.some((alias) => alias.startsWith('tastecode:')),
          ),
        ).toEqual([])
      }
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('collapses manifest-derived aliases while preserving other plugins and user commands', async () => {
    const { orchestrator, sessions, root, project } = await skillsHarness()
    writeFileSync(
      path.join(root, 'skills.json'),
      JSON.stringify({ plugin: { name: 'acme' }, skills: [{ folder: 'cook' }] }),
    )
    writeFileSync(
      path.join(root, 'skills', 'cook', 'SKILL.md'),
      '---\nname: cook-loop\ndescription: Loops.\n---\n',
    )
    const bundled: ProviderCommand = {
      name: 'cook-loop',
      aliases: ['acme:cook'],
      description: 'Loops.',
      kind: 'skill',
      source: 'plugin',
    }
    const probed: ProviderCommand = { name: 'acme:cook', description: 'Probed.' }
    const other: ProviderCommand = { name: 'other:cook', description: 'Another plugin.' }
    const custom: ProviderCommand = { name: 'cook-loop', description: 'My own command.' }
    try {
      const chat = await orchestrator.startThread('claude-code', project)
      sessions[0]!.commands = [probed, other]
      await expect(orchestrator.listCommands('claude-code', project, chat.id)).resolves.toEqual({
        commands: [other, bundled],
        loading: false,
      })

      for (const commands of [
        [probed, custom, other],
        [custom, probed, other],
      ]) {
        sessions[0]!.commands = commands
        await expect(orchestrator.listCommands('claude-code', project, chat.id)).resolves.toEqual({
          commands: [custom, other],
          loading: false,
        })
        expect(sessions[0]!.commands).toEqual(commands)
      }
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('refuses to switch off a bundled skill through a provider', async () => {
    const { orchestrator } = await skillsHarness()
    await expect(
      orchestrator.setSkillEnabled('codex', process.cwd(), 'tastecode:cook', false),
    ).rejects.toThrow(/included with TasteCode/)
    await orchestrator.disposeAll()
  })
})

describe('provider-neutral Side chat', () => {
  it('does not attach a Side chat whose startup crossed Stop all', async () => {
    const { orchestrator, sessions, startBarriers, startedIn, store } = harness()
    const parent = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(parent.id, 'Main question', [], {}, 'main-question')
    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    let release!: () => void
    startBarriers.push(new Promise<void>((resolve) => (release = resolve)))
    const starting = orchestrator.startSideThread(parent.id)
    const rejected = expect(starting).rejects.toThrow(/panic stop/)
    await vi.waitFor(() => expect(startedIn).toHaveLength(2))
    await orchestrator.panicStop()
    release()
    await rejected
    expect(sessions[1]?.disposed).toBe(true)
    expect(store.thread('thread-2')).toBeUndefined()
    expect(store.providerHistories()).toEqual([
      expect.objectContaining({
        threadId: 'thread-2',
        session: expect.objectContaining({ internal: true }),
      }),
    ])
    await orchestrator.disposeAll()
  })

  it.each(ProviderIdSchema.options)(
    'forks an ephemeral %s session from the parent boundary',
    async (provider) => {
      const { orchestrator, store, sessions, startedOptions, received, sideReceived } = harness()
      const parent = await orchestrator.startThread(provider, process.cwd(), { approval: 'auto' })
      store.append(
        parent.id,
        userMessage(`user-${provider}`, 'Explain this failure.', 'parent-turn'),
      )

      const side = await orchestrator.startSideThread(parent.id, {
        model: 'selected-model',
        effort: 'high',
      })

      expect(side.provider).toBe(provider)
      expect(store.thread(side.id)).toMatchObject({
        ephemeral: true,
        parentThreadId: parent.id,
      })
      expect(store.threads().map((thread) => thread.id)).toEqual([parent.id])
      expect(startedOptions[1]).toMatchObject({
        model: 'selected-model',
        effort: 'high',
        approval: 'auto',
      })
      expect(startedOptions[1]?.instructions).toContain('temporary Side chat')
      expect(startedOptions[1]?.instructions).toContain('Explain this failure.')

      sessions[1]?.emit(message('side answer', 'side-turn'))
      expect(sideReceived).toContainEqual({
        threadId: side.id,
        event: message('side answer', 'side-turn'),
      })
      expect(received.some((entry) => entry.threadId === side.id)).toBe(false)

      expect(await orchestrator.startSideThread(parent.id)).toBe(side)
      await expect(orchestrator.startSideThread(side.id)).rejects.toThrow('cannot be opened')
      orchestrator.closeSideThread(side.id)
      expect(sessions[1]?.disposed).toBe(true)
      expect(sessions[0]?.disposed).toBe(false)
      expect(store.thread(side.id)).toBeUndefined()
    },
  )

  it('rekeys the Side chat history tombstone to the native session id', async () => {
    const { orchestrator, sessions, store } = harness()
    const parent = await orchestrator.startThread('grok', process.cwd())
    store.append(parent.id, userMessage('parent-user', 'Explain this failure.', 'parent-turn'))
    const side = await orchestrator.startSideThread(parent.id)
    const tombstone = [
      expect.objectContaining({
        provider: 'grok',
        threadId: side.id,
        session: expect.objectContaining({ id: 'grok-native-side', internal: true }),
      }),
    ]

    // Grok reports the native id it chose at start as soon as the side chat attaches.
    sessions[1]!.emitProviderSessionId('grok-native-side')
    expect(store.providerHistories()).toEqual(tombstone)

    await orchestrator.closeSideThread(side.id)
    expect(store.providerHistories()).toEqual(tombstone)
    await orchestrator.disposeAll()
  })

  it('reuses the compact replay snapshot for a long parent boundary', async () => {
    const { orchestrator, store } = harness()
    const parent = await orchestrator.startThread('api', process.cwd())
    store.append(parent.id, userMessage('parent-user', 'Explain this failure.', 'parent-turn'))
    for (let index = 0; index < 100; index += 1) {
      store.append(parent.id, {
        type: 'item.delta',
        turnId: 'parent-turn',
        itemId: 'parent-answer',
        textDelta: 'x',
      })
    }
    expect(store.tailReplaySnapshotForResponse(parent.id)).toBeUndefined()

    const side = await orchestrator.startSideThread(parent.id)

    expect(store.tailReplaySnapshotForResponse(parent.id)).toBeDefined()
    orchestrator.closeSideThread(side.id)
    await orchestrator.disposeAll()
  })

  it('refuses a replacement Side chat while its parent is closing', async () => {
    const { orchestrator, sessions, store } = harness()
    try {
      const parent = await orchestrator.startThread('claude-code', process.cwd())
      store.append(parent.id, userMessage('parent-user', 'Explain this failure.', 'parent-turn'))
      await orchestrator.startSideThread(parent.id)
      let releaseSide = () => {}
      sessions[1]!.disposeBarrier = new Promise<void>((resolve) => (releaseSide = resolve))

      const closing = orchestrator.close(parent.id)
      const replacement = orchestrator.startSideThread(parent.id)
      const refused = expect(replacement).rejects.toThrow()
      await new Promise<void>((resolve) => setImmediate(resolve))
      releaseSide()
      await closing
      await refused

      expect(sessions.slice(2).every((session) => session.disposed)).toBe(true)
      expect(store.threads().filter((thread) => thread.ephemeral)).toEqual([])
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('retries a failed Side chat stop when the close is retried', async () => {
    const { orchestrator, sessions, store } = harness()
    try {
      const parent = await orchestrator.startThread('claude-code', process.cwd())
      store.append(parent.id, userMessage('parent-user', 'Explain this failure.', 'parent-turn'))
      const side = await orchestrator.startSideThread(parent.id)
      const sideSession = sessions[1]!
      sideSession.disposeBarrier = Promise.reject(new Error('agent did not exit'))
      sideSession.disposeBarrier.catch(() => undefined)

      await expect(orchestrator.closeSideThread(side.id)).rejects.toThrow('agent did not exit')
      expect(store.thread(side.id)).toBeUndefined()
      sideSession.disposed = false
      sideSession.disposeBarrier = undefined

      await orchestrator.closeSideThread(side.id)
      expect(sideSession.disposed).toBe(true)
    } finally {
      await orchestrator.disposeAll()
    }
  })
})

describe('queued Side-chat channel', () => {
  const sideUserTexts = (events: Array<{ event: DomainEvent }>): string[] =>
    events.flatMap(({ event }) =>
      event.type === 'item.completed' && event.item.type === 'message' && event.item.role === 'user'
        ? [event.item.text ?? '']
        : [],
    )

  it('keeps a queued Side-chat prompt on the Side-chat channel while the main turn runs', async () => {
    const { orchestrator, store, sessions, received, sideReceived } = harness()
    try {
      const parent = await orchestrator.startThread('codex', '/repo')
      store.append(parent.id, userMessage('parent-user', 'Explain this failure.', 'parent-turn'))

      const side = await orchestrator.startSideThread(parent.id)

      const main = await orchestrator.submitTurn(parent.id, 'Main work.', [], {}, 'main-submission')
      if (main.queued) throw new Error('expected the main turn to start')
      sessions[1]?.turnIds.push('side-first-turn', 'side-second-turn')
      const first = await orchestrator.submitTurn(side.id, 'Side first.', [], {}, 'side-first')
      if (first.queued) throw new Error('expected the Side-chat turn to start')
      const queued = await orchestrator.submitTurn(side.id, 'Side queued.', [], {}, 'side-queued')
      if (!queued.queued) throw new Error('expected the Side-chat prompt to queue')

      expect(store.queuedTurns(side.id).map(({ id }) => id)).toEqual(['side-queued'])

      sessions[1]?.emit({ type: 'turn.completed', turnId: 'side-first-turn', status: 'completed' })
      await vi.waitFor(() => expect(sessions[1]?.sent).toEqual(['Side first.', 'Side queued.']))

      expect(sideUserTexts(sideReceived)).toContain('Side queued.')
      expect(received.some(({ threadId }) => threadId === side.id)).toBe(false)

      sessions[1]?.emit(message('Side answer.', 'side-second-turn'))
      expect(
        sideReceived.some(
          ({ threadId, event }) =>
            threadId === side.id &&
            event.type === 'item.completed' &&
            event.item.type === 'message' &&
            event.item.text === 'Side answer.',
        ),
      ).toBe(true)
      expect(received.some(({ threadId }) => threadId === side.id)).toBe(false)

      const sideTexts = store
        .history(side.id)
        .flatMap(({ event }) =>
          event.type === 'item.completed' && event.item.type === 'message'
            ? [event.item.text ?? '']
            : [],
        )
      expect(sideTexts.indexOf('Side first.')).toBeLessThan(sideTexts.indexOf('Side queued.'))
      expect(
        store
          .history(parent.id)
          .some(({ event }) => JSON.stringify(event).includes('Side queued.')),
      ).toBe(false)

      sessions[1]?.emit({ type: 'turn.completed', turnId: 'side-second-turn', status: 'completed' })
      expect(orchestrator.isTurnRunning(parent.id)).toBe(true)
      sessions[0]?.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('steers a queued Side-chat prompt on the Side-chat channel', async () => {
    const { orchestrator, store, sessions, received, sideReceived } = harness()
    try {
      const parent = await orchestrator.startThread('codex', '/repo')
      store.append(parent.id, userMessage('parent-user', 'Explain this failure.', 'parent-turn'))

      const side = await orchestrator.startSideThread(parent.id)
      sessions[1]?.turnIds.push('side-first-turn')
      const first = await orchestrator.submitTurn(side.id, 'Side first.', [], {}, 'side-first')
      if (first.queued) throw new Error('expected the Side-chat turn to start')
      const queued = await orchestrator.submitTurn(side.id, 'Steer me.', [], {}, 'side-steer')
      if (!queued.queued) throw new Error('expected the Side-chat prompt to queue')

      await orchestrator.steerQueuedTurn(side.id, queued.queuedTurn.id)

      expect(sessions[1]?.steered).toEqual(['Steer me.'])
      expect(sideUserTexts(sideReceived)).toContain('Steer me.')
      expect(received.some(({ threadId }) => threadId === side.id)).toBe(false)

      sessions[1]?.emit({ type: 'turn.completed', turnId: 'side-first-turn', status: 'completed' })
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('steers a prompt queued in Design mode without the Design marker as a file', async () => {
    const { orchestrator, sessions } = harness()
    try {
      const thread = await orchestrator.startThread('codex', '/repo')
      sessions[0]?.turnIds.push('running-turn')
      const first = await orchestrator.submitTurn(thread.id, 'Fix the header.', [], {}, 'first')
      if (first.queued) throw new Error('expected the first turn to start')
      const queued = await orchestrator.submitTurn(
        thread.id,
        'Make it calmer.',
        [DESIGN_BRIEF_ATTACHMENT],
        {},
        'design-queued',
      )
      if (!queued.queued) throw new Error('expected the prompt to queue')

      await orchestrator.steerQueuedTurn(thread.id, queued.queuedTurn.id)

      // The marker is TasteCode's own; an agent shown it as a file tries to read it.
      expect(sessions[0]?.steered).toEqual(['Make it calmer.'])
      expect(sessions[0]?.steeredAttachments).toEqual([[]])
      sessions[0]?.emit({ type: 'turn.completed', turnId: 'running-turn', status: 'completed' })
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('preserves the Side-chat channel across an orchestrator restart', async () => {
    const first = harness()
    const parent = await first.orchestrator.startThread('codex', '/repo')
    first.store.append(
      parent.id,
      userMessage('parent-user', 'Explain this failure.', 'parent-turn'),
    )
    const side = await first.orchestrator.startSideThread(parent.id)
    first.sessions[1]?.turnIds.push('side-first-turn')
    await first.orchestrator.submitTurn(side.id, 'Side first.', [], {}, 'side-first')
    const queued = await first.orchestrator.submitTurn(
      side.id,
      'Side queued.',
      [],
      {},
      'side-queued',
    )
    if (!queued.queued) throw new Error('expected the Side-chat prompt to queue')
    expect(first.store.queuedTurns(side.id).map(({ id }) => id)).toEqual(['side-queued'])
    await first.orchestrator.disposeAll()

    const restarted = harness(undefined, first.store)
    try {
      expect(restarted.orchestrator.queue(side.id).items.map(({ id }) => id)).toEqual([
        'side-queued',
      ])
      const wake = await restarted.orchestrator.submitTurn(
        side.id,
        'Wake.',
        [],
        {},
        'wake-submission',
      )
      expect(wake.queued).toBe(true)
      await vi.waitFor(() => expect(restarted.sessions[0]?.sent).toEqual(['Side queued.']))

      expect(sideUserTexts(restarted.sideReceived)).toContain('Side queued.')
      expect(restarted.received.some(({ threadId }) => threadId === side.id)).toBe(false)
      expect(restarted.resumedIds).toContain(side.id)

      restarted.sessions[0]?.emit(message('Side resumed answer.', 's1-turn'))
      expect(
        restarted.sideReceived.some(
          ({ threadId, event }) =>
            threadId === side.id &&
            event.type === 'item.completed' &&
            event.item.type === 'message' &&
            event.item.text === 'Side resumed answer.',
        ),
      ).toBe(true)
      expect(restarted.received.some(({ threadId }) => threadId === side.id)).toBe(false)

      expect(restarted.orchestrator.queue(side.id).items.map(({ id }) => id)).toEqual([
        'wake-submission',
      ])
    } finally {
      await restarted.orchestrator.disposeAll()
      first.store.close()
    }
  })

  it('purges queued Side chats on a full store restart instead of leaking them', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-side-queue-restart-'))
    const file = path.join(dir, 'harness.db')
    const seededStore = new Store(file)
    const seeded = harness(undefined, seededStore)
    try {
      const parent = await seeded.orchestrator.startThread('codex', '/repo')
      seeded.store.append(
        parent.id,
        userMessage('parent-user', 'Explain this failure.', 'parent-turn'),
      )
      const side = await seeded.orchestrator.startSideThread(parent.id)
      seeded.sessions[1]?.turnIds.push('side-first-turn')
      await seeded.orchestrator.submitTurn(parent.id, 'Main work.', [], {}, 'main-submission')
      await seeded.orchestrator.submitTurn(side.id, 'Side first.', [], {}, 'side-first')
      await seeded.orchestrator.submitTurn(parent.id, 'Main queued.', [], {}, 'main-queued')
      const queued = await seeded.orchestrator.submitTurn(
        side.id,
        'Side queued.',
        [],
        {},
        'side-queued',
      )
      if (!queued.queued) throw new Error('expected the Side-chat prompt to queue')
      await seeded.orchestrator.disposeAll()
      seededStore.close()

      const restartedStore = new Store(file)
      try {
        expect(restartedStore.thread(side.id)).toBeUndefined()
        expect(restartedStore.queuedTurns(side.id)).toEqual([])
        expect(restartedStore.providerHistories()).toContainEqual(
          expect.objectContaining({
            threadId: side.id,
            session: expect.objectContaining({ internal: true }),
          }),
        )
        expect(restartedStore.queuedTurns(parent.id).map(({ id }) => id)).toEqual(['main-queued'])
      } finally {
        restartedStore.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
})

describe('workspace paths', () => {
  it('expands a home-relative project before starting Grok and taking checkpoints', async () => {
    const projectPath = ['~', 'Developer', 'harness'].join(path.sep)
    const resolvedPath = path.join(os.homedir(), 'Developer', 'harness')
    const { orchestrator, startedIn, store } = harness()
    const snapshot = vi
      .spyOn(checkpoint, 'takeSnapshot')
      .mockResolvedValueOnce({ commit: 'checkpoint', clean: true })

    const thread = await orchestrator.startThread('grok', projectPath)
    await orchestrator.sendTurn(thread.id, 'hello')

    expect(startedIn).toEqual([resolvedPath])
    expect(snapshot).toHaveBeenCalledWith(resolvedPath, { retainIn: expect.any(String) })
    expect(store.thread(thread.id)?.projectPath).toBe(projectPath)
    await orchestrator.disposeAll()
  })
})

describe('durable turn timing', () => {
  it('replays the accepted start after a provider reports a later timestamp', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const optimistic = beginOptimisticTurn(emptyThread, 'Do the work.')
    const { orchestrator, sessions, store } = harness()
    try {
      const thread = await orchestrator.startThread('api', '/repo')
      const session = sessions[0]!
      session.turnIds.push('turn-replay')
      await orchestrator.sendTurn(thread.id, 'Do the work.')

      now.mockReturnValue(5_000)
      session.emit({
        type: 'turn.started',
        turn: { id: 'turn-replay', threadId: thread.id, status: 'running', createdAt: 5_000 },
      })
      now.mockReturnValue(8_000)
      const answer = message('Done.', 'turn-replay')
      if (answer.type !== 'item.completed') throw new Error('expected completed message')
      session.emit({ ...answer, item: { ...answer.item, createdAt: 8_000 } })
      session.emit({ type: 'turn.completed', turnId: 'turn-replay', status: 'completed' })

      const history = store.history(thread.id)
      const replayed = reduceEventLog(emptyThread, history)
      const live = reduceEventLog(optimistic, history)
      expect(replayed.turnTiming['turn-replay']).toEqual({ startedAt: 1_000, completedAt: 8_000 })
      expect(
        [live, replayed].map(
          (state) =>
            projectThreadItems(state.items, state.turnTiming).presentations.get('turn-replay')
              ?.elapsedMs,
        ),
      ).toEqual([7_000, 7_000])
    } finally {
      now.mockRestore()
      await orchestrator.disposeAll()
    }
  })

  it('normalizes a start emitted before the provider returns its turn id', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { orchestrator, sessions, store } = harness()
    try {
      const thread = await orchestrator.startThread('api', '/repo')
      const session = sessions[0]!
      session.turnIds.push('turn-sync')
      session.eventDuringSend = {
        type: 'turn.started',
        turn: { id: 'turn-sync', threadId: thread.id, status: 'running', createdAt: 5_000 },
      }

      await orchestrator.sendTurn(thread.id, 'Do the work.')

      expect(store.history(thread.id).at(-1)?.event).toMatchObject({
        type: 'turn.started',
        turn: { id: 'turn-sync', createdAt: 1_000 },
      })
    } finally {
      now.mockRestore()
      await orchestrator.disposeAll()
    }
  })

  it.each(['codex', 'api'] as const)(
    'records server-owned lifecycle boundaries for %s turns',
    async (provider) => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
      const { orchestrator, sessions, store, received } = harness()
      try {
        const thread = await orchestrator.startThread(provider, '/repo')
        const session = sessions[0]!
        session.turnIds.push('turn-1')
        await orchestrator.sendTurn(thread.id, 'Do the work.')

        now.mockReturnValue(5_000)
        session.emit({
          type: 'turn.started',
          turn: { id: 'turn-1', threadId: thread.id, status: 'running', createdAt: 5_000 },
        })
        now.mockReturnValue(32_000)
        session.emit({
          type: 'turn.completed',
          turnId: 'turn-1',
          status: 'completed',
          completedAt: 4_000,
        })

        const lifecycle = store
          .history(thread.id)
          .map(({ event }) => event)
          .filter((event) => event.type === 'turn.started' || event.type === 'turn.completed')
        expect(lifecycle).toEqual([
          {
            type: 'turn.started',
            turn: { id: 'turn-1', threadId: thread.id, status: 'running', createdAt: 1_000 },
          },
          {
            type: 'turn.completed',
            turnId: 'turn-1',
            status: 'completed',
            completedAt: 32_000,
          },
        ])
        expect(received.map(({ event }) => event).slice(-2)).toEqual(lifecycle)
      } finally {
        now.mockRestore()
        await orchestrator.disposeAll()
      }
    },
  )

  it('anchors queued and design turns when their provider work actually starts', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-timing-'))
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { orchestrator, sessions, store } = harness()
    try {
      const thread = await orchestrator.startThread('codex', workspace)
      const session = sessions[0]!
      session.turnIds.push('first', 'queued', 'design')
      await orchestrator.submitTurn(thread.id, 'First')
      await orchestrator.submitTurn(thread.id, 'Queued')

      now.mockReturnValue(5_000)
      session.emit({
        type: 'turn.started',
        turn: { id: 'first', threadId: thread.id, status: 'running', createdAt: 5_000 },
      })
      now.mockReturnValue(7_000)
      session.emit({ type: 'turn.completed', turnId: 'first', status: 'completed' })
      await vi.waitFor(() => expect(session.sent).toEqual(['First', 'Queued']))
      now.mockReturnValue(9_000)
      session.emit({
        type: 'turn.started',
        turn: { id: 'queued', threadId: thread.id, status: 'running', createdAt: 9_000 },
      })
      session.emit({ type: 'turn.completed', turnId: 'queued', status: 'completed' })

      now.mockReturnValue(11_000)
      await orchestrator.sendTurn(thread.id, 'Design', ['personal-harness://design-brief-v1'])
      now.mockReturnValue(13_000)
      session.emit({
        type: 'turn.started',
        turn: { id: 'design', threadId: thread.id, status: 'running', createdAt: 13_000 },
      })

      const starts = store
        .history(thread.id)
        .map(({ event }) => event)
        .filter(
          (event): event is Extract<DomainEvent, { type: 'turn.started' }> =>
            event.type === 'turn.started',
        )
      expect(starts.map(({ turn }) => [turn.id, turn.createdAt])).toEqual([
        ['first', 1_000],
        ['queued', 7_000],
        ['design', 11_000],
      ])
    } finally {
      now.mockRestore()
      await orchestrator.disposeAll()
      rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it('does not reuse failed or disposed turn anchors', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { orchestrator, sessions, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    const session = sessions[0]!
    try {
      session.sendError = new Error('provider rejected the turn')
      await expect(orchestrator.sendTurn(thread.id, 'Fails')).rejects.toThrow('provider rejected')

      session.sendError = undefined
      session.turnIds.push('after-failure', 'before-error', 'before-dispose')
      now.mockReturnValue(2_000)
      await orchestrator.sendTurn(thread.id, 'Retry')
      now.mockReturnValue(5_000)
      session.emit({
        type: 'turn.started',
        turn: { id: 'after-failure', threadId: thread.id, status: 'running', createdAt: 5_000 },
      })

      now.mockReturnValue(6_000)
      await orchestrator.sendTurn(thread.id, 'Errors')
      session.emit({ type: 'thread.error', threadId: thread.id, message: 'provider failed' })
      now.mockReturnValue(7_000)
      session.emit({
        type: 'turn.started',
        turn: { id: 'before-error', threadId: thread.id, status: 'running', createdAt: 7_000 },
      })

      now.mockReturnValue(8_000)
      await orchestrator.sendTurn(thread.id, 'Dispose')
      await orchestrator.disposeAll()
      now.mockReturnValue(9_000)
      session.emit({
        type: 'turn.started',
        turn: { id: 'before-dispose', threadId: thread.id, status: 'running', createdAt: 9_000 },
      })

      const starts = store
        .history(thread.id)
        .map(({ event }) => event)
        .filter(
          (event): event is Extract<DomainEvent, { type: 'turn.started' }> =>
            event.type === 'turn.started',
        )
      // A disposed session may not create a new history entry or timing anchor.
      expect(starts.map(({ turn }) => turn.createdAt)).toEqual([2_000, 7_000])
    } finally {
      now.mockRestore()
      await orchestrator.disposeAll()
    }
  })

  it('starts the turn of a prompt that waited for its chat to resume at the send', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { orchestrator, sessions, store } = harness()
    store.addProject('/repo')
    store.addThread({
      id: 'persisted-thread',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Persisted',
    })
    try {
      const sending = orchestrator.submitTurn('persisted-thread', 'first', [], {}, 'first')
      // The resume took 15 s.
      now.mockReturnValue(16_000)
      const sent = await sending
      if (sent.queued) throw new Error('expected a turn')
      sessions[0]!.emit({
        type: 'turn.started',
        turn: {
          id: sent.turnId,
          threadId: 'persisted-thread',
          status: 'running',
          createdAt: 16_000,
        },
      })
      sessions[0]!.emit({ type: 'turn.completed', turnId: sent.turnId, status: 'completed' })

      // The chat is attached now: the next prompt starts when it starts.
      now.mockReturnValue(20_000)
      const next = await orchestrator.submitTurn('persisted-thread', 'second', [], {}, 'second')
      if (next.queued) throw new Error('expected a turn')
      now.mockReturnValue(21_000)
      sessions[0]!.emit({
        type: 'turn.started',
        turn: {
          id: next.turnId,
          threadId: 'persisted-thread',
          status: 'running',
          createdAt: 21_000,
        },
      })

      const starts = store
        .history('persisted-thread')
        .map(({ event }) => event)
        .filter(
          (event): event is Extract<DomainEvent, { type: 'turn.started' }> =>
            event.type === 'turn.started',
        )
      expect(starts.map(({ turn }) => turn.createdAt)).toEqual([1_000, 20_000])
    } finally {
      now.mockRestore()
      await orchestrator.disposeAll()
      store.close()
    }
  })
})

describe('history replay', () => {
  it('pages the compact replay and restarts when a restore removes the cursor turn', async () => {
    const { orchestrator, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    const starts: number[] = []
    for (let index = 0; index < 4; index += 1) {
      const turnId = `turn-${index}`
      const reply = {
        id: `reply-${index}`,
        turnId,
        type: 'message' as const,
        role: 'assistant' as const,
        status: 'started' as const,
        text: '',
        createdAt: index,
      }
      starts.push(
        store.append(thread.id, {
          type: 'turn.started',
          turn: { id: turnId, threadId: thread.id, status: 'running', createdAt: index },
        }),
      )
      store.append(thread.id, { type: 'item.started', item: reply })
      store.append(thread.id, { type: 'item.delta', turnId, itemId: reply.id, textDelta: 'Hi' })
      store.append(thread.id, {
        type: 'item.completed',
        item: { ...reply, status: 'completed', text: 'Hi' },
      })
      store.append(thread.id, { type: 'turn.completed', turnId, status: 'completed' })
    }
    const turnIds = (events: Array<{ event: DomainEvent }>) =>
      events.flatMap(({ event }) => (event.type === 'turn.started' ? [event.turn.id] : []))

    const newest = await orchestrator.historyPage(thread.id, { turnLimit: 2 })
    expect(turnIds(newest.events)).toEqual(['turn-2', 'turn-3'])
    expect(newest.events.some(({ event }) => event.type === 'item.delta')).toBe(false)
    expect(newest.page.snapshotSeq).toBe(store.lastSeq(thread.id))

    const older = await orchestrator.historyPage(thread.id, {
      before: newest.page.olderCursor!,
      turnLimit: 2,
    })
    expect(turnIds(older.events)).toEqual(['turn-0', 'turn-1'])
    expect(older.page.olderCursor).toBeNull()

    store.saveRestoreUndo(thread.id, starts[2]! - 1, 'commit')
    const restarted = await orchestrator.historyPage(thread.id, {
      before: newest.page.olderCursor!,
      turnLimit: 2,
    })
    expect(restarted.reset).toBe(true)
    expect(turnIds(restarted.events)).toEqual(['turn-0', 'turn-1'])
    await expect(orchestrator.historyPage(thread.id, { before: 'not-a-cursor' })).rejects.toThrow(
      'invalid history cursor',
    )

    await orchestrator.disposeAll()
  })

  describe('older history pages', () => {
    function appendTurn(store: Store, threadId: string, index: number, done = true): void {
      const turnId = `turn-${index}`
      const reply = {
        id: `reply-${index}`,
        turnId,
        type: 'message' as const,
        role: 'assistant' as const,
        status: 'started' as const,
        text: '',
        createdAt: index,
      }
      store.append(threadId, {
        type: 'turn.started',
        turn: { id: turnId, threadId, status: 'running', createdAt: index },
      })
      store.append(threadId, { type: 'item.started', item: reply })
      store.append(threadId, { type: 'item.delta', turnId, itemId: reply.id, textDelta: 'Hel' })
      if (!done) return
      store.append(threadId, {
        type: 'item.completed',
        item: { ...reply, status: 'completed', text: 'Hello' },
      })
      store.append(threadId, { type: 'turn.completed', turnId, status: 'completed' })
    }
    const turnIds = (events: Array<{ event: DomainEvent }>) =>
      events.flatMap(({ event }) => (event.type === 'turn.started' ? [event.turn.id] : []))

    it('fails an older page of a chat deleted after its cursor was issued', async () => {
      const { orchestrator, store } = harness()
      const thread = await orchestrator.startThread('codex', '/repo')
      for (let index = 0; index < 4; index += 1) appendTurn(store, thread.id, index)
      const newest = await orchestrator.historyPage(thread.id, { turnLimit: 2 })
      store.deleteThread(thread.id)
      const save = vi.spyOn(store, 'saveReplaySnapshot')

      await expect(
        orchestrator.historyPage(thread.id, { before: newest.page.olderCursor!, turnLimit: 2 }),
      ).rejects.toThrow('Thread not found')
      expect(save).not.toHaveBeenCalled()
      await orchestrator.disposeAll()
    })

    it('serves older pages from the issuing replay without rewriting it while a turn streams', async () => {
      const { orchestrator, store } = harness()
      const thread = await orchestrator.startThread('codex', '/repo')
      for (let index = 0; index < 4; index += 1) appendTurn(store, thread.id, index)
      const newest = await orchestrator.historyPage(thread.id, { turnLimit: 2 })
      appendTurn(store, thread.id, 4, false)
      store.append(thread.id, {
        type: 'item.delta',
        turnId: 'turn-4',
        itemId: 'reply-4',
        textDelta: 'lo',
      })

      const save = vi.spyOn(store, 'saveReplaySnapshot')
      const history = vi.spyOn(store, 'history')
      const older = await orchestrator.historyPage(thread.id, {
        before: newest.page.olderCursor!,
        turnLimit: 2,
      })
      expect(turnIds(older.events)).toEqual(['turn-0', 'turn-1'])
      expect(older.reset).toBeUndefined()
      expect(save).not.toHaveBeenCalled()
      expect(history).not.toHaveBeenCalled()
      await orchestrator.disposeAll()
    })

    it('restarts from the current replay when the issuing replay lacks the cursor turn', async () => {
      const { orchestrator, store } = harness()
      const thread = await orchestrator.startThread('codex', '/repo')
      for (let index = 0; index < 4; index += 1) appendTurn(store, thread.id, index)
      const newest = await orchestrator.historyPage(thread.id, { turnLimit: 2 })
      appendTurn(store, thread.id, 4)
      const unknown = encodeHistoryCursor(thread.id, {
        seq: newest.page.snapshotSeq,
        turnHash: 'no-such-turn',
      })

      const restarted = await orchestrator.historyPage(thread.id, { before: unknown, turnLimit: 2 })
      expect(restarted.reset).toBe(true)
      expect(turnIds(restarted.events)).toEqual(['turn-3', 'turn-4'])
      expect(restarted.page.snapshotSeq).toBe(store.lastSeq(thread.id))
      await orchestrator.disposeAll()
    })

    it('opens a long thread from the end of its event log', async () => {
      const { orchestrator, store } = harness()
      const thread = await orchestrator.startThread('codex', '/repo')
      for (let index = 0; index < 150; index += 1) appendTurn(store, thread.id, index)
      const history = vi.spyOn(store, 'history')
      const save = vi.spyOn(store, 'saveReplaySnapshot')

      const newest = await orchestrator.historyPage(thread.id, { turnLimit: 10 })
      expect(history).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
      history.mockRestore()
      expect(newest).toEqual(
        readHistoryPage(thread.id, compactHistoryReplay(store.history(thread.id)), {
          turnLimit: 10,
        }),
      )

      const older = await orchestrator.historyPage(thread.id, {
        before: newest.page.olderCursor!,
        turnLimit: 20,
      })
      expect(older.reset).toBeUndefined()
      expect(turnIds(older.events)).toEqual(
        Array.from({ length: 20 }, (_, index) => `turn-${120 + index}`),
      )
      await orchestrator.disposeAll()
    })

    it('indexes a thread another build wrote to on its next full read', async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-history-index-'))
      const database = path.join(directory, 'state.db')
      try {
        const first = new Store(database)
        const { orchestrator: writer } = harness(undefined, first)
        const thread = await writer.startThread('codex', '/repo')
        for (let index = 0; index < 150; index += 1) appendTurn(first, thread.id, index)
        await writer.disposeAll()
        first.close()
        const raw = new DatabaseSync(database)
        raw.prepare(`INSERT INTO events (thread_id, at, payload) VALUES (?, ?, ?)`).run(
          thread.id,
          0,
          JSON.stringify({
            type: 'turn.started',
            turn: { id: 'elsewhere', threadId: thread.id, status: 'running', createdAt: 0 },
          }),
        )
        raw.close()

        const store = new Store(database)
        const { orchestrator } = harness(undefined, store)
        expect(store.historyIndexed(thread.id)).toBe(false)
        const history = vi.spyOn(store, 'history')
        await orchestrator.historyPage(thread.id, { turnLimit: 10 })
        expect(history).toHaveBeenCalledTimes(1)
        expect(store.historyIndexed(thread.id)).toBe(true)

        appendTurn(store, thread.id, 150)
        history.mockClear()
        const newest = await orchestrator.historyPage(thread.id, { turnLimit: 10 })
        expect(history).not.toHaveBeenCalled()
        expect(turnIds(newest.events).at(-1)).toBe('turn-150')
        await orchestrator.disposeAll()
        store.close()
      } finally {
        rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    })

    it('keeps a replay that read past an unreadable newest row for warm opens', async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-unreadable-tail-'))
      const database = path.join(directory, 'state.db')
      const store = new Store(database)
      try {
        const { orchestrator } = harness(undefined, store)
        const thread = await orchestrator.startThread('codex', '/repo')
        for (let index = 0; index < 3; index += 1) appendTurn(store, thread.id, index)
        const readable = store.lastSeq(thread.id)
        // A row a newer build wrote: stored, counted, but skipped by history.
        const raw = new DatabaseSync(database)
        raw
          .prepare(`INSERT INTO events (thread_id, at, payload) VALUES (?, ?, ?)`)
          .run(thread.id, 4, 'not json at all')
        raw.close()
        expect(store.lastSeq(thread.id)).toBeGreaterThan(readable)

        const save = vi.spyOn(store, 'saveReplaySnapshot')
        const opened = await orchestrator.history(thread.id)
        const newest = await orchestrator.historyPage(thread.id, { turnLimit: 2 })
        expect(await orchestrator.history(thread.id)).toEqual(opened)
        expect(save).toHaveBeenCalledTimes(1)
        expect(newest.page.snapshotSeq).toBe(readable)
        expect(turnIds(newest.events)).toEqual(['turn-1', 'turn-2'])
        await orchestrator.disposeAll()
      } finally {
        store.close()
        rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    })

    it('restarts older pages when imported turns arrive after the cursor', async () => {
      const { orchestrator, store } = harness()
      const thread = await orchestrator.startThread('codex', '/repo')
      for (let index = 1; index < 5; index += 1) appendTurn(store, thread.id, index)
      const newest = await orchestrator.historyPage(thread.id, { turnLimit: 2 })
      store.mergeProviderHistory(thread.id, 'revision', [
        {
          key: 'old-start',
          event: {
            type: 'turn.started',
            turn: { id: 'import:old', threadId: thread.id, status: 'running', createdAt: 0 },
          },
        },
        {
          key: 'old-end',
          event: { type: 'turn.completed', turnId: 'import:old', status: 'completed' },
        },
      ])

      const older = await orchestrator.historyPage(thread.id, {
        before: newest.page.olderCursor!,
        turnLimit: 2,
      })
      expect(older.reset).toBe(true)
      expect(turnIds(older.events)).toEqual(['turn-3', 'turn-4'])
      await orchestrator.disposeAll()
    })

    describe('a newest page that is the whole replay', () => {
      /** Imported history, a tool call compacted from its deltas, and a restored-away turn. */
      function appendMixedHistory(store: Store, threadId: string): void {
        store.mergeProviderHistory(threadId, 'revision', [
          {
            key: 'import-start',
            event: {
              type: 'turn.started',
              turn: { id: 'import:old', threadId, status: 'running', createdAt: 0 },
            },
          },
          {
            key: 'import-tool',
            event: {
              type: 'item.completed',
              item: {
                id: 'import:tool',
                turnId: 'import:old',
                type: 'tool_call',
                status: 'completed',
                text: 'Read {"file_path":"README.md"}',
                createdAt: 0,
              },
            },
          },
          {
            key: 'import-end',
            event: { type: 'turn.completed', turnId: 'import:old', status: 'completed' },
          },
        ])
        appendTurn(store, threadId, 1)
        const command = {
          id: 'command',
          turnId: 'tool-turn',
          type: 'command' as const,
          status: 'started' as const,
          command: 'git status',
          text: '',
          createdAt: 2,
        }
        store.append(threadId, {
          type: 'turn.started',
          turn: { id: 'tool-turn', threadId, status: 'running', createdAt: 2 },
        })
        store.append(threadId, { type: 'item.started', item: command })
        store.append(threadId, {
          type: 'item.delta',
          turnId: 'tool-turn',
          itemId: 'command',
          textDelta: 'On branch "dev" ✓\n',
        })
        store.append(threadId, {
          type: 'item.completed',
          item: { ...command, status: 'completed', text: 'On branch "dev" ✓\n', exitCode: 0 },
        })
        store.append(threadId, { type: 'turn.completed', turnId: 'tool-turn', status: 'completed' })
        const kept = store.lastSeq(threadId)
        appendTurn(store, threadId, 3)
        store.saveRestoreUndo(threadId, kept, 'commit')
      }

      it('answers with the JSON of the replay it just compacted, identical to encoding the page', async () => {
        const { orchestrator, store } = harness()
        const thread = await orchestrator.startThread('codex', '/repo')
        appendMixedHistory(store, thread.id)
        const expected = readHistoryPage(
          thread.id,
          compactHistoryReplay(store.history(thread.id)),
          {
            turnLimit: 10,
          },
        )

        const page = await orchestrator.historyPage(thread.id, { turnLimit: 10 })

        expect(page.events).toEqual(expected.events)
        expect(page.page).toEqual(expected.page)
        expect(turnIds(page.events)).toEqual(['import:old', 'turn-1', 'tool-turn'])
        expect(page.events.some(({ event }) => event.type === 'item.delta')).toBe(false)
        // The text saved for the replay, reused for the page.
        expect(page.serializedEvents).toBe(JSON.stringify(page.events))
        await orchestrator.disposeAll()
      })

      /** What a reply holds as its events: the page's JSON if it has one, else the page encoded. */
      const wireEvents = (page: { events: unknown; serializedEvents?: string | undefined }) =>
        page.serializedEvents ?? JSON.stringify(page.events)
      /** The saved row as the store validates it, encoded: what dev sends after a restart. */
      const validated = (payload: string) =>
        JSON.stringify(
          z
            .array(z.object({ seq: z.number(), event: DomainEventSchema }))
            .parse(JSON.parse(payload)),
        )

      /**
       * Opens the whole newest page, closes the file-backed store, lets `edit`
       * change the saved replay row, restarts and opens the page twice.
       */
      async function wholePageAfterRestart(
        append: (store: Store, threadId: string) => void,
        edit: (payload: string) => string = (payload) => payload,
      ) {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-whole-page-'))
        const database = path.join(directory, 'state.db')
        try {
          const first = new Store(database)
          const opened = harness(undefined, first)
          const thread = await opened.orchestrator.startThread('codex', '/repo')
          append(first, thread.id)
          const before = await opened.orchestrator.historyPage(thread.id, { turnLimit: 10 })
          await opened.orchestrator.disposeAll()
          first.close()

          const raw = new DatabaseSync(database)
          const row = raw
            .prepare(`SELECT payload FROM thread_replay_snapshots WHERE thread_id = ?`)
            .get(thread.id) as { payload: string }
          const saved = edit(row.payload)
          raw
            .prepare(`UPDATE thread_replay_snapshots SET payload = ? WHERE thread_id = ?`)
            .run(saved, thread.id)
          raw.close()

          const store = new Store(database)
          const { orchestrator } = harness(undefined, store)
          const history = vi.spyOn(store, 'history')
          const page = await orchestrator.historyPage(thread.id, { turnLimit: 10 })
          const again = await orchestrator.historyPage(thread.id, { turnLimit: 10 })
          // Served from the saved replay, not rebuilt from the log.
          expect(history).not.toHaveBeenCalled()
          await orchestrator.disposeAll()
          store.close()
          return { before, saved, page, again }
        } finally {
          rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        }
      }

      it('answers after a restart with the saved replay encoded as validated, not its text', async () => {
        const { before, saved, page, again } = await wholePageAfterRestart(appendMixedHistory)
        // The first open in a run reuses the JSON it just encoded.
        expect(before.serializedEvents).toBe(JSON.stringify(before.events))
        expect(page.events).toEqual(before.events)
        expect(page.page).toEqual(before.page)
        expect(page.serializedEvents).toBeUndefined()
        expect(wireEvents(page)).toBe(validated(saved))
        expect(wireEvents(again)).toBe(validated(saved))
      })

      it('leaves out a field an older build saved, and keeps the saved order out of the reply', async () => {
        const { before, saved, page, again } = await wholePageAfterRestart(
          appendMixedHistory,
          (payload) => {
            const entries = JSON.parse(payload) as {
              seq: number
              event: { item?: Record<string, unknown> }
            }[]
            const tool = entries.find(({ event }) => event.item?.['id'] === 'import:tool')!
            tool.event.item!['legacyMarker'] = 'x'.repeat(64)
            // Another entry with its keys in another order.
            const last = entries.length - 1
            entries[last] = { event: entries[last]!.event, seq: entries[last]!.seq }
            return JSON.stringify(entries)
          },
        )
        expect(saved).toContain('legacyMarker')
        expect(validated(saved)).not.toBe(saved)
        expect(page.events).toEqual(before.events)
        expect(wireEvents(page)).toBe(validated(saved))
        expect(wireEvents(page)).not.toContain('legacyMarker')
        expect(wireEvents(again)).toBe(wireEvents(page))
      })

      it('encodes a restarted command that began without text in the order the contract reads it', async () => {
        const { before, saved, page, again } = await wholePageAfterRestart((store, threadId) => {
          const command = {
            id: 'command',
            turnId: 'stopped',
            type: 'command' as const,
            status: 'started' as const,
            command: 'pnpm test',
            createdAt: 2,
          }
          store.append(threadId, {
            type: 'turn.started',
            turn: { id: 'stopped', threadId, status: 'running', createdAt: 2 },
          })
          store.append(threadId, { type: 'item.started', item: command })
          store.append(threadId, {
            type: 'item.delta',
            turnId: 'stopped',
            itemId: 'command',
            textDelta: 'RUN v4\n',
          })
          store.append(threadId, {
            type: 'turn.completed',
            turnId: 'stopped',
            status: 'interrupted',
          })
        })
        expect(before.serializedEvents).toBe(JSON.stringify(before.events))
        // The replay was saved with the text after createdAt; read back, text comes first.
        expect(saved).toBe(before.serializedEvents)
        expect(validated(saved)).not.toBe(saved)
        expect(page.events).toEqual(before.events)
        expect(wireEvents(page)).toBe(validated(saved))
        expect(wireEvents(again)).toBe(validated(saved))
      })

      it('encodes a page that leaves older turns out as before', async () => {
        const { orchestrator, store } = harness()
        const thread = await orchestrator.startThread('codex', '/repo')
        appendMixedHistory(store, thread.id)

        const page = await orchestrator.historyPage(thread.id, { turnLimit: 2 })
        expect(turnIds(page.events)).toEqual(['turn-1', 'tool-turn'])
        expect(page.serializedEvents).toBeUndefined()
        const older = await orchestrator.historyPage(thread.id, {
          before: page.page.olderCursor!,
          turnLimit: 2,
        })
        expect(turnIds(older.events)).toEqual(['import:old'])
        expect(older.serializedEvents).toBeUndefined()
        await orchestrator.disposeAll()
      })
    })

    it('restarts after a truncation until newer events follow the kept cursor turn', async () => {
      const { orchestrator, store } = harness()
      const thread = await orchestrator.startThread('codex', '/repo')
      for (let index = 0; index < 3; index += 1) appendTurn(store, thread.id, index)
      const kept = store.lastSeq(thread.id)
      appendTurn(store, thread.id, 3)
      const newest = await orchestrator.historyPage(thread.id, { turnLimit: 2 })
      const before = newest.page.olderCursor!

      // turn-2, the cursor's turn, survives; the replay now ends before the cursor.
      store.saveRestoreUndo(thread.id, kept, 'commit')
      const truncated = await orchestrator.historyPage(thread.id, { before, turnLimit: 2 })
      expect(truncated.reset).toBe(true)
      expect(turnIds(truncated.events)).toEqual(['turn-1', 'turn-2'])

      appendTurn(store, thread.id, 5)
      const continued = await orchestrator.historyPage(thread.id, { before, turnLimit: 2 })
      expect(continued.reset).toBeUndefined()
      expect(turnIds(continued.events)).toEqual(['turn-0', 'turn-1'])
      await orchestrator.disposeAll()
    })

    it('opens a running turn from the newest page plus the catch-up after its snapshot', async () => {
      const { orchestrator, store } = harness()
      const thread = await orchestrator.startThread('codex', '/repo')
      for (let index = 0; index < 3; index += 1) appendTurn(store, thread.id, index)
      appendTurn(store, thread.id, 3, false)
      const newest = await orchestrator.historyPage(thread.id, { turnLimit: 1 })
      store.append(thread.id, {
        type: 'item.delta',
        turnId: 'turn-3',
        itemId: 'reply-3',
        textDelta: 'lo',
      })

      const catchUp = await orchestrator.history(thread.id, newest.page.snapshotSeq)
      const opened = reduceEventLog(
        reduceEventLog(emptyThread, newest.events),
        catchUp,
        newest.page.snapshotSeq,
      )
      const full = reduceEventLog(emptyThread, await orchestrator.history(thread.id))
      expect(catchUp).toHaveLength(1)
      expect(opened.items).toEqual(full.items.slice(-opened.items.length))
      expect(opened.items.at(-1)).toMatchObject({ id: 'reply-3', text: 'Hello' })
      await orchestrator.disposeAll()
    })
  })

  it('hands fresh compact replay JSON to the response path once', async () => {
    const { orchestrator, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    store.append(thread.id, message('Ready.', 'turn-1'))

    const first = await orchestrator.historyForResponse(thread.id)
    expect(first.serializedEvents).toBe(JSON.stringify(first.events))

    const second = await orchestrator.historyForResponse(thread.id)
    expect(second.events).toBe(first.events)
    expect(second.serializedEvents).toBeUndefined()

    await orchestrator.disposeAll()
  })

  it('compacts a fresh replay without changing a reconnect tail', async () => {
    const { orchestrator, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    const reply = {
      id: 'reply',
      turnId: 'turn-1',
      type: 'message' as const,
      role: 'assistant' as const,
      status: 'started' as const,
      text: '',
      createdAt: 1,
    }
    const itemSeq = store.append(thread.id, { type: 'item.started', item: reply })
    store.append(thread.id, {
      type: 'item.delta',
      turnId: 'turn-1',
      itemId: reply.id,
      textDelta: 'Hello ',
    })
    store.append(thread.id, {
      type: 'item.delta',
      turnId: 'turn-1',
      itemId: reply.id,
      textDelta: 'world',
    })
    const snapshotSeq = store.append(thread.id, {
      type: 'item.completed',
      item: { ...reply, status: 'completed' },
    })

    expect(await orchestrator.history(thread.id, itemSeq)).toEqual(
      store.history(thread.id, itemSeq),
    )
    const compacted = [
      {
        seq: snapshotSeq,
        event: {
          type: 'item.completed',
          item: { ...reply, status: 'completed', text: 'Hello world' },
        },
      },
    ]
    expect(await orchestrator.history(thread.id)).toEqual(compacted)

    const history = vi.spyOn(store, 'history')
    expect(await orchestrator.history(thread.id)).toEqual(compacted)
    expect(history).not.toHaveBeenCalled()

    store.append(thread.id, { type: 'plan.updated', turnId: 'turn-1', steps: [] })
    expect(await orchestrator.history(thread.id)).toHaveLength(2)
    expect(history).toHaveBeenCalledWith(thread.id, snapshotSeq)

    await orchestrator.disposeAll()
  })

  it('extends a running compact replay with only its newly completed tail', async () => {
    const { orchestrator, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    const reply = {
      id: 'reply',
      turnId: 'turn-1',
      type: 'message' as const,
      role: 'assistant' as const,
      status: 'started' as const,
      text: '',
      createdAt: 1,
    }
    store.append(thread.id, { type: 'item.started', item: reply })
    const snapshotSeq = store.append(thread.id, {
      type: 'item.delta',
      turnId: reply.turnId,
      itemId: reply.id,
      textDelta: 'Hello',
    })

    expect(await orchestrator.history(thread.id)).toEqual([
      {
        seq: snapshotSeq,
        event: { type: 'item.started', item: { ...reply, text: 'Hello' } },
      },
    ])

    store.append(thread.id, {
      type: 'item.delta',
      turnId: reply.turnId,
      itemId: reply.id,
      textDelta: ' world',
    })
    const completedSeq = store.append(thread.id, {
      type: 'item.completed',
      item: { ...reply, status: 'completed' },
    })
    const history = vi.spyOn(store, 'history')

    expect(await orchestrator.history(thread.id)).toEqual([
      {
        seq: completedSeq,
        event: {
          type: 'item.completed',
          item: { ...reply, status: 'completed', text: 'Hello world' },
        },
      },
    ])
    expect(history).toHaveBeenCalledWith(thread.id, snapshotSeq)

    await orchestrator.disposeAll()
  })
})

describe('turn diff recording', () => {
  it('records each changed turn patch and skips unchanged repeats', async () => {
    const { orchestrator, sessions, store, received } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    sessions[0]!.emit(turnStarted(thread.id, 'turn-1'))
    for (const diff of ['patch-a', 'patch-a', 'patch-b', 'patch-b', 'patch-a']) {
      sessions[0]!.emit({ type: 'diff.updated', turnId: 'turn-1', diff })
    }
    sessions[0]!.emit(turnStarted(thread.id, 'turn-2'))
    sessions[0]!.emit({ type: 'diff.updated', turnId: 'turn-2', diff: 'patch-a' })
    sessions[0]!.emit({ type: 'turn.completed', turnId: 'turn-2', status: 'completed' })
    sessions[0]!.emit({ type: 'diff.updated', turnId: 'turn-2', diff: 'patch-a' })

    const diffs = (events: DomainEvent[]) =>
      events.flatMap((event) =>
        event.type === 'diff.updated' ? [`${event.turnId}:${event.diff}`] : [],
      )
    const recorded = [
      'turn-1:patch-a',
      'turn-1:patch-b',
      'turn-1:patch-a',
      'turn-2:patch-a',
      'turn-2:patch-a',
    ]
    expect(diffs(store.history(thread.id).map(({ event }) => event))).toEqual(recorded)
    expect(diffs(received.map(({ event }) => event))).toEqual(recorded)
    expect(store.turnDiff(thread.id, 'turn-1')).toBe('patch-a')
  })
})

describe('streamed delta batching', () => {
  it('persists concurrent threads in one shared ordered transaction', async () => {
    vi.useFakeTimers()
    const { orchestrator, sessions, store, received } = harness()
    const appendBatch = vi.spyOn(store, 'appendBatchWithSerializedEvents')
    try {
      const first = await orchestrator.startThread('codex', '/repo')
      const second = await orchestrator.startThread('codex', '/repo')
      const firstReply = {
        id: 'reply-first',
        turnId: 'turn-first',
        type: 'message' as const,
        role: 'assistant' as const,
        status: 'started' as const,
        text: '',
        createdAt: 1,
      }
      const secondReply = {
        ...firstReply,
        id: 'reply-second',
        turnId: 'turn-second',
      }

      sessions[0]?.emit({ type: 'item.started', item: firstReply })
      sessions[1]?.emit({ type: 'item.started', item: secondReply })
      sessions[0]?.emit({
        type: 'item.delta',
        turnId: firstReply.turnId,
        itemId: firstReply.id,
        textDelta: 'A',
      })
      sessions[1]?.emit({
        type: 'item.delta',
        turnId: secondReply.turnId,
        itemId: secondReply.id,
        textDelta: 'B',
      })
      sessions[0]?.emit({
        type: 'item.delta',
        turnId: firstReply.turnId,
        itemId: firstReply.id,
        textDelta: 'C',
      })

      vi.advanceTimersByTime(4)

      const firstDelta = store.history(first.id).at(-1)!
      const secondDelta = store.history(second.id).at(-1)!
      expect(appendBatch).toHaveBeenCalledOnce()
      expect(firstDelta).toEqual({
        seq: expect.any(Number),
        event: {
          type: 'item.delta',
          turnId: firstReply.turnId,
          itemId: firstReply.id,
          textDelta: 'AC',
        },
      })
      expect(secondDelta).toEqual({
        seq: firstDelta.seq + 1,
        event: {
          type: 'item.delta',
          turnId: secondReply.turnId,
          itemId: secondReply.id,
          textDelta: 'B',
        },
      })
      expect(
        received
          .filter(({ event }) => event.type === 'item.delta')
          .map(({ threadId, seq }) => [threadId, seq]),
      ).toEqual([
        [first.id, firstDelta.seq],
        [second.id, secondDelta.seq],
      ])
      expect(
        received
          .filter(({ event }) => event.type === 'item.delta')
          .map(({ event, serializedEvent }) => serializedEvent === JSON.stringify(event)),
      ).toEqual([true, true])
    } finally {
      await orchestrator.disposeAll()
      vi.useRealTimers()
    }
  })

  it('persists and broadcasts adjacent text in one ordered event', async () => {
    const { orchestrator, sessions, store, received } = harness()
    try {
      const thread = await orchestrator.startThread('codex', '/repo')
      const reply = {
        id: 'reply-batched',
        turnId: 'turn-batched',
        type: 'message' as const,
        role: 'assistant' as const,
        status: 'started' as const,
        text: '',
        createdAt: 1,
      }

      sessions[0]?.emit({ type: 'item.started', item: reply })
      sessions[0]?.emit({
        type: 'item.delta',
        turnId: reply.turnId,
        itemId: reply.id,
        textDelta: 'Hello ',
      })
      sessions[0]?.emit({
        type: 'item.delta',
        turnId: reply.turnId,
        itemId: reply.id,
        textDelta: 'world',
      })

      expect(store.history(thread.id).map(({ event }) => event.type)).toEqual(['item.started'])
      sessions[0]?.emit({
        type: 'item.completed',
        item: { ...reply, status: 'completed', text: 'Hello world' },
      })

      expect(store.history(thread.id).map(({ event }) => event)).toEqual([
        { type: 'item.started', item: reply },
        {
          type: 'item.delta',
          turnId: reply.turnId,
          itemId: reply.id,
          textDelta: 'Hello world',
        },
        {
          type: 'item.completed',
          item: { ...reply, status: 'completed', text: 'Hello world' },
        },
      ])
      expect(received.map(({ event }) => event)).toEqual(
        store.history(thread.id).map(({ event }) => event),
      )
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('flushes pending text into a reconnect history snapshot', async () => {
    const { orchestrator, sessions, store } = harness()
    try {
      const thread = await orchestrator.startThread('codex', '/repo')
      const itemSeq = store.append(thread.id, {
        type: 'item.started',
        item: {
          id: 'reply-reconnect',
          turnId: 'turn-reconnect',
          type: 'message',
          role: 'assistant',
          status: 'started',
          text: '',
          createdAt: 1,
        },
      })
      sessions[0]?.emit({
        type: 'item.delta',
        turnId: 'turn-reconnect',
        itemId: 'reply-reconnect',
        textDelta: 'visible on reconnect',
      })

      expect(await orchestrator.history(thread.id, itemSeq)).toEqual([
        {
          seq: itemSeq + 1,
          event: {
            type: 'item.delta',
            turnId: 'turn-reconnect',
            itemId: 'reply-reconnect',
            textDelta: 'visible on reconnect',
          },
        },
      ])
    } finally {
      await orchestrator.disposeAll()
    }
  })
})

describe('durable user submissions', () => {
  it.each([
    ['codex', true],
    ['claude-code', false],
    ['grok', false],
    ['api', false],
  ] as const)('owns exact repeated user messages for %s', async (provider, emitsUserEcho) => {
    const { orchestrator, sessions, store } = harness()
    try {
      const thread = await orchestrator.startThread(provider, '/repo')
      const session = sessions[0]!
      for (const [turnId, submissionId] of [
        ['turn-a', 'submission-a'],
        ['turn-b', 'submission-b'],
      ] as const) {
        session.turnIds.push(turnId)
        await orchestrator.submitTurn(thread.id, 'Repeat this.', [], {}, submissionId)
        expect(store.hasUserSubmission(thread.id, submissionId)).toBe(true)
        session.emit(turnStarted(thread.id, turnId))
        if (emitsUserEcho) {
          session.emit(userMessage(`provider-${submissionId}`, 'Repeat this.', turnId, 'started'))
          session.emit({
            type: 'item.delta',
            turnId,
            itemId: `provider-${submissionId}`,
            textDelta: 'Repeat this.',
          })
          session.emit(userMessage(`provider-${submissionId}`, 'Repeat this.', turnId))
        }
        session.emit({ type: 'turn.completed', turnId, status: 'completed' })
      }
      const users = store
        .history(thread.id)
        .map(({ event }) => event)
        .filter(
          (event): event is Extract<DomainEvent, { type: 'item.completed' }> =>
            event.type === 'item.completed' &&
            event.item.type === 'message' &&
            event.item.role === 'user',
        )
      expect(users.map(({ item }) => [item.id, item.text])).toEqual([
        ['submission-a', 'Repeat this.'],
        ['submission-b', 'Repeat this.'],
      ])
      expect(store.history(thread.id).some(({ event }) => event.type === 'item.delta')).toBe(false)
    } finally {
      await orchestrator.disposeAll()
    }
  })
  it('persists the exact user item before an accepted request returns', async () => {
    const { orchestrator, sessions, store } = harness()
    let release = () => {}
    let submitting = Promise.resolve<unknown>(undefined)
    try {
      const thread = await orchestrator.startThread('api', '/repo')
      const session = sessions[0]!
      session.turnIds.push('turn-in-flight')
      session.eventDuringSend = turnStarted(thread.id, 'turn-in-flight')
      session.afterEventBarrier = new Promise<void>((resolve) => (release = resolve))
      submitting = orchestrator.submitTurn(thread.id, 'Accepted.', [], {}, 'submission-in-flight')
      await vi.waitFor(() =>
        expect(store.hasUserSubmission(thread.id, 'submission-in-flight')).toBe(true),
      )
      expect(store.history(thread.id).map(({ event }) => event.type)).toEqual([
        'turn.started',
        'item.completed',
      ])
    } finally {
      release()
      await submitting.catch(() => undefined)
      await orchestrator.disposeAll()
    }
  })
  it('preserves submission identity through queue drain and steer', async () => {
    const { orchestrator, sessions, store } = harness()
    let releaseSteer = () => {}
    let steering: Promise<void> | undefined
    try {
      const thread = await orchestrator.startThread('codex', '/repo')
      const session = sessions[0]!
      session.turnIds.push('turn-current', 'turn-queued', 'turn-steered')
      await orchestrator.submitTurn(
        thread.id,
        'Repeat this.',
        ['/current.png'],
        {},
        'submission-current',
      )
      session.emit(turnStarted(thread.id, 'turn-current'))
      const queued = await orchestrator.submitTurn(
        thread.id,
        'Repeat this.',
        ['/queued.png'],
        {},
        'submission-queued',
      )
      const steered = await orchestrator.submitTurn(
        thread.id,
        'Repeat this.',
        ['/steered.png'],
        {},
        'submission-steered',
      )
      if (!queued.queued || !steered.queued) throw new Error('expected queued submissions')
      session.steerBarriers.push(new Promise<void>((resolve) => (releaseSteer = resolve)))
      steering = orchestrator.steerQueuedTurn(thread.id, steered.queuedTurn.id)
      await vi.waitFor(() => expect(orchestrator.queue(thread.id).items).toHaveLength(1))
      await expect(
        orchestrator.submitTurn(thread.id, 'Repeat this.', [], {}, 'submission-steered'),
      ).rejects.toThrow(/clientSubmissionId.*already used/)
      await expect(orchestrator.steerQueuedTurn(thread.id, queued.queuedTurn.id)).rejects.toThrow(
        /already being steered/,
      )
      session.emit({ type: 'turn.completed', turnId: 'turn-current', status: 'completed' })
      expect(session.sent).toEqual(['Repeat this.'])
      releaseSteer()
      await steering
      await vi.waitFor(() => expect(session.sent).toEqual(['Repeat this.', 'Repeat this.']))
      session.emit(turnStarted(thread.id, 'turn-queued'))
      session.emit({ type: 'turn.completed', turnId: 'turn-queued', status: 'completed' })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(session.sent).toHaveLength(2)
      const users = store
        .history(thread.id)
        .map(({ event }) => event)
        .filter(
          (event): event is Extract<DomainEvent, { type: 'item.completed' }> =>
            event.type === 'item.completed' && event.item.role === 'user',
        )
      expect(users.map(({ item }) => [item.id, item.turnId, item.attachments])).toEqual([
        ['submission-current', 'turn-current', ['/current.png']],
        ['submission-steered', 'turn-current', ['/steered.png']],
        ['submission-queued', 'turn-queued', ['/queued.png']],
      ])
    } finally {
      releaseSteer()
      await steering?.catch(() => undefined)
      await orchestrator.disposeAll()
    }
  })
  it('releases rejected identities but rejects a durable reuse', async () => {
    const { orchestrator, sessions } = harness()
    try {
      const thread = await orchestrator.startThread('api', '/repo')
      const session = sessions[0]!
      session.sendError = new Error('provider rejected')
      await expect(
        orchestrator.submitTurn(thread.id, 'Try this.', [], {}, 'submission-retry'),
      ).rejects.toThrow('provider rejected')
      session.sendError = undefined
      session.turnIds.push('turn-retry')
      await orchestrator.submitTurn(thread.id, 'Try this.', [], {}, 'submission-retry')
      session.emit(turnStarted(thread.id, 'turn-retry'))
      session.emit({ type: 'turn.completed', turnId: 'turn-retry', status: 'completed' })
      await expect(
        orchestrator.submitTurn(thread.id, 'Try this.', [], {}, 'submission-retry'),
      ).rejects.toThrow(/clientSubmissionId.*already used/)
    } finally {
      await orchestrator.disposeAll()
    }
  })
})

describe('prompts of the removed Design mode', () => {
  it('sends a prompt that carries the old Design marker as an ordinary turn', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-old-design-marker-'))
    const { orchestrator, sessions, store } = harness()
    try {
      const thread = await orchestrator.startThread('codex', workspace)
      await orchestrator.sendTurn(thread.id, 'Build a site.', [DESIGN_BRIEF_ATTACHMENT])

      expect(sessions[0]!.sent).toEqual(['Build a site.'])
      expect(sessions[0]!.sentAttachments).toEqual([[]])
      expect(store.designRun(thread.id)).toBeUndefined()
    } finally {
      await orchestrator.disposeAll()
      rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    }
  })

  it('sends "continue" as the word itself in a chat with a suspended Design run', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-old-design-continue-'))
    const store = new Store(':memory:')
    store.addProject(workspace)
    store.addThread({ id: 'old-design', projectPath: workspace, provider: 'codex', title: 'Site' })
    const saved = {
      originalRequest: 'Build a site.',
      phase: 'brief',
      suspended: true,
      askedQuestions: false,
      explicitAnswers: [],
    }
    store.setDesignRun('old-design', saved)
    const { orchestrator, sessions } = harness(undefined, store)
    try {
      await orchestrator.submitTurn('old-design', 'continue', [DESIGN_BRIEF_ATTACHMENT])

      expect(sessions[0]!.sent).toEqual(['continue'])
      expect(sessions[0]!.sentAttachments).toEqual([[]])
      // The saved row stays as it was; nothing reads it any more.
      expect(store.designRun('old-design')).toEqual(saved)
    } finally {
      await orchestrator.disposeAll()
      store.close()
      rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    }
  })

  it('resumes a chat whose Design run was active at shutdown as an ordinary chat', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-old-design-restart-'))
    const store = new Store(':memory:')
    store.addProject(workspace)
    store.addThread({ id: 'old-run', projectPath: workspace, provider: 'codex', title: 'Site' })
    const saved = {
      originalRequest: 'Build a site.',
      phase: 'brief',
      askedQuestions: false,
      explicitAnswers: [],
    }
    store.setDesignRun('old-run', saved)
    const { orchestrator, sessions } = harness(undefined, store)
    try {
      const sent = await orchestrator.submitTurn('old-run', 'Make the header calmer.')

      // No phase turn goes out first, and the prompt does not wait behind one.
      expect(sent.queued).toBe(false)
      expect(sessions[0]!.sent).toEqual(['Make the header calmer.'])
      expect(store.designRun('old-run')).toEqual(saved)
    } finally {
      await orchestrator.disposeAll()
      store.close()
      rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    }
  })
})

describe('persisted threads', () => {
  it('resumes a stored Codex thread once and preserves concurrent prompt order', async () => {
    const store = new Store(':memory:')
    const worktreePath = mkdtempSync(path.join(os.tmpdir(), 'harness-resume-'))
    store.addProject('/repo')
    store.addThread({
      id: 'persisted-thread',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Persisted',
      worktreePath,
      worktreeBranch: 'harness/persisted',
    })
    const { orchestrator, sessions, resumedIds, resumedIn } = harness(undefined, store)

    try {
      expect(orchestrator.queue('persisted-thread')).toEqual({ items: [], canSteer: false })
      const first = orchestrator.submitTurn('persisted-thread', 'first')
      const second = orchestrator.submitTurn('persisted-thread', 'second')

      await expect(first).resolves.toMatchObject({ queued: false })
      await expect(second).resolves.toMatchObject({ queued: true })
      expect(resumedIds).toEqual(['persisted-thread'])
      expect(resumedIn).toEqual([worktreePath])
      expect(sessions[0]?.sent).toEqual(['first'])
      expect(orchestrator.queue('persisted-thread').items.map((item) => item.text)).toEqual([
        'second',
      ])

      sessions[0]?.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
      await vi.waitFor(() => expect(sessions[0]?.sent).toEqual(['first', 'second']))
    } finally {
      await orchestrator.disposeAll()
      store.close()
      rmSync(worktreePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it('restores the shared reply instructions when resuming a Codex thread', async () => {
    const store = new Store(':memory:')
    store.addProject('/repo')
    store.addThread({
      id: 'persisted-thread',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Persisted',
    })
    const { orchestrator, resumedOptions } = harness(undefined, store)

    await orchestrator.submitTurn('persisted-thread', 'continue')

    expect(resumedOptions[0]?.instructions).toContain('clear, capable teammate')
    expect(resumedOptions[0]?.instructions).toContain('Do not use em dashes')
    expect(resumedOptions[0]?.instructions).toContain(
      'When a task is done, end the turn with a short wrap-up',
    )
  })

  it('resumes a persisted thread with the model options of the turn that wakes it', async () => {
    const store = new Store(':memory:')
    store.addProject('/repo')
    store.addThread({
      id: 'persisted-thread',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Persisted',
    })
    const { orchestrator, resumedOptions, sessions } = harness(undefined, store)
    const options = { model: 'model-a', effort: 'high', serviceTier: 'fast' } as const

    await orchestrator.submitTurn('persisted-thread', 'continue', [], options)

    // A runtime opened without them restarts its CLI as soon as the turn applies them.
    expect(resumedOptions[0]).toMatchObject(options)
    expect(sessions[0]?.sentOptions).toEqual([options])
  })

  it('persists and resumes Grok native identity across store and orchestrator recreation', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-grok-restart-'))
    const database = path.join(directory, 'harness.db')
    let threadId = ''
    try {
      const firstStore = new Store(database)
      const first = harness(undefined, firstStore)
      const thread = await first.orchestrator.startThread('grok', '/repo')
      threadId = thread.id

      first.sessions[0]!.emitProviderSessionId('grok-native-session')
      expect(firstStore.thread(threadId)).toMatchObject({
        id: threadId,
        providerSessionId: 'grok-native-session',
      })
      await first.orchestrator.disposeAll()
      firstStore.close()

      const restartedStore = new Store(database)
      const restarted = harness(undefined, restartedStore)
      try {
        await restarted.orchestrator.submitTurn(threadId, 'Continue after restart.')

        expect(restarted.resumedIds).toEqual([threadId])
        expect(restarted.resumedOptions[0]?.providerSessionId).toBe('grok-native-session')
        expect(restarted.sessions[0]?.sent).toEqual(['Continue after restart.'])

        restarted.sessions[0]!.emitProviderSessionId('grok-native-session-rotated')
        expect(restartedStore.thread(threadId)).toMatchObject({
          id: threadId,
          providerSessionId: 'grok-native-session-rotated',
        })
      } finally {
        await restarted.orchestrator.disposeAll()
        restartedStore.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it('keeps Grok history readable when restart happened before a native id was learned', async () => {
    const store = new Store(':memory:')
    store.addProject('/repo')
    store.addThread({
      id: 'grok-without-native-id',
      projectPath: '/repo',
      provider: 'grok',
      title: 'T',
    })
    store.append('grok-without-native-id', message('Earlier Grok answer.'))
    const orchestrator = new Orchestrator(store, {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
      runtimeFor: (provider, onLog) => providerRuntime(provider, onLog),
    })
    try {
      await expect(orchestrator.submitTurn('grok-without-native-id', 'Continue.')).rejects.toThrow(
        'Start a new Grok chat; the local history of this chat is still available.',
      )
      expect(store.history('grok-without-native-id')).toHaveLength(1)
    } finally {
      await orchestrator.disposeAll()
      store.close()
    }
  })

  it('does not invent continuity for a provider without resume support', async () => {
    const store = new Store(':memory:')
    store.addProject('/repo')
    store.addThread({
      id: 'claude-thread',
      projectPath: '/repo',
      provider: 'claude-code',
      title: 'Persisted Claude',
    })
    const { orchestrator } = harness(undefined, store)

    await expect(orchestrator.submitTurn('claude-thread', 'continue')).rejects.toThrow(
      'claude-code sessions cannot resume after TasteCode restarts yet',
    )
  })
})

describe('MCP inventory', () => {
  it('reloads every matching session and waits for all results after a failure', async () => {
    const { orchestrator, sessions, store } = harness()
    try {
      await orchestrator.startThread('codex', '/repo')
      await orchestrator.startThread('codex', '/repo')
      await orchestrator.startThread('codex', '/other')
      const failure = new Error('first session reload failed')
      sessions[0]!.mcpReloadError = failure
      let release: () => void = () => {}
      sessions[1]!.mcpReloadBarrier = new Promise<void>((resolve) => (release = resolve))
      let settled = false
      const reload = orchestrator.reloadMcpServers('codex', '/repo')
      const rejected = expect(reload).rejects.toBe(failure)
      void reload.then(
        () => (settled = true),
        () => (settled = true),
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(sessions.map((session) => session.mcpReloads.length)).toEqual([1, 1, 0])
      expect(settled).toBe(false)
      release()
      await rejected
    } finally {
      await orchestrator.disposeAll()
      store.close()
    }
  })

  describe('without a live reload', () => {
    const docs: McpServerConfig = {
      id: 'docs',
      enabled: true,
      transport: { type: 'stdio', command: 'docs-server' },
    }
    // Codex keeps a loaded thread's MCP layers, so its session offers no reload.
    const withoutReload = (session: FakeSession) =>
      Object.assign(session, { reloadMcpServers: undefined })

    it('resumes an idle chat with the changed servers', async () => {
      const { orchestrator, sessions, store, resumedOptions } = harness()
      try {
        const thread = await orchestrator.startThread('codex', '/repo')
        withoutReload(sessions[0]!)
        sessions[0]!.emit({ type: 'turn.completed', turnId: 'turn-0', status: 'completed' })
        orchestrator.addMcpServer('codex', '/repo', docs)

        await orchestrator.reloadMcpServers('codex', '/repo')

        expect(sessions[0]!.disposed).toBe(true)
        expect(orchestrator.isRunning(thread.id)).toBe(false)
        await orchestrator.submitTurn(thread.id, 'use the docs server')
        expect(resumedOptions[0]).toMatchObject({ mcpServers: [docs] })
        expect(sessions[1]!.sent).toEqual(['use the docs server'])
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('replaces a working chat, including one on its first turn, after the turn ends', async () => {
      const { orchestrator, sessions, store } = harness()
      try {
        const thread = await orchestrator.startThread('codex', '/repo')
        withoutReload(sessions[0]!)
        sessions[0]!.emit(turnStarted(thread.id, 'turn-1'))

        await orchestrator.reloadMcpServers('codex', '/repo')
        expect(sessions[0]!.disposed).toBe(false)
        expect(orchestrator.isTurnRunning(thread.id)).toBe(true)

        sessions[0]!.emit({ type: 'turn.completed', turnId: 'turn-1', status: 'completed' })
        expect(sessions[0]!.disposed).toBe(true)
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('does not release a runtime that replaced the stale one', async () => {
      const { orchestrator, sessions, store } = harness()
      try {
        const thread = await orchestrator.startThread('codex', '/repo')
        withoutReload(sessions[0]!)
        sessions[0]!.emit(turnStarted(thread.id, 'turn-1'))
        await orchestrator.reloadMcpServers('codex', '/repo')
        sessions[0]!.emitDisconnected()
        await orchestrator.submitTurn(thread.id, 'continue')

        sessions[1]!.emit({ type: 'turn.completed', turnId: 'turn-2', status: 'completed' })
        expect(sessions[1]!.disposed).toBe(false)
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('accepts the next save once no chat is running', async () => {
      const { orchestrator, sessions, store } = harness()
      try {
        await orchestrator.startThread('codex', '/repo')
        withoutReload(sessions[0]!)
        sessions[0]!.emit({ type: 'turn.completed', turnId: 'turn-0', status: 'completed' })
        await orchestrator.reloadMcpServers('codex', '/repo')
        expect(sessions[0]!.disposed).toBe(true)

        await expect(orchestrator.reloadMcpServers('codex', '/repo')).resolves.toBeUndefined()
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('signs in through a chat that already has the saved servers', async () => {
      const { orchestrator, sessions, store } = harness()
      try {
        const working = await orchestrator.startThread('codex', '/repo')
        withoutReload(sessions[0]!)
        sessions[0]!.emit(turnStarted(working.id, 'turn-1'))
        await orchestrator.reloadMcpServers('codex', '/repo')
        await orchestrator.startThread('codex', '/repo')

        await orchestrator.startMcpOAuth('codex', '/repo', 'docs')

        expect(sessions[0]!.mcpOAuthStarts).toEqual([])
        expect(sessions[1]!.mcpOAuthStarts).toEqual([expect.objectContaining({ serverId: 'docs' })])
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('says that a Temporary chat keeps its servers', async () => {
      const { orchestrator, sessions, store } = harness()
      try {
        const parent = await orchestrator.startThread('codex', '/repo')
        store.append(parent.id, userMessage('parent-prompt', 'Open a side chat.', 'parent-turn'))
        await orchestrator.startSideThread(parent.id)
        sessions.forEach(withoutReload)
        sessions[0]!.emit({ type: 'turn.completed', turnId: 'turn-0', status: 'completed' })

        await expect(orchestrator.reloadMcpServers('codex', '/repo')).rejects.toThrow(
          'Temporary chats keep the MCP servers they started with',
        )
        expect(sessions[0]!.disposed).toBe(true)
        expect(sessions[1]!.disposed).toBe(false)
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })
  })

  it('forwards live session MCP changes and ignores closed or deleted sessions', async () => {
    const { orchestrator, sessions, store, mcpChanges } = harness()
    try {
      const first = await orchestrator.startThread('codex', '/repo')
      const second = await orchestrator.startThread('codex', '/other')
      sessions[0]!.emitMcpChanged()
      expect(mcpChanges).toEqual([{ provider: 'codex', projectPath: '/repo' }])

      await orchestrator.close(first.id)
      sessions[0]!.emitMcpChanged()
      store.deleteThread(second.id)
      sessions[1]!.emitMcpChanged()
      expect(mcpChanges).toHaveLength(1)
    } finally {
      await orchestrator.disposeAll()
      store.close()
    }
  })

  it('validates Claude project MCP settings before saving additions or edits', async () => {
    const { orchestrator, sessions } = harness()
    const safe: McpServerConfig = {
      id: 'docs',
      enabled: true,
      transport: { type: 'http', url: 'https://example.com/mcp' },
    }
    try {
      expect(() =>
        orchestrator.addMcpServer('claude-code', '/repo', { id: 'hidden', enabled: false }),
      ).toThrow('cannot hide an inherited MCP server')
      expect(() =>
        orchestrator.addMcpServer('claude-code', '/repo', {
          id: 'custom',
          enabled: true,
          transport: { type: 'stdio', command: 'node', args: [], cwd: '/another-project' },
        }),
      ).toThrow('custom working directory')
      expect((await orchestrator.listMcpServers('claude-code', '/repo')).servers).toEqual([])
      orchestrator.addMcpServer('claude-code', '/repo', safe)
      const saved = await orchestrator.listMcpServers('claude-code', '/repo')
      expect(saved.servers.map(({ id }) => id)).toEqual(['docs'])
      expect(() =>
        orchestrator.updateMcpServer('claude-code', '/repo', { id: 'docs', enabled: false }),
      ).toThrow('cannot hide an inherited MCP server')
      expect((await orchestrator.listMcpServers('claude-code', '/repo')).servers).toEqual(
        saved.servers,
      )
      expect(sessions).toEqual([])
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('refuses Grok MCP settings that its ACP launch cannot honor', async () => {
    const { orchestrator, sessions } = harness()
    try {
      expect(() =>
        orchestrator.addMcpServer('grok', '/repo', {
          id: 'custom',
          enabled: true,
          transport: { type: 'stdio', command: 'node', args: [], cwd: '/work/tools' },
        }),
      ).toThrow('custom working directory')
      expect(() =>
        orchestrator.addMcpServer('grok', '/repo', { id: 'hidden', enabled: false }),
      ).toThrow('cannot be hidden through ACP')
      expect((await orchestrator.listMcpServers('grok', '/repo')).servers).toEqual([])
      expect(sessions).toEqual([])
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it("reads Claude's servers for a project without a chat from a cached probe", async () => {
    const inherited: McpServer = {
      id: 'plugin:acme-docs:acme-docs',
      displayName: 'acme-docs',
      description: 'Plugin acme-docs',
      scope: 'global',
      enabled: true,
      auth: { status: 'not_required' },
      startup: { state: 'ready' },
      tools: [],
      resources: [],
      resourceTemplates: [],
    }
    let finish: (() => void) | undefined
    const discover = vi.fn(
      () =>
        new Promise<{ commands: ProviderCommand[]; servers: McpServer[] }>((resolve) => {
          finish = () =>
            resolve({
              commands: [{ name: 'context', description: 'Show context' }],
              servers: [inherited],
            })
        }),
    )
    const { orchestrator, sessions, mcpChanges, commandChanges } = harness(
      undefined,
      undefined,
      undefined,
      undefined,
      {
        'claude-code': {
          projectInventory: { mcpCapabilities: CLAUDE_MCP_CAPABILITIES, discover },
        },
      },
    )
    try {
      orchestrator.addMcpServer('claude-code', '/repo', {
        id: 'docs',
        enabled: true,
        transport: { type: 'http', url: 'https://example.com/mcp' },
      })
      await expect(orchestrator.listMcpServers('claude-code', '/repo')).resolves.toMatchObject({
        capabilities: { inventory: true, add: true, hideInherited: false },
        servers: [{ id: 'docs', scope: 'project' }],
        loading: true,
      })
      await expect(orchestrator.listCommands('claude-code', '/repo')).resolves.toEqual({
        commands: [],
        loading: true,
      })
      await vi.waitFor(() => expect(finish).toBeDefined())
      finish!()
      await vi.waitFor(() =>
        expect(mcpChanges).toEqual([{ provider: 'claude-code', projectPath: '/repo' }]),
      )
      expect(commandChanges).toEqual([{ provider: 'claude-code', projectPath: '/repo' }])

      const settled = await orchestrator.listMcpServers('claude-code', '/repo')
      expect(settled.loading).toBeUndefined()
      expect(settled.servers.map(({ id, scope }) => [id, scope])).toEqual([
        ['plugin:acme-docs:acme-docs', 'global'],
        ['docs', 'project'],
      ])
      await expect(orchestrator.listCommands('claude-code', '/repo')).resolves.toEqual({
        commands: [{ name: 'context', description: 'Show context' }],
        loading: false,
      })
      // One probe served every read, and no chat was started for it.
      expect(discover).toHaveBeenCalledOnce()
      expect(sessions).toEqual([])
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it("reads Claude's servers from a live chat in the project", async () => {
    const { orchestrator, sessions } = harness()
    await orchestrator.startThread('claude-code', '/repo')
    sessions[0]!.mcpServers = [
      {
        id: 'plugin:acme-docs:acme-docs',
        displayName: 'acme-docs',
        description: 'Plugin acme-docs',
        scope: 'global',
        enabled: true,
        auth: { status: 'not_required' },
        startup: { state: 'starting' },
        tools: [],
        resources: [],
        resourceTemplates: [],
      },
    ]
    sessions[0]!.mcpLoading = true

    await expect(orchestrator.listMcpServers('claude-code', '/repo')).resolves.toEqual({
      capabilities: {
        inventory: true,
        add: true,
        update: true,
        remove: true,
        reload: false,
        startOAuth: false,
        cancelOAuth: false,
        hideInherited: false,
      },
      servers: sessions[0]!.mcpServers,
      loading: true,
    })
    // Another project has no Claude chat, so a probe starts for it.
    await expect(orchestrator.listMcpServers('claude-code', '/other')).resolves.toMatchObject({
      capabilities: { inventory: true },
      servers: [],
      loading: true,
    })
    await orchestrator.disposeAll()
  })

  it('reads live startup state from the project session', async () => {
    const { orchestrator, sessions } = harness()
    await orchestrator.startThread('codex', '/repo')
    sessions[0]!.mcpServers = [
      {
        id: 'docs',
        scope: 'global',
        enabled: true,
        auth: { status: 'not_required' },
        startup: { state: 'failed', message: 'program not found' },
        tools: [],
        resources: [],
        resourceTemplates: [],
      },
    ]

    await expect(orchestrator.listMcpServers('codex', '/repo')).resolves.toMatchObject({
      capabilities: { inventory: true },
      servers: [{ id: 'docs', startup: { state: 'failed' } }],
    })
    expect((await orchestrator.listMcpServers('codex', '/repo')).loading).toBeUndefined()
    sessions[0]!.mcpLoading = true
    await expect(orchestrator.listMcpServers('codex', '/repo')).resolves.toMatchObject({
      loading: true,
    })
  })

  it('routes live MCP operations to the exact active project runtime', async () => {
    const { orchestrator, sessions } = harness()
    await orchestrator.startThread('codex', '/other')
    const target = await orchestrator.startThread('codex', '/repo')
    sessions[0]!.mcpServers = [
      {
        id: 'other-server',
        scope: 'global',
        enabled: true,
        auth: { status: 'not_required' },
        startup: { state: 'ready' },
        tools: [],
        resources: [],
        resourceTemplates: [],
      },
    ]
    sessions[1]!.mcpServers = [
      {
        id: 'target-server',
        scope: 'global',
        enabled: true,
        auth: { status: 'not_required' },
        startup: { state: 'ready' },
        tools: [],
        resources: [],
        resourceTemplates: [],
      },
    ]

    await expect(orchestrator.listMcpServers('codex', '/repo')).resolves.toMatchObject({
      servers: [{ id: 'target-server' }],
    })
    await orchestrator.reloadMcpServers('codex', '/repo')
    await expect(orchestrator.startMcpOAuth('codex', '/repo', 'target-server')).resolves.toEqual({
      loginId: 'login-target-server',
      authUrl: 'https://example.com/target-server',
    })

    expect(sessions[0]!.mcpReloads).toEqual([])
    expect(sessions[0]!.mcpOAuthStarts).toEqual([])
    expect(sessions[1]!.mcpReloads).toEqual([{ threadId: target.id, servers: [], credentials: {} }])
    expect(sessions[1]!.mcpOAuthStarts).toEqual([
      { serverId: 'target-server', threadId: target.id },
    ])
    sessions[1]!.emitMcpOAuth({
      serverId: 'target-server',
      loginId: 'login-target-server',
      success: true,
      error: null,
    })
    await orchestrator.disposeAll()
  })

  it('removes an evicted runtime from the project MCP index', async () => {
    const { orchestrator, sessions } = harness(undefined, new Store(':memory:'), 1)
    const older = await orchestrator.startThread('codex', '/repo')
    const recent = await orchestrator.startThread('codex', '/repo')
    sessions[0]!.mcpServers = [
      {
        id: 'stale-server',
        scope: 'global',
        enabled: true,
        auth: { status: 'not_required' },
        startup: { state: 'ready' },
        tools: [],
        resources: [],
        resourceTemplates: [],
      },
    ]
    sessions[1]!.mcpServers = [
      {
        id: 'live-server',
        scope: 'global',
        enabled: true,
        auth: { status: 'not_required' },
        startup: { state: 'ready' },
        tools: [],
        resources: [],
        resourceTemplates: [],
      },
    ]

    sessions[0]!.emit({ type: 'turn.completed', turnId: 'older-turn', status: 'completed' })
    sessions[1]!.emit({ type: 'turn.completed', turnId: 'recent-turn', status: 'completed' })

    expect(sessions[0]!.disposed).toBe(true)
    expect(orchestrator.isRunning(older.id)).toBe(false)
    expect(orchestrator.isRunning(recent.id)).toBe(true)
    await expect(orchestrator.listMcpServers('codex', '/repo')).resolves.toMatchObject({
      servers: [{ id: 'live-server' }],
    })
    await orchestrator.reloadMcpServers('codex', '/repo')
    expect(sessions[0]!.mcpReloads).toEqual([])
    expect(sessions[1]!.mcpReloads).toEqual([{ threadId: recent.id, servers: [], credentials: {} }])
    await orchestrator.disposeAll()
  })

  it('applies project overrides and resolves only their credential references', async () => {
    const { orchestrator, startedOptions } = harness()
    orchestrator.addMcpServer('codex', '/repo', {
      id: 'docs',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: { source: 'credential', credentialRef: 'mcp/docs/auth' } },
      },
    })

    await orchestrator.startThread('codex', '/repo')

    expect(startedOptions[0]).toMatchObject({
      mcpServers: [{ id: 'docs', enabled: true }],
      mcpCredentials: { 'mcp/docs/auth': 'secret:mcp/docs/auth' },
    })
    await expect(orchestrator.listMcpServers('codex', '/repo')).resolves.toMatchObject({
      capabilities: { add: true, reload: true, startOAuth: true, cancelOAuth: false },
      servers: [{ id: 'docs', scope: 'project', enabled: true }],
    })
  })

  it('manages Grok project servers and passes them into new sessions', async () => {
    const { orchestrator, startedOptions } = harness()
    orchestrator.addMcpServer('grok', '/repo', {
      id: 'test-tools',
      enabled: true,
      displayName: 'Test tools',
      transport: { type: 'stdio', command: 'node', args: ['test-mcp.js'] },
    })

    // Grok's own servers come from its project probe; inherited ones cannot be hidden.
    await expect(orchestrator.listMcpServers('grok', '/repo')).resolves.toMatchObject({
      capabilities: {
        inventory: true,
        add: true,
        update: true,
        remove: true,
        reload: false,
        hideInherited: false,
      },
      servers: [
        {
          id: 'test-tools',
          displayName: 'Test tools',
          scope: 'project',
          enabled: true,
        },
      ],
    })

    await orchestrator.startThread('grok', '/repo')
    expect(startedOptions[0]).toMatchObject({
      mcpServers: [{ id: 'test-tools', enabled: true }],
    })
  })

  it('passes a service inventory and its loading state through with project overrides', async () => {
    const listMcpServers = vi.fn(async () => ({
      capabilities: {
        inventory: true,
        add: true,
        update: true,
        remove: true,
        reload: false,
        startOAuth: false,
        cancelOAuth: false,
        hideInherited: false,
      },
      servers: [],
      loading: true,
    }))
    const { orchestrator } = harness(undefined, undefined, undefined, undefined, {
      'claude-code': { listMcpServers },
    })
    orchestrator.addMcpServer('claude-code', '/repo', {
      id: 'docs',
      enabled: true,
      transport: { type: 'http', url: 'https://example.com/mcp' },
    })

    await expect(orchestrator.listMcpServers('claude-code', '/repo')).resolves.toMatchObject({
      capabilities: { inventory: true, hideInherited: false },
      servers: [{ id: 'docs', scope: 'project' }],
      loading: true,
    })
    expect(listMcpServers).toHaveBeenCalledWith('/repo', expect.anything())
  })
})

describe('provider commands', () => {
  const command = (name: string): ProviderCommand => ({ name, description: `${name} command` })

  it('answers from the chat, then the project, then the service, then nothing', async () => {
    const listCommands = vi.fn(
      async (
        _projectPath: string,
        read: { readActive?: (() => Promise<ProviderCommand[]>) | undefined },
      ) =>
        read.readActive
          ? { commands: await read.readActive(), loading: false }
          : { commands: [command('probe')], loading: true },
    )
    const { orchestrator, sessions } = harness(undefined, undefined, undefined, undefined, {
      'claude-code': { listCommands },
    })
    try {
      await expect(orchestrator.listCommands('claude-code', '/repo')).resolves.toEqual({
        commands: [command('probe')],
        loading: true,
      })
      const first = await orchestrator.startThread('claude-code', '/repo')
      const second = await orchestrator.startThread('claude-code', '/repo')
      const elsewhere = await orchestrator.startThread('claude-code', '/other')
      sessions[0]!.commands = [command('first')]
      sessions[1]!.commands = [command('second')]
      sessions[2]!.commands = [command('elsewhere')]

      await expect(orchestrator.listCommands('claude-code', '/repo', second.id)).resolves.toEqual({
        commands: [command('second')],
        loading: false,
      })
      expect(sessions[1]!.commandReads).toEqual([second.id])
      // Another project's chat or an unknown chat falls back to this project's runtime.
      for (const threadId of [elsewhere.id, 'missing-thread', undefined]) {
        await expect(orchestrator.listCommands('claude-code', '/repo', threadId)).resolves.toEqual({
          commands: [command('first')],
          loading: false,
        })
      }
      expect(sessions[0]!.commandReads).toEqual([first.id, first.id, first.id])
      expect(sessions[2]!.commandReads).toEqual([])
      await expect(orchestrator.listCommands('claude-code', '/empty')).resolves.toEqual({
        commands: [command('probe')],
        loading: true,
      })

      // Without a service only a running chat can answer. ACP agents have none:
      // they report their commands only from a session.
      await expect(orchestrator.listCommands('acp', '/repo')).resolves.toEqual({
        commands: [],
        loading: false,
      })
      await orchestrator.startThread('acp', '/repo')
      sessions[3]!.commands = [command('acp')]
      await expect(orchestrator.listCommands('acp', '/repo')).resolves.toEqual({
        commands: [command('acp')],
        loading: false,
      })
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('relays command changes from live chats and from services', async () => {
    let changed: (() => void) | undefined
    const { orchestrator, sessions, commandChanges } = harness(
      undefined,
      undefined,
      undefined,
      undefined,
      {
        grok: {
          listCommands: async (_projectPath, read) => {
            changed = read.changed
            return { commands: [], loading: true }
          },
        },
      },
    )
    try {
      await orchestrator.startThread('claude-code', '/repo')
      sessions[0]!.emitCommandsChanged()
      await orchestrator.listCommands('grok', '/other')
      changed!()
      expect(commandChanges).toEqual([
        { provider: 'claude-code', projectPath: '/repo' },
        { provider: 'grok', projectPath: '/other' },
      ])
    } finally {
      await orchestrator.disposeAll()
    }
  })

  // Codex lists its commands from the adapter, Claude Code from the live session.
  it.each(['codex', 'claude-code'] as const)(
    'sends a listed %s command as typed in a Design project and wraps any other prompt',
    async (provider) => {
      const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-command-'))
      mkdirSync(path.join(workspace, '.taste'))
      writeFileSync(path.join(workspace, '.taste', 'brief.json'), '{}')
      const { orchestrator, sessions } = harness()
      try {
        const thread = await orchestrator.startThread(provider, workspace)
        const session = sessions[0]!
        session.commands = [command('compact')]
        for (const [turnId, text] of [
          ['compact', '/compact'],
          ['ordinary', 'Tighten the hero spacing.'],
          ['unlisted', '/foo bar'],
          ['shouted', '/COMPACT'],
        ] as const) {
          session.turnIds.push(turnId)
          await orchestrator.sendTurn(thread.id, text)
          session.emit(turnStarted(thread.id, turnId))
          session.emit({ type: 'turn.completed', turnId, status: 'completed' })
        }
        // Codex runs a command whatever its case; text around it would break it.
        expect(session.sent[3]).toBe('/COMPACT')
        // The provider runs the command only when the prompt is the command itself.
        expect(session.sent[0]).toBe('/compact')
        expect(session.sent[1]).toContain('Earlier phase-only JSON protocols no longer apply')
        expect(session.sent[1]!.endsWith('User request:\nTighten the hero spacing.')).toBe(true)
        expect(session.sent[2]).toContain('Earlier phase-only JSON protocols no longer apply')
        expect(session.sent[2]!.endsWith('User request:\n/foo bar')).toBe(true)
      } finally {
        await orchestrator.disposeAll()
        rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    },
  )
})

describe('skills inventory', () => {
  it('lists .agents skills only for providers whose CLI loads them', async () => {
    const vendorSkill = {
      id: 'grok:user:review',
      name: 'review',
      description: 'Review the change',
      source: { type: 'provider' as const },
      scope: 'user' as const,
      enabled: true,
      dependencyErrors: [],
    }
    const { orchestrator } = harness(undefined, undefined, undefined, undefined, {
      grok: {
        listSkills: async () => ({
          capabilities: { inventory: true, configure: false, install: false },
          skills: [vendorSkill],
          errors: [],
        }),
      },
    })
    const project = mkdtempSync(path.join(os.tmpdir(), 'harness-skills-project-'))
    const home = mkdtempSync(path.join(os.tmpdir(), 'harness-skills-home-'))
    const skillDir = path.join(home, '.agents', 'skills', 'animate')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: animate\ndescription: Build an animation from scratch\n---\n',
    )
    mkdirSync(path.join(project, '.agents', 'skills', 'local'), { recursive: true })
    writeFileSync(
      path.join(project, '.agents', 'skills', 'local', 'SKILL.md'),
      '---\nname: local\ndescription: A project skill\n---\n',
    )
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home)

    try {
      // Claude Code loads ~/.claude/skills, never .agents; its skills come with its commands.
      await expect(orchestrator.listSkills('claude-code', project)).resolves.toEqual({
        capabilities: { inventory: false, configure: false, install: false },
        skills: [],
        errors: [],
      })
      // OpenCode's own skills come from its project probe, also without .agents.
      await expect(orchestrator.listSkills('opencode', project)).resolves.toEqual({
        capabilities: { inventory: true, configure: false, install: false },
        skills: [],
        errors: [],
      })
      // A provider's own skill inventory comes without the .agents folders.
      await expect(orchestrator.listSkills('grok', project)).resolves.toEqual({
        capabilities: { inventory: true, configure: false, install: false },
        skills: [vendorSkill],
        errors: [],
      })
    } finally {
      homedir.mockRestore()
      await orchestrator.disposeAll()
      rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it('rejects installation for unsupported providers before touching the folder', async () => {
    const { orchestrator } = harness()

    await expect(
      orchestrator.installSkillFromFolder('claude-code', '/repo', '/selected-skill'),
    ).rejects.toThrow('provider "claude-code" cannot install skills yet')
  })
})

describe('several sessions at once', () => {
  it('gives each session its own agent rather than sharing one', async () => {
    const { sessions, orchestrator } = harness()

    await orchestrator.startThread('codex', '/repo')
    await orchestrator.startThread('codex', '/repo')

    // One adapter driving two threads would interleave two conversations into
    // one context, which is the failure this guards against.
    expect(sessions).toHaveLength(2)
    expect(sessions[0]).not.toBe(sessions[1])
  })

  it('does not let a turn in one session block another', async () => {
    const { sessions, orchestrator } = harness()

    const first = await orchestrator.startThread('codex', '/repo')
    const second = await orchestrator.startThread('codex', '/repo')

    // Hold the first turn open indefinitely.
    sessions[0]!.release = () => {}
    void orchestrator.sendTurn(first.id, 'slow one')

    // The second must still get through. A shared lock would hang here.
    await expect(orchestrator.sendTurn(second.id, 'quick one')).resolves.toBe('s2-turn')
  })

  it('delivers Stop after a turn waiting for its checkpoint becomes interruptible', async () => {
    const { sessions, orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    let releaseCheckpoint: (value: checkpoint.Snapshot) => void = () => undefined
    vi.spyOn(checkpoint, 'takeSnapshot').mockReturnValueOnce(
      new Promise<checkpoint.Snapshot>((resolve) => {
        releaseCheckpoint = resolve
      }),
    )

    const sending = orchestrator.submitTurn(thread.id, 'stop before the reply')
    await vi.waitFor(() => expect(orchestrator.isTurnRunning(thread.id)).toBe(true))
    const stopping = orchestrator.interrupt(thread.id)

    expect(sessions[0]!.interrupted).toBe(false)
    releaseCheckpoint({ commit: 'checkpoint', clean: true })
    await expect(sending).resolves.toMatchObject({ queued: false })
    await expect(stopping).resolves.toBeUndefined()
    await vi.waitFor(() => expect(sessions[0]!.interrupted).toBe(true))
  })

  it('delivers a Stop sent right behind its prompt after the turn started', async () => {
    // A new chat stopped while it starts sends the prompt and the Stop back to back. An agent
    // asked to stop before its turn exists has nothing to stop, and drops the request.
    const { sessions, orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    const session = sessions[0]!
    const promptsWhenStopped: number[] = []
    vi.spyOn(session, 'interrupt').mockImplementation(async () => {
      promptsWhenStopped.push(session.sent.length)
    })

    const sending = orchestrator.submitTurn(thread.id, 'stop me')
    const stopping = orchestrator.interrupt(thread.id)

    await expect(sending).resolves.toMatchObject({ queued: false })
    await expect(stopping).resolves.toBeUndefined()
    expect(promptsWhenStopped).toEqual([1])
  })

  it('holds a Stop for a prompt that is still being prepared', async () => {
    const { sessions, orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    const session = sessions[0]!
    const promptsWhenStopped: number[] = []
    vi.spyOn(session, 'interrupt').mockImplementation(async () => {
      promptsWhenStopped.push(session.sent.length)
    })
    let prepared!: () => void
    const preparing = new Promise<void>((resolve) => (prepared = resolve))

    // The server reads outside history before it hands the prompt over.
    const sending = orchestrator.trackSubmission(thread.id, async () => {
      await preparing
      return orchestrator.submitTurn(thread.id, 'stop me')
    })
    const stopping = orchestrator.interrupt(thread.id)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(promptsWhenStopped).toEqual([])

    prepared()
    await expect(sending).resolves.toMatchObject({ queued: false })
    await expect(stopping).resolves.toBeUndefined()
    expect(promptsWhenStopped).toEqual([1])
  })

  it('does not hold a Stop for a prompt sent after it', async () => {
    const { sessions, orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'running')
    let prepared!: () => void
    const preparing = new Promise<void>((resolve) => (prepared = resolve))

    const stopping = orchestrator.interrupt(thread.id)
    const later = orchestrator.trackSubmission(thread.id, async () => {
      await preparing
      return orchestrator.submitTurn(thread.id, 'later')
    })
    await expect(stopping).resolves.toBeUndefined()
    expect(sessions[0]!.interrupted).toBe(true)

    prepared()
    await expect(later).resolves.toMatchObject({ queued: true })
  })

  it('starts no queued prompt while a Stop waits for a prompt on its way', async () => {
    const { sessions, orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    const session = sessions[0]!
    session.turnIds = ['t1', 't2', 't3']
    await orchestrator.submitTurn(thread.id, 'running')
    await expect(orchestrator.submitTurn(thread.id, 'queued')).resolves.toMatchObject({
      queued: true,
    })
    let prepared!: () => void
    const preparing = new Promise<void>((resolve) => (prepared = resolve))
    const onItsWay = orchestrator.trackSubmission(thread.id, async () => {
      await preparing
      return orchestrator.submitTurn(thread.id, 'on its way')
    })

    const stopping = orchestrator.interrupt(thread.id)
    // The running turn ends by itself while the Stop waits for the prompt on its way.
    session.emit({ type: 'turn.completed', turnId: 't1', status: 'completed' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    prepared()
    await expect(onItsWay).resolves.toMatchObject({ queued: true })
    await expect(stopping).resolves.toBeUndefined()

    // Without the hold, "queued" started when the turn ended, and the Stop caught it.
    expect(session.sent).toEqual(['running'])
    expect(orchestrator.queue(thread.id).items.map((item) => item.text)).toEqual([
      'queued',
      'on its way',
    ])
  })

  describe('prompts queued before a Stop', () => {
    async function stoppedWithQueue() {
      const context = harness()
      const { sessions, orchestrator } = context
      const thread = await orchestrator.startThread('codex', '/repo')
      const session = sessions[0]!
      session.turnIds = ['t1', 't2', 't3']
      await orchestrator.submitTurn(thread.id, 'running')
      const queued = await orchestrator.submitTurn(thread.id, 'sent by accident')
      if (!queued.queued) throw new Error('expected the prompt to queue')
      await orchestrator.interrupt(thread.id)
      session.emit({ type: 'turn.completed', turnId: 't1', status: 'interrupted' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { ...context, thread, session, queuedId: queued.queuedTurn.id }
    }

    it('stay queued when the stopped turn ends', async () => {
      const { orchestrator, thread, session } = await stoppedWithQueue()

      expect(session.sent).toEqual(['running'])
      expect(orchestrator.queue(thread.id).items.map((item) => item.text)).toEqual([
        'sent by accident',
      ])
      expect(orchestrator.isTurnRunning(thread.id)).toBe(false)
      await orchestrator.disposeAll()
    })

    it('go out in order once the user sends again', async () => {
      const { orchestrator, thread, session } = await stoppedWithQueue()

      await expect(orchestrator.submitTurn(thread.id, 'next')).resolves.toMatchObject({
        queued: true,
      })
      await vi.waitFor(() => expect(session.sent).toEqual(['running', 'sent by accident']))
      session.emit({ type: 'turn.completed', turnId: 't2', status: 'completed' })
      await vi.waitFor(() => expect(session.sent).toEqual(['running', 'sent by accident', 'next']))
      await orchestrator.disposeAll()
    })

    it('go out one at a time when the user sends a held one', async () => {
      const { orchestrator, thread, session, queuedId } = await stoppedWithQueue()

      await orchestrator.steerQueuedTurn(thread.id, queuedId)

      expect(session.sent).toEqual(['running', 'sent by accident'])
      expect(session.steered).toEqual([])
      expect(orchestrator.queue(thread.id).items).toEqual([])
      await orchestrator.disposeAll()
    })

    it('go out in the access mode the user changed while the old session stops', async () => {
      const { orchestrator, thread, session, queuedId, sessions, resumedOptions } =
        await stoppedWithQueue()
      // An agent that takes a new access mode only by starting again.
      Object.defineProperty(session, 'setApproval', { value: undefined })
      let release: () => void = () => {}
      session.disposeBarrier = new Promise<void>((resolve) => (release = resolve))
      try {
        const changing = orchestrator.setThreadApproval(thread.id, 'ask')
        await vi.waitFor(() => expect(session.disposed).toBe(true))
        const steering = orchestrator.steerQueuedTurn(thread.id, queuedId)
        release()
        await expect(changing).resolves.toBeUndefined()
        await steering
        expect(resumedOptions.at(-1)?.approval).toBe('ask')
        await vi.waitFor(() => expect(sessions.at(-1)!.sent).toEqual(['sent by accident']))
      } finally {
        release()
        await orchestrator.disposeAll()
      }
    })

    // Stop all also clears every queue.
    it.each([
      ['a Stop', 'turn cancelled while resuming', ['sent by accident']],
      ['Stop all', 'turn cancelled by panic stop or shutdown', []],
    ] as const)(
      'do not go out when %s comes while the one the user picks waits for an access mode change',
      async (stop, message, left) => {
        const { orchestrator, thread, session, queuedId, sessions, resumeBarriers, resumedIds } =
          await stoppedWithQueue()
        // An agent that takes a new access mode only by starting again.
        Object.defineProperty(session, 'setApproval', { value: undefined })
        let release: () => void = () => {}
        session.disposeBarrier = new Promise<void>((resolve) => (release = resolve))
        let open: () => void = () => {}
        resumeBarriers.push(new Promise<void>((resolve) => (open = resolve)))
        try {
          const changing = orchestrator.setThreadApproval(thread.id, 'ask')
          await vi.waitFor(() => expect(session.disposed).toBe(true))
          const steering = orchestrator.steerQueuedTurn(thread.id, queuedId)
          release()
          // The change's own resume is under way when the Stop comes.
          await vi.waitFor(() => expect(resumedIds).toHaveLength(1))
          const stopping =
            stop === 'a Stop'
              ? orchestrator.interrupt(thread.id)
              : orchestrator.panicStop().then(() => undefined)
          open()
          await stopping
          await changing.catch(() => undefined)
          await expect(steering).rejects.toThrow(message)
          await new Promise((resolve) => setTimeout(resolve, 20))
          expect(resumedIds).toHaveLength(1)
          expect(sessions.every((each) => !each.sent.includes('sent by accident'))).toBe(true)
          expect(orchestrator.queue(thread.id).items.map((item) => item.text)).toEqual(left)
        } finally {
          release()
          open()
          await orchestrator.disposeAll()
        }
      },
    )

    it('send the one the user picks first once the agent has ended the stopped turn', async () => {
      const { sessions, orchestrator } = harness()
      const thread = await orchestrator.startThread('codex', '/repo')
      const session = sessions[0]!
      session.turnIds = ['t1', 't2', 't3']
      await orchestrator.submitTurn(thread.id, 'running')
      await orchestrator.submitTurn(thread.id, 'first queued')
      const picked = await orchestrator.submitTurn(thread.id, 'picked')
      if (!picked.queued) throw new Error('expected the prompt to queue')
      let confirm!: () => void
      session.interruptBarrier = new Promise<void>((resolve) => (confirm = resolve))
      const stopping = orchestrator.interrupt(thread.id)
      await vi.waitFor(() => expect(session.interrupted).toBe(true))

      // The agent has not ended the stopped turn yet, so nothing can go out now.
      await orchestrator.steerQueuedTurn(thread.id, picked.queuedTurn.id)
      expect(session.sent).toEqual(['running'])

      confirm()
      await stopping
      session.emit({ type: 'turn.completed', turnId: 't1', status: 'interrupted' })
      await vi.waitFor(() => expect(session.sent).toEqual(['running', 'picked']))
      session.emit({ type: 'turn.completed', turnId: 't2', status: 'completed' })
      await vi.waitFor(() => expect(session.sent).toEqual(['running', 'picked', 'first queued']))
      await orchestrator.disposeAll()
    })

    it('stay held without a new agent process when the Stop ends the old one', async () => {
      const { sessions, orchestrator } = harness()
      const thread = await orchestrator.startThread('codex', '/repo')
      const session = sessions[0]!
      session.turnIds = ['t1']
      await orchestrator.submitTurn(thread.id, 'running')
      const queued = await orchestrator.submitTurn(thread.id, 'sent by accident')
      if (!queued.queued) throw new Error('expected the prompt to queue')
      session.interruptError = new Error('Stop failed')

      await orchestrator.interrupt(thread.id)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(session.disposed).toBe(true)
      expect(sessions).toHaveLength(1)
      expect(orchestrator.queue(thread.id).items.map((item) => item.text)).toEqual([
        'sent by accident',
      ])

      // Sending the held prompt resumes the chat in a new process.
      await orchestrator.steerQueuedTurn(thread.id, queued.queuedTurn.id)
      expect(sessions).toHaveLength(2)
      expect(sessions[1]!.sent).toEqual(['sent by accident'])
      await orchestrator.disposeAll()
    })

    it('still go out after a turn the user did not stop', async () => {
      const { sessions, orchestrator } = harness()
      const thread = await orchestrator.startThread('codex', '/repo')
      const session = sessions[0]!
      session.turnIds = ['t1', 't2']
      await orchestrator.submitTurn(thread.id, 'running')
      await orchestrator.submitTurn(thread.id, 'queued')
      session.emit({ type: 'turn.completed', turnId: 't1', status: 'completed' })

      await vi.waitFor(() => expect(session.sent).toEqual(['running', 'queued']))
      await orchestrator.disposeAll()
    })
  })

  describe('a Stop the agent has not confirmed yet', () => {
    const tool = (status: 'started' | 'completed'): DomainEvent => ({
      type: status === 'started' ? 'item.started' : 'item.completed',
      item: {
        id: 'tool-1',
        turnId: 's1-turn',
        type: 'tool_call',
        status,
        text: 'npm test',
        createdAt: 1,
      },
    })
    const turnsCompleted = (received: Array<{ event: DomainEvent }>) =>
      received.flatMap(({ event }) => (event.type === 'turn.completed' ? [event] : []))

    async function stoppedWhileUnconfirmed(stopSettleMs?: number) {
      const context = harness(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        stopSettleMs,
      )
      const { sessions, orchestrator } = context
      const thread = await orchestrator.startThread('codex', '/repo')
      const session = sessions[0]!
      await orchestrator.submitTurn(thread.id, 'sent by accident')
      session.emit({
        type: 'turn.started',
        turn: { id: 's1-turn', threadId: thread.id, status: 'running', createdAt: 1 },
      })
      session.emit(tool('started'))
      let confirm!: () => void
      session.interruptBarrier = new Promise<void>((resolve) => (confirm = resolve))
      const stopping = orchestrator.interrupt(thread.id)
      await vi.waitFor(() => expect(session.interrupted).toBe(true))
      return { ...context, thread, session, stopping, confirm }
    }

    it('ends the turn for the user at once', async () => {
      const { orchestrator, thread, received, stopping, confirm } = await stoppedWhileUnconfirmed()

      expect(turnsCompleted(received)).toEqual([
        expect.objectContaining({ turnId: 's1-turn', status: 'interrupted' }),
      ])
      // The tool the user stopped closes as interrupted (still `started`), not
      // failed: ending the turn at once borrows restart recovery's settling,
      // where a dead runtime's work does count as failed.
      expect(received.map(({ event }) => event)).toContainEqual({
        type: 'item.completed',
        item: expect.objectContaining({ id: 'tool-1', status: 'started' }),
      })
      expect(orchestrator.isTurnRunning(thread.id)).toBe(false)
      expect(orchestrator.inboxStatus(thread.id)).not.toBe('working')

      confirm()
      await expect(stopping).resolves.toBeUndefined()
      await orchestrator.disposeAll()
    })

    it('keeps a stopped tool interrupted when the agent later reports it failed', async () => {
      const { orchestrator, thread, session, store, stopping, confirm } =
        await stoppedWhileUnconfirmed()
      confirm()
      await stopping
      session.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'interrupted' })
      // Codex reports the killed process after the turn ended.
      session.emit({
        type: 'item.completed',
        item: {
          id: 'tool-1',
          turnId: 's1-turn',
          type: 'tool_call',
          status: 'failed',
          text: 'runner error: runner pipe closed',
          createdAt: 1,
        },
      })
      const lastTool = () =>
        store
          .history(thread.id)
          .flatMap(({ event }) =>
            event.type === 'item.completed' && event.item.id === 'tool-1' ? [event.item] : [],
          )
          .at(-1)
      expect(lastTool()).toMatchObject({ status: 'started' })

      // The next turn's own failures are failures again.
      session.turnIds.push('s2-turn')
      await orchestrator.submitTurn(thread.id, 'try again')
      session.emit({
        type: 'turn.started',
        turn: { id: 's2-turn', threadId: thread.id, status: 'running', createdAt: 2 },
      })
      session.emit({
        type: 'item.completed',
        item: { ...lastTool()!, id: 'tool-2', turnId: 's2-turn', status: 'failed' },
      })
      expect(
        store
          .history(thread.id)
          .flatMap(({ event }) =>
            event.type === 'item.completed' && event.item.id === 'tool-2' ? [event.item] : [],
          )
          .at(-1),
      ).toMatchObject({ status: 'failed' })
      await orchestrator.disposeAll()
    })

    it('keeps a stopped tool interrupted after the database and server reopen', async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'stopped-tool-restart-'))
      const database = path.join(directory, 'state.db')
      let store = new Store(database)
      try {
        const { orchestrator, sessions } = harness(undefined, store)
        const thread = await orchestrator.startThread('codex', '/repo')
        const session = sessions[0]!
        await orchestrator.submitTurn(thread.id, 'run the tests')
        session.emit({
          type: 'turn.started',
          turn: { id: 's1-turn', threadId: thread.id, status: 'running', createdAt: 1 },
        })
        session.emit(tool('started'))
        await orchestrator.interrupt(thread.id)
        await orchestrator.disposeAll()
        store.close()

        // Restart recovery settles what a dead runtime left open, as failed.
        // The Stop already closed this turn's work, so nothing is left for it.
        store = new Store(database)
        expect(store.recoverInterruptedThreads()).toEqual([])
        const lastTool = compactHistoryReplay(store.history(thread.id))
          .flatMap(({ event }) =>
            (event.type === 'item.started' || event.type === 'item.completed') &&
            event.item.id === 'tool-1'
              ? [event]
              : [],
          )
          .at(-1)
        expect(lastTool).toMatchObject({ item: { id: 'tool-1', status: 'started' } })
        expect(store.history(thread.id).at(-1)?.event).toMatchObject({
          type: 'turn.completed',
          turnId: 's1-turn',
          status: 'interrupted',
        })
      } finally {
        store.close()
        rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    })

    it('records nothing more of the stopped turn, its end included', async () => {
      const { orchestrator, thread, session, received, confirm, stopping } =
        await stoppedWhileUnconfirmed()
      const recorded = received.length

      session.emit({ type: 'item.delta', turnId: 's1-turn', itemId: 'tool-1', textDelta: 'x' })
      session.emit(tool('completed'))
      session.emit({
        type: 'turn.started',
        turn: { id: 's1-turn', threadId: thread.id, status: 'running', createdAt: 1 },
      })
      session.emit({
        type: 'approval.requested',
        request: { id: 'approval-1', kind: 'command', command: 'npm test', createdAt: 1 },
      })
      session.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'interrupted' })
      confirm()
      await stopping

      expect(received).toHaveLength(recorded)
      expect(orchestrator.isTurnRunning(thread.id)).toBe(false)
      expect(orchestrator.inboxStatus(thread.id)).not.toBe('approval')
      await orchestrator.disposeAll()
    })

    it('does not let a turn the agent starts on its own run again', async () => {
      const { orchestrator, thread, session, received, confirm } = await stoppedWhileUnconfirmed()

      session.emit({
        type: 'turn.started',
        turn: { id: 'unasked-turn', threadId: thread.id, status: 'running', createdAt: 2 },
      })

      expect(
        received.some(
          ({ event }) => event.type === 'turn.started' && event.turn.id === 'unasked-turn',
        ),
      ).toBe(false)
      expect(orchestrator.isTurnRunning(thread.id)).toBe(false)
      confirm()
      await orchestrator.disposeAll()
    })

    it('stops new work the agent starts in the turn after accepting the Stop', async () => {
      const { orchestrator, session, received, confirm, stopping } = await stoppedWhileUnconfirmed()
      confirm()
      await stopping
      const interrupt = vi.spyOn(session, 'interrupt')
      const recorded = received.length

      // A steer Claude kept queued through the Stop starts its own run in the same turn.
      session.emit({
        type: 'item.started',
        item: {
          id: 'steer-answer',
          turnId: 's1-turn',
          type: 'message',
          role: 'assistant',
          status: 'started',
          createdAt: 2,
        },
      })
      session.emit({
        type: 'item.started',
        item: {
          id: 'tool-2',
          turnId: 's1-turn',
          type: 'tool_call',
          status: 'started',
          createdAt: 3,
        },
      })

      expect(interrupt).toHaveBeenCalledTimes(1)
      expect(received).toHaveLength(recorded)
      await orchestrator.disposeAll()
    })

    it('shows no error banner when the agent reports the stopped run as failed', async () => {
      const { orchestrator, thread, session, received, logs, confirm, stopping } =
        await stoppedWhileUnconfirmed()
      confirm()
      await stopping
      // A late item of the stopped run looks like new work, and the repeat Stop is refused;
      // an agent can then report the run it was already ending as an error.
      session.interruptError = new Error('no run to stop')
      session.emit({
        type: 'item.started',
        item: {
          id: 'late-answer',
          turnId: 's1-turn',
          type: 'message',
          role: 'assistant',
          status: 'started',
          createdAt: 2,
        },
      })
      await vi.waitFor(() =>
        expect(logs).toContainEqual(expect.stringMatching(/Could not stop.*no run to stop/)),
      )
      session.emit({ type: 'thread.error', threadId: thread.id, message: 'aborted by user' })
      session.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'failed' })

      expect(received.some(({ event }) => event.type === 'thread.error')).toBe(false)
      expect(logs).toContainEqual(expect.stringMatching(/ending a stopped turn: aborted by user/))
      expect(turnsCompleted(received)).toEqual([
        expect.objectContaining({ turnId: 's1-turn', status: 'interrupted' }),
      ])
      await orchestrator.disposeAll()
    })

    it('still shows an error the agent reports before it accepted the Stop', async () => {
      const { orchestrator, thread, session, received, confirm, stopping } =
        await stoppedWhileUnconfirmed()
      session.emit({ type: 'thread.error', threadId: thread.id, message: 'connection lost' })
      confirm()
      await stopping

      expect(received.map(({ event }) => event)).toContainEqual(
        expect.objectContaining({ type: 'thread.error', message: 'connection lost' }),
      )
      await orchestrator.disposeAll()
    })

    it('holds a prompt sent meanwhile until the agent has ended the turn', async () => {
      const { orchestrator, thread, session, confirm, stopping } = await stoppedWhileUnconfirmed()

      await expect(orchestrator.submitTurn(thread.id, 'the real question')).resolves.toMatchObject({
        queued: true,
      })
      expect(session.sent).toEqual(['sent by accident'])

      confirm()
      await stopping
      session.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'interrupted' })
      await vi.waitFor(() =>
        expect(session.sent).toEqual(['sent by accident', 'the real question']),
      )
      await orchestrator.disposeAll()
    })

    it('ends the agent process when the agent never ends the turn', async () => {
      const { orchestrator, thread, session, logs, confirm, stopping } =
        await stoppedWhileUnconfirmed(20)
      confirm()
      await stopping

      await vi.waitFor(() => expect(session.disposed).toBe(true))
      expect(logs).toContainEqual(expect.stringMatching(/did not end the stopped turn.*ending/))
      expect(orchestrator.isRunning(thread.id)).toBe(false)
      await orchestrator.disposeAll()
    })

    it('ends the agent process when the agent refuses the Stop', async () => {
      const { orchestrator, thread, session, logs, confirm, stopping } =
        await stoppedWhileUnconfirmed()
      session.interruptError = new Error('Stop failed')
      confirm()

      await expect(stopping).resolves.toBeUndefined()
      expect(session.disposed).toBe(true)
      expect(logs).toContainEqual(expect.stringMatching(/refused Stop \(Stop failed\).*ending/))
      expect(orchestrator.isTurnRunning(thread.id)).toBe(false)
      await orchestrator.disposeAll()
    })
  })

  it('shows a chat as starting while it resumes for a sent prompt, and idle at Stop', async () => {
    const { orchestrator, store } = harness()
    store.addProject('/repo')
    store.addThread({
      id: 'persisted-thread',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Persisted',
    })
    try {
      expect(orchestrator.inboxStatus('persisted-thread')).toBe('idle')
      const before = orchestrator.sidebarStatusRevision()
      const sending = orchestrator.submitTurn('persisted-thread', 'stop this', [], {}, 'stopped')
      const stopped = expect(sending).rejects.toThrow('turn cancelled while resuming')
      expect(orchestrator.inboxStatus('persisted-thread')).toBe('starting')
      expect(orchestrator.sidebarStatusChangesSince(before)).toEqual(['persisted-thread'])

      const starting = orchestrator.sidebarStatusRevision()
      await orchestrator.interrupt('persisted-thread')
      // At the Stop, not when the cancelled resume has wound down.
      expect(orchestrator.inboxStatus('persisted-thread')).toBe('idle')
      expect(orchestrator.sidebarStatusChangesSince(starting)).toEqual(['persisted-thread'])
      await stopped
      expect(orchestrator.inboxStatus('persisted-thread')).toBe('idle')
    } finally {
      await orchestrator.disposeAll()
      store.close()
    }
  })

  it('goes from starting to working when a resumed chat starts its turn', async () => {
    const { sessions, orchestrator, store } = harness()
    store.addProject('/repo')
    store.addThread({
      id: 'persisted-thread',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Persisted',
    })
    try {
      const sending = orchestrator.submitTurn('persisted-thread', 'go', [], {}, 'go')
      expect(orchestrator.inboxStatus('persisted-thread')).toBe('starting')
      await expect(sending).resolves.toMatchObject({ queued: false })
      expect(sessions[0]!.sent).toEqual(['go'])
      expect(orchestrator.inboxStatus('persisted-thread')).toBe('working')
    } finally {
      await orchestrator.disposeAll()
      store.close()
    }
  })

  it('cancels a prompt at Stop while its slow resume is still under way', async () => {
    const { sessions, orchestrator, store, resumeBarriers } = harness()
    store.addProject('/repo')
    store.addThread({
      id: 'persisted-thread',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Persisted',
    })
    let finishResume!: () => void
    resumeBarriers.push(new Promise<void>((resolve) => (finishResume = resolve)))
    try {
      const sending = orchestrator.submitTurn('persisted-thread', 'stop this', [], {}, 'stopped')
      await orchestrator.interrupt('persisted-thread')
      // The prompt is back with the user now, not when Codex has finished resuming.
      // (Without the fix this waits for finishResume below and the test times out.)
      await expect(sending).rejects.toThrow('turn cancelled while resuming')
      expect(sessions).toHaveLength(0)

      // Sent again before the cancelled resume ended: it waits for that one, then resumes.
      const again = orchestrator.submitTurn('persisted-thread', 'send this', [], {}, 'next')
      finishResume()
      await expect(again).resolves.toMatchObject({ queued: false })
      expect(sessions).toHaveLength(2)
      expect(sessions[0]!.disposed).toBe(true)
      expect(sessions[0]!.sent).toEqual([])
      expect(sessions[1]!.sent).toEqual(['send this'])
      expect(store.hasUserSubmission('persisted-thread', 'stopped')).toBe(false)
    } finally {
      await orchestrator.disposeAll()
      store.close()
    }
  })

  it('queues the second of two prompts sent while the access mode changed during a resume', async () => {
    const { sessions, orchestrator, store, resumeBarriers, resumedIds } = harness()
    store.addProject('/repo')
    store.addThread({
      id: 'persisted-thread',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Persisted',
    })
    let finishResume!: () => void
    resumeBarriers.push(new Promise<void>((resolve) => (finishResume = resolve)))
    try {
      const first = orchestrator.submitTurn('persisted-thread', 'first', [], {}, 'first')
      const second = orchestrator.submitTurn('persisted-thread', 'second', [], {}, 'second')
      await vi.waitFor(() => expect(resumedIds).toHaveLength(1))
      const changing = orchestrator.setThreadApproval('persisted-thread', 'full')
      finishResume()
      await expect(changing).resolves.toBeUndefined()
      await expect(first).resolves.toMatchObject({ queued: false })
      await expect(second).resolves.toMatchObject({ queued: true })
      // Both started before: the second one's submission replaced the first one's.
      expect(sessions.at(-1)!.sent).toEqual(['first'])
    } finally {
      await orchestrator.disposeAll()
      store.close()
    }
  })

  describe('a Stop while the chat is still resuming', () => {
    // A persisted Codex chat whose resumes wait for the returned openers, in order.
    const resumingChat = (resumes: number) => {
      const made = harness()
      made.store.addProject('/repo')
      made.store.addThread({
        id: 'persisted-thread',
        projectPath: '/repo',
        provider: 'codex',
        title: 'Persisted',
      })
      const open: Array<() => void> = []
      for (let index = 0; index < resumes; index += 1)
        made.resumeBarriers.push(new Promise<void>((resolve) => open.push(resolve)))
      return { ...made, open }
    }
    const send = (orchestrator: Orchestrator, text: string) =>
      orchestrator.submitTurn('persisted-thread', text, [], {}, text)

    it('starts the prompt sent first after a Stop before one sent later', async () => {
      const { orchestrator, store, sessions, open, resumedIds } = resumingChat(2)
      try {
        const first = send(orchestrator, 'A')
        await orchestrator.interrupt('persisted-thread')
        await expect(first).rejects.toThrow('turn cancelled while resuming')
        const second = send(orchestrator, 'B')
        open[0]!()
        // C comes once B has started the next resume, and joins it.
        await vi.waitFor(() => expect(resumedIds).toHaveLength(2))
        const third = send(orchestrator, 'C')
        open[1]!()
        await expect(second).resolves.toMatchObject({ queued: false })
        await expect(third).resolves.toMatchObject({ queued: true })
        expect(sessions.at(-1)!.sent).toEqual(['B'])
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('starts no new resume for a prompt stopped again while it waits', async () => {
      const { orchestrator, store, sessions, open, resumedIds } = resumingChat(2)
      try {
        const first = send(orchestrator, 'A')
        await orchestrator.interrupt('persisted-thread')
        await expect(first).rejects.toThrow('turn cancelled while resuming')
        const second = send(orchestrator, 'B')
        await orchestrator.interrupt('persisted-thread')
        await expect(second).rejects.toThrow('turn cancelled while resuming')
        open[0]!()
        await vi.waitFor(() => expect(sessions[0]?.disposed).toBe(true))
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(resumedIds).toHaveLength(1)
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('rejects a waiting prompt at Stop all and starts no resume after it', async () => {
      const { orchestrator, store, open, resumedIds } = resumingChat(2)
      try {
        const first = send(orchestrator, 'A')
        await orchestrator.interrupt('persisted-thread')
        await expect(first).rejects.toThrow('turn cancelled while resuming')
        const second = send(orchestrator, 'B')
        const stopping = orchestrator.panicStop()
        await expect(second).rejects.toThrow('turn cancelled by panic stop')
        open[0]!()
        await stopping
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(resumedIds).toHaveLength(1)
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('stops a prompt that was still on its way when the Stop came', async () => {
      const { orchestrator, store, sessions, open, resumedIds } = resumingChat(2)
      try {
        const first = send(orchestrator, 'A')
        let arrive!: () => void
        const onItsWay = orchestrator.trackSubmission('persisted-thread', async () => {
          await new Promise<void>((resolve) => (arrive = resolve))
          return send(orchestrator, 'B')
        })
        await orchestrator.interrupt('persisted-thread')
        await expect(first).rejects.toThrow('turn cancelled while resuming')
        arrive()
        await expect(onItsWay).rejects.toThrow('turn cancelled while resuming')
        open[0]!()
        await vi.waitFor(() => expect(sessions[0]?.disposed).toBe(true))
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(resumedIds).toHaveLength(1)
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('changes the access mode during the wind-down without the stopped resume’s error', async () => {
      const { orchestrator, store, open } = resumingChat(2)
      try {
        const first = send(orchestrator, 'A')
        await orchestrator.interrupt('persisted-thread')
        await expect(first).rejects.toThrow('turn cancelled while resuming')
        const changing = orchestrator.setThreadApproval('persisted-thread', 'full')
        open[0]!()
        open[1]!()
        await expect(changing).resolves.toBeUndefined()
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('gives the session of a prompt sent again the access mode changed meanwhile', async () => {
      const { orchestrator, store, sessions, resumedOptions, open } = resumingChat(2)
      store.setThreadApproval('persisted-thread', 'full')
      try {
        const first = send(orchestrator, 'A')
        await orchestrator.interrupt('persisted-thread')
        await expect(first).rejects.toThrow('turn cancelled while resuming')
        // Both wait out the stopped resume; the change goes on first and resumes with its mode.
        const second = send(orchestrator, 'B')
        const changing = orchestrator.setThreadApproval('persisted-thread', 'ask')
        open[0]!()
        open[1]!()
        await expect(changing).resolves.toBeUndefined()
        await expect(second).resolves.toMatchObject({ queued: false })
        const live = sessions.at(-1)!
        expect(live.sent).toEqual(['B'])
        expect(resumedOptions.at(-1)?.approval).toBe('ask')
        expect(live.approvalModes).toEqual([])
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })

    // A prompt sent again started its resume from the old mode before the change came.
    const resumedBeforeTheChange = async (made: ReturnType<typeof resumingChat>) => {
      const { orchestrator, store, resumedIds, open } = made
      store.setThreadApproval('persisted-thread', 'full')
      const first = send(orchestrator, 'A')
      await orchestrator.interrupt('persisted-thread')
      await expect(first).rejects.toThrow('turn cancelled while resuming')
      const second = send(orchestrator, 'B')
      open[0]!()
      await vi.waitFor(() => expect(resumedIds).toHaveLength(2))
      // Wrapped, so the caller's await does not wait for the prompt itself.
      return { second }
    }

    it('tells the session a prompt sent again resumed in the old mode the access mode changed', async () => {
      const made = resumingChat(2)
      const { orchestrator, store, sessions, resumedOptions, open } = made
      try {
        const { second } = await resumedBeforeTheChange(made)
        const changing = orchestrator.setThreadApproval('persisted-thread', 'ask')
        open[1]!()
        await expect(changing).resolves.toBeUndefined()
        await expect(second).resolves.toMatchObject({ queued: false })
        expect(resumedOptions.at(-1)?.approval).toBe('full')
        const live = sessions.at(-1)!
        expect(live.approvalModes).toEqual(['ask'])
        expect(live.sent).toEqual(['B'])
        expect(store.threadApproval('persisted-thread')).toBe('ask')
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('resumes a session that cannot change its access mode again with the new one', async () => {
      const made = resumingChat(2)
      const { orchestrator, store, sessions, resumedIds, resumedOptions, open } = made
      const setApproval = Object.getOwnPropertyDescriptor(FakeSession.prototype, 'setApproval')!
      Object.defineProperty(FakeSession.prototype, 'setApproval', {
        ...setApproval,
        value: undefined,
      })
      try {
        const { second } = await resumedBeforeTheChange(made)
        const changing = orchestrator.setThreadApproval('persisted-thread', 'ask')
        open[1]!()
        await expect(changing).resolves.toBeUndefined()
        await expect(second).resolves.toMatchObject({ queued: false })
        expect(resumedIds).toHaveLength(3)
        expect(resumedOptions.map((options) => options.approval)).toEqual(['full', 'full', 'ask'])
        expect(sessions.at(-2)!.disposed).toBe(true)
        expect(sessions.at(-2)!.sent).toEqual([])
        expect(sessions.at(-1)!.sent).toEqual(['B'])
        expect(store.threadApproval('persisted-thread')).toBe('ask')
      } finally {
        Object.defineProperty(FakeSession.prototype, 'setApproval', setApproval)
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('resumes afresh for what the user asks after Stop all, with its access mode', async () => {
      const { orchestrator, store, sessions, resumedOptions, open } = resumingChat(2)
      store.setThreadApproval('persisted-thread', 'full')
      try {
        const first = send(orchestrator, 'A')
        await orchestrator.panicStop()
        await expect(first).rejects.toThrow('turn cancelled by panic stop')
        // Both come after Stop all, while its resume still winds down.
        const changing = orchestrator.setThreadApproval('persisted-thread', 'ask')
        const second = send(orchestrator, 'B')
        open[0]!()
        open[1]!()
        await expect(changing).resolves.toBeUndefined()
        await expect(second).resolves.toMatchObject({ queued: false })
        expect(resumedOptions.at(-1)?.approval).toBe('ask')
        expect(sessions.at(-1)!.sent).toEqual(['B'])
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('applies an access mode change during whose wait the chat was stopped', async () => {
      const { orchestrator, store, resumedOptions, open } = resumingChat(2)
      store.setThreadApproval('persisted-thread', 'full')
      try {
        const first = send(orchestrator, 'A')
        const changing = orchestrator.setThreadApproval('persisted-thread', 'ask')
        // The change already waits on the resume when the Stop comes.
        await new Promise((resolve) => setTimeout(resolve, 0))
        await orchestrator.interrupt('persisted-thread')
        await expect(first).rejects.toThrow('turn cancelled while resuming')
        open[0]!()
        open[1]!()
        await expect(changing).resolves.toBeUndefined()
        expect(store.threadApproval('persisted-thread')).toBe('ask')
        expect(resumedOptions.at(-1)?.approval).toBe('ask')
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('starts no resume for an access mode change once the app shuts down', async () => {
      const { orchestrator, store, sessions, open } = resumingChat(2)
      try {
        const first = send(orchestrator, 'A')
        await orchestrator.interrupt('persisted-thread')
        await expect(first).rejects.toThrow('turn cancelled while resuming')
        const changing = orchestrator.setThreadApproval('persisted-thread', 'ask')
        const stopping = orchestrator.disposeAll()
        open[0]!()
        open[1]!()
        await expect(changing).rejects.toThrow(/cancelled/)
        await stopping
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(sessions).toHaveLength(1)
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('starts no resume for a prompt whose chat moves to another provider meanwhile', async () => {
      const { orchestrator, store, resumedIds, open } = resumingChat(2)
      try {
        const first = send(orchestrator, 'A')
        await orchestrator.interrupt('persisted-thread')
        await expect(first).rejects.toThrow('turn cancelled while resuming')
        // B and the move both wait out the stopped resume; whichever goes on first,
        // B gives up and resumes nothing.
        const second = send(orchestrator, 'B')
        const moving = orchestrator.changeProvider('persisted-thread', { provider: 'grok' })
        open[0]!()
        open[1]!()
        await expect(second).rejects.toThrow('moving to another provider')
        await moving.catch(() => undefined)
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(resumedIds).toHaveLength(1)
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('gives back at Stop a prompt that waits behind an access mode change', async () => {
      const { orchestrator, store, sessions, resumedOptions, open } = resumingChat(2)
      store.setThreadApproval('persisted-thread', 'full')
      try {
        const first = send(orchestrator, 'A')
        const changing = orchestrator.setThreadApproval('persisted-thread', 'ask')
        const second = send(orchestrator, 'B')
        let settled = false
        void second.catch(() => undefined).finally(() => (settled = true))
        await orchestrator.interrupt('persisted-thread')
        await expect(first).rejects.toThrow('turn cancelled while resuming')
        // At the Stop, while the resume and the change still wait.
        await vi.waitFor(() => expect(settled).toBe(true))
        await expect(second).rejects.toThrow('turn cancelled while resuming')
        open[0]!()
        open[1]!()
        await expect(changing).resolves.toBeUndefined()
        expect(resumedOptions.at(-1)?.approval).toBe('ask')
        expect(sessions.at(-1)!.sent).toEqual([])
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('gives back at once a prompt a Stop caught on its way to an access mode change', async () => {
      const { orchestrator, store, sessions, resumedIds, open } = resumingChat(2)
      store.setThreadApproval('persisted-thread', 'full')
      try {
        const changing = orchestrator.setThreadApproval('persisted-thread', 'ask')
        await vi.waitFor(() => expect(resumedIds).toHaveLength(1))
        let arrive!: () => void
        const onItsWay = orchestrator.trackSubmission('persisted-thread', async () => {
          await new Promise<void>((resolve) => (arrive = resolve))
          return send(orchestrator, 'B')
        })
        await orchestrator.interrupt('persisted-thread')
        arrive()
        let settled = false
        void onItsWay.catch(() => undefined).finally(() => (settled = true))
        // While the change still resumes.
        await vi.waitFor(() => expect(settled).toBe(true))
        await expect(onItsWay).rejects.toThrow('turn cancelled while resuming')
        open[0]!()
        open[1]!()
        await changing.catch(() => undefined)
        expect(sessions.every((session) => session.sent.length === 0)).toBe(true)
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('fails an access mode change visibly when a Stop ends its own resume', async () => {
      const { orchestrator, store, resumedIds, open } = resumingChat(2)
      store.setThreadApproval('persisted-thread', 'full')
      try {
        const changing = orchestrator.setThreadApproval('persisted-thread', 'ask')
        await vi.waitFor(() => expect(resumedIds).toHaveLength(1))
        await orchestrator.interrupt('persisted-thread')
        open[0]!()
        open[1]!()
        await expect(changing).rejects.toThrow('turn cancelled while resuming')
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(resumedIds).toHaveLength(1)
        expect(store.threadApproval('persisted-thread')).toBe('full')
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('refuses an access mode change while the chat moves to another provider', async () => {
      const { orchestrator, store, resumedIds, open } = resumingChat(2)
      try {
        const first = send(orchestrator, 'A')
        await orchestrator.interrupt('persisted-thread')
        await expect(first).rejects.toThrow('turn cancelled while resuming')
        // The move waits out the stopped resume.
        const moving = orchestrator.changeProvider('persisted-thread', { provider: 'grok' })
        const changing = orchestrator.setThreadApproval('persisted-thread', 'ask')
        let settled = false
        void changing.catch(() => undefined).finally(() => (settled = true))
        await vi.waitFor(() => expect(settled).toBe(true))
        await expect(changing).rejects.toThrow('moving to another provider')
        open[0]!()
        open[1]!()
        await moving.catch(() => undefined)
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(resumedIds).toHaveLength(1)
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('gives back at Stop a prompt that waits for the old session to stop', async () => {
      const { orchestrator, sessions, store, resumedIds } = harness()
      let release: () => void = () => {}
      try {
        const thread = await orchestrator.startThread('codex', '/repo')
        await orchestrator.submitTurn(thread.id, 'first')
        const dead = sessions[0]!
        dead.disposeBarrier = new Promise<void>((resolve) => (release = resolve))
        dead.emit({ type: 'thread.error', threadId: thread.id, message: 'Provider disconnected' })
        dead.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'failed' })
        dead.emitDisconnected()
        const sending = orchestrator.submitTurn(thread.id, 'retry')
        let settled = false
        void sending.catch(() => undefined).finally(() => (settled = true))
        await new Promise<void>((resolve) => setImmediate(resolve))
        const stopping = orchestrator.interrupt(thread.id)
        // At the Stop, while the old session still stops.
        await vi.waitFor(() => expect(settled).toBe(true))
        await expect(sending).rejects.toThrow('turn cancelled while resuming')
        release()
        await stopping
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(resumedIds).toEqual([])
      } finally {
        release()
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('holds queued prompts without an error when a Stop ends the resume a disconnect started', async () => {
      const { orchestrator, sessions, received, resumeBarriers, resumedIds, store } = harness()
      let open: () => void = () => {}
      resumeBarriers.push(new Promise<void>((resolve) => (open = resolve)))
      try {
        const thread = await orchestrator.startThread('codex', '/repo')
        await orchestrator.submitTurn(thread.id, 'first')
        await orchestrator.submitTurn(thread.id, 'queued')
        sessions[0]!.emit({
          type: 'thread.error',
          threadId: thread.id,
          message: 'Provider crashed',
        })
        sessions[0]!.emitDisconnected()
        await vi.waitFor(() => expect(resumedIds).toHaveLength(1))
        await orchestrator.interrupt(thread.id)
        open()
        await vi.waitFor(() => expect(sessions[1]?.disposed).toBe(true))
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(
          received.some(
            ({ event }) =>
              event.type === 'thread.error' &&
              event.message.startsWith('Could not resume queued prompts:'),
          ),
        ).toBe(false)
        expect(orchestrator.queue(thread.id).items.map((item) => item.text)).toEqual(['queued'])
        expect(sessions[1]!.sent).toEqual([])
      } finally {
        open()
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('shows no error when the user sends again before a stopped reconnect resume ends', async () => {
      const { orchestrator, sessions, received, resumeBarriers, resumedIds, store } = harness()
      let open: () => void = () => {}
      resumeBarriers.push(new Promise<void>((resolve) => (open = resolve)))
      try {
        const thread = await orchestrator.startThread('codex', '/repo')
        await orchestrator.submitTurn(thread.id, 'first')
        await orchestrator.submitTurn(thread.id, 'queued')
        sessions[0]!.emit({
          type: 'thread.error',
          threadId: thread.id,
          message: 'Provider crashed',
        })
        sessions[0]!.emitDisconnected()
        await vi.waitFor(() => expect(resumedIds).toHaveLength(1))
        await orchestrator.interrupt(thread.id)
        const sending = orchestrator.submitTurn(thread.id, 'again')
        open()
        await expect(sending).resolves.toBeDefined()
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(
          received.some(
            ({ event }) =>
              event.type === 'thread.error' &&
              event.message.startsWith('Could not resume queued prompts:'),
          ),
        ).toBe(false)
      } finally {
        open()
        await orchestrator.disposeAll()
        store.close()
      }
    })

    it('keeps queued prompts held when a prompt the Stop caught on its way arrives', async () => {
      const { orchestrator, sessions, received, resumeBarriers, resumedIds, store } = harness()
      let open: () => void = () => {}
      resumeBarriers.push(new Promise<void>((resolve) => (open = resolve)))
      try {
        const thread = await orchestrator.startThread('codex', '/repo')
        await orchestrator.submitTurn(thread.id, 'first')
        await orchestrator.submitTurn(thread.id, 'queued')
        sessions[0]!.emit({
          type: 'thread.error',
          threadId: thread.id,
          message: 'Provider crashed',
        })
        sessions[0]!.emitDisconnected()
        await vi.waitFor(() => expect(resumedIds).toHaveLength(1))
        let arrive!: () => void
        const onItsWay = orchestrator.trackSubmission(thread.id, async () => {
          await new Promise<void>((resolve) => (arrive = resolve))
          return orchestrator.submitTurn(thread.id, 'on its way')
        })
        await orchestrator.interrupt(thread.id)
        arrive()
        await expect(onItsWay).rejects.toThrow('turn cancelled while resuming')
        open()
        await vi.waitFor(() => expect(sessions[1]?.disposed).toBe(true))
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(
          received.some(
            ({ event }) =>
              event.type === 'thread.error' &&
              event.message.startsWith('Could not resume queued prompts:'),
          ),
        ).toBe(false)
        expect(orchestrator.queue(thread.id).items.map((item) => item.text)).toEqual(['queued'])
      } finally {
        open()
        await orchestrator.disposeAll()
        store.close()
      }
    })
  })

  it('cancels a cold resume on Stop and allows a later submission', async () => {
    const { sessions, orchestrator, store } = harness()
    store.addProject('/repo')
    store.addThread({
      id: 'persisted-thread',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Persisted',
    })
    try {
      const sending = orchestrator.submitTurn('persisted-thread', 'stop this', [], {}, 'stopped')
      const stopped = expect(sending).rejects.toThrow('turn cancelled while resuming')
      expect(sessions).toHaveLength(1)
      await orchestrator.interrupt('persisted-thread')
      await stopped

      // The prompt is cancelled at the Stop; the resumed session ends right after.
      await vi.waitFor(() => expect(sessions[0]!.disposed).toBe(true))
      expect(sessions[0]!.sent).toEqual([])
      expect(store.thread('persisted-thread')?.closedAt).toBeUndefined()
      expect(store.hasUserSubmission('persisted-thread', 'stopped')).toBe(false)
      expect(orchestrator.isTurnRunning('persisted-thread')).toBe(false)

      await expect(
        orchestrator.submitTurn('persisted-thread', 'send this', [], {}, 'next'),
      ).resolves.toMatchObject({ queued: false })
      expect(sessions).toHaveLength(2)
      expect(sessions[1]!.disposed).toBe(false)
      expect(sessions[1]!.sent).toEqual(['send this'])
    } finally {
      await orchestrator.disposeAll()
      store.close()
    }
  })

  it('routes each session events to its own thread', async () => {
    const { sessions, received, orchestrator } = harness()

    const first = await orchestrator.startThread('codex', '/repo')
    const second = await orchestrator.startThread('codex', '/repo')

    sessions[0]!.emit(message('ALPHA'))
    sessions[1]!.emit(message('BRAVO'))

    const forFirst = received.filter((entry) => entry.threadId === first.id)
    const forSecond = received.filter((entry) => entry.threadId === second.id)
    expect(text(forFirst)).toEqual(['ALPHA'])
    expect(text(forSecond)).toEqual(['BRAVO'])
  })

  it('keeps each session history separate on disk too', async () => {
    const { sessions, store, orchestrator } = harness()

    const first = await orchestrator.startThread('codex', '/repo')
    const second = await orchestrator.startThread('codex', '/repo')

    sessions[0]!.emit(message('ALPHA'))
    sessions[1]!.emit(message('BRAVO'))

    expect(store.history(first.id)).toHaveLength(1)
    expect(store.history(second.id)).toHaveLength(1)
  })

  it('closing one session leaves the other running', async () => {
    const { sessions, orchestrator } = harness()

    const first = await orchestrator.startThread('codex', '/repo')
    const second = await orchestrator.startThread('codex', '/repo')

    orchestrator.close(first.id)

    expect(sessions[0]!.disposed).toBe(true)
    expect(sessions[1]!.disposed).toBe(false)
    expect(orchestrator.isRunning(first.id)).toBe(false)
    expect(orchestrator.isRunning(second.id)).toBe(true)
  })

  it('a closed session keeps its history and stops claiming to run', async () => {
    const { sessions, store, orchestrator } = harness()

    const thread = await orchestrator.startThread('codex', '/repo')
    sessions[0]!.emit(message('ALPHA'))
    orchestrator.close(thread.id)

    expect(orchestrator.isRunning(thread.id)).toBe(false)
    expect(store.history(thread.id)).toHaveLength(1)
    expect(store.thread(thread.id)?.closedAt).toBeGreaterThan(0)
  })

  it('interrupts every running session concurrently and reports adapter failures', async () => {
    const { sessions, orchestrator } = harness()
    for (let index = 0; index < 3; index += 1) {
      const thread = await orchestrator.startThread('codex', '/repo')
      await orchestrator.submitTurn(thread.id, 'work')
    }

    let releaseFirst = () => {}
    sessions[0]!.interruptBarrier = new Promise<void>((resolve) => (releaseFirst = resolve))
    sessions[1]!.interruptError = new Error('adapter did not respond')

    const stopping = orchestrator.panicStop()
    await vi.waitFor(() =>
      expect(sessions.map((session) => session.interrupted)).toEqual([true, true, true]),
    )
    releaseFirst()

    await expect(stopping).resolves.toEqual({
      sessions: [
        { threadId: 'thread-1', status: 'interrupted' },
        { threadId: 'thread-2', status: 'failed', error: 'adapter did not respond' },
        { threadId: 'thread-3', status: 'interrupted' },
      ],
    })
  })

  it('shares one Stop all between overlapping callers and keeps new work out until it ends', async () => {
    const { sessions, orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'work')
    let releaseInterrupt = () => {}
    sessions[0]!.interruptBarrier = new Promise<void>((resolve) => (releaseInterrupt = resolve))

    const first = orchestrator.panicStop()
    const second = orchestrator.panicStop()
    expect(second).toBe(first)
    await vi.waitFor(() => expect(sessions[0]!.interrupted).toBe(true))
    await expect(orchestrator.startThread('codex', '/repo')).rejects.toThrow(/panic stop/)

    releaseInterrupt()
    await expect(first).resolves.toEqual({
      sessions: [{ threadId: thread.id, status: 'interrupted' }],
    })
    await expect(orchestrator.startThread('codex', '/repo')).resolves.toBeDefined()
    await orchestrator.disposeAll()
  })

  it('leaves idle chats attached and open', async () => {
    const { sessions, orchestrator, store } = harness()
    const idle = await orchestrator.startThread('codex', '/repo')
    sessions[0]!.interruptError = new Error('there is no running Codex turn to interrupt')

    await expect(orchestrator.panicStop()).resolves.toEqual({ sessions: [] })

    expect(sessions[0]!.interrupted).toBe(false)
    expect(orchestrator.isRunning(idle.id)).toBe(true)
    expect(store.thread(idle.id)?.closedAt).toBeUndefined()
  })

  it('force-stops a failed interrupt without closing the chat', async () => {
    const { sessions, orchestrator, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'work')
    sessions[0]!.interruptError = new Error('adapter did not respond')

    await expect(orchestrator.panicStop()).resolves.toMatchObject({
      sessions: [{ threadId: thread.id, status: 'failed' }],
    })

    expect(sessions[0]!.disposed).toBe(true)
    expect(store.thread(thread.id)?.closedAt).toBeUndefined()
  })

  it('drops queued prompts so interrupted sessions do not restart', async () => {
    const { sessions, orchestrator, store, queueChanges } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'running')
    await orchestrator.submitTurn(thread.id, 'do not restart')

    const beforePanic = queueChanges.length
    await orchestrator.panicStop()
    sessions[0]!.emit({ type: 'turn.completed', turnId: 'turn-1', status: 'interrupted' })

    await vi.waitFor(() => expect(orchestrator.queue(thread.id).items).toEqual([]))
    expect(store.queuedTurns(thread.id)).toEqual([])
    expect(sessions[0]!.sent).toEqual(['running'])
    expect(queueChanges.slice(beforePanic)).toEqual([{ threadId: thread.id, itemIds: [] }])
  })

  it.each(['store', 'listener'] as const)(
    'still interrupts and releases its latch after a %s queue failure',
    async (failure) => {
      const { sessions, orchestrator, store, queueNotificationError } = harness()
      const first = await orchestrator.startThread('codex', '/repo')
      const second = await orchestrator.startThread('codex', '/repo')
      await orchestrator.submitTurn(second.id, 'Also running.')
      await orchestrator.submitTurn(first.id, 'Running.')
      await orchestrator.submitTurn(first.id, 'Do not run after failed Stop all.')
      if (failure === 'store') {
        vi.spyOn(store, 'clearAllQueuedTurns').mockImplementationOnce(() => {
          throw new Error('C:\\private\\harness.db is full')
        })
      } else {
        queueNotificationError.current = new Error('listener failed')
      }

      await expect(orchestrator.panicStop()).rejects.toThrow(
        'could not clear every queued prompt during Stop all',
      )
      expect(sessions.map(({ interrupted }) => interrupted)).toEqual([true, true])
      queueNotificationError.current = undefined
      sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'interrupted' })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(sessions[0]!.sent).toEqual(['Running.'])
      expect(orchestrator.queue(first.id).items).toEqual([])
      expect(store.queuedTurns(first.id)).toHaveLength(failure === 'store' ? 1 : 0)
      await expect(
        orchestrator.submitTurn(first.id, 'Work after failed Stop all.'),
      ).resolves.toMatchObject({ queued: false })
    },
  )

  it('drops durable queues that were never loaded into this process', async () => {
    const { sessions, orchestrator, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'Active.')
    await orchestrator.submitTurn(thread.id, 'Queued.', [], {}, 'submission-old')
    await orchestrator.disposeAll()

    await expect(orchestrator.panicStop()).resolves.toEqual({ sessions: [] })
    expect(store.queuedTurns(thread.id)).toEqual([])
    await orchestrator.submitTurn(thread.id, 'New work.', [], {}, 'submission-new')
    expect(sessions[1]?.sent).toEqual(['New work.'])
  })

  it('cancels a turn still waiting for its checkpoint', async () => {
    const { sessions, orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    let release = (_value: checkpoint.Snapshot) => {}
    vi.spyOn(checkpoint, 'takeSnapshot').mockReturnValueOnce(
      new Promise<checkpoint.Snapshot>((resolve) => (release = resolve)),
    )

    const sending = orchestrator.submitTurn(thread.id, 'not after panic')
    const cancelled = expect(sending).rejects.toThrow('turn cancelled by panic stop')
    await vi.waitFor(() => expect(orchestrator.isTurnRunning(thread.id)).toBe(true))
    const stopping = orchestrator.panicStop()
    release({ commit: 'checkpoint', clean: true })

    await cancelled
    await stopping
    expect(sessions[0]!.sent).toEqual([])
  })

  it('force-stops an adapter that does not acknowledge interruption', async () => {
    vi.useFakeTimers()
    try {
      const { sessions, orchestrator } = harness()
      const thread = await orchestrator.startThread('codex', '/repo')
      await orchestrator.submitTurn(thread.id, 'work')
      sessions[0]!.interruptBarrier = new Promise(() => {})

      const stopping = orchestrator.panicStop()
      await vi.advanceTimersByTimeAsync(5_000)

      await expect(stopping).resolves.toEqual({
        sessions: [
          {
            threadId: thread.id,
            status: 'failed',
            error: 'interrupt timed out; session was force-stopped',
          },
        ],
      })
      expect(sessions[0]!.disposed).toBe(true)
      expect(orchestrator.isRunning(thread.id)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes the open turn and its requests when Stop all force-stops an agent', async () => {
    vi.useFakeTimers()
    try {
      const { sessions, orchestrator, store, received } = harness()
      const thread = await orchestrator.startThread('codex', '/repo')
      const session = sessions[0]!
      await orchestrator.submitTurn(thread.id, 'work')
      session.emit(turnStarted(thread.id, 'turn-1'))
      session.emit({
        type: 'item.started',
        item: {
          id: 'cmd-1',
          turnId: 'turn-1',
          type: 'command',
          status: 'started',
          text: 'npm test',
          createdAt: 1,
        },
      })
      session.emit({
        type: 'approval.requested',
        request: { id: 'approval-1', kind: 'command', createdAt: 1 },
      })
      expect(orchestrator.inboxStatus(thread.id)).toBe('approval')
      session.interruptBarrier = new Promise(() => {})
      // The adapter's own cleanup arrives after the runtime is detached.
      session.dispose = () => {
        session.disposed = true
        session.emit({ type: 'approval.resolved', id: 'approval-1' })
      }

      const stopping = orchestrator.panicStop()
      await vi.advanceTimersByTimeAsync(5_000)
      await stopping

      const types = store.history(thread.id).map(({ event }) => event.type)
      expect(types.slice(-3)).toEqual(['item.completed', 'approval.resolved', 'turn.completed'])
      expect(store.history(thread.id).at(-1)?.event).toMatchObject({
        type: 'turn.completed',
        turnId: 'turn-1',
        status: 'interrupted',
      })
      expect(store.history(thread.id).at(-3)?.event).toMatchObject({
        type: 'item.completed',
        item: { id: 'cmd-1', status: 'failed' },
      })
      expect(received.at(-1)?.event).toMatchObject({ type: 'turn.completed' })
      expect(orchestrator.isTurnRunning(thread.id)).toBe(false)
      expect(orchestrator.inboxStatus(thread.id)).toBe('ready')
      expect(() => orchestrator.settleThread(thread.id)).not.toThrow()
      expect(store.recoverInterruptedThreads()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('sidebar inbox lifecycle', () => {
  it('prioritizes approvals and questions over an active turn and its queue', async () => {
    const { orchestrator, sessions, received } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    sessions[0]!.emit(turnStarted(thread.id, 'turn-1'))
    await orchestrator.submitTurn(thread.id, 'queued')
    sessions[0]!.emit({
      type: 'user_input.requested',
      request: {
        id: 'input',
        turnId: 'turn-1',
        createdAt: 1,
        autoResolutionMs: null,
        questions: [
          {
            id: 'q',
            header: 'Question',
            question: 'Continue?',
            allowOther: true,
            secret: false,
            options: null,
          },
        ],
      },
    })
    expect(orchestrator.inboxStatus(thread.id)).toBe('input')
    // The question goes to the user; TasteCode never answers it on their behalf.
    expect(
      received.some(
        ({ threadId, event }) => threadId === thread.id && event.type === 'user_input.requested',
      ),
    ).toBe(true)
    expect(sessions[0]!.userInputs).toEqual([])
    sessions[0]!.emit({
      type: 'approval.requested',
      request: { id: 'approval', kind: 'command', createdAt: 1 },
    })
    expect(orchestrator.inboxStatus(thread.id)).toBe('approval')
    await orchestrator.disposeAll()
  })

  it.each(['unsettle', 'wake'] as const)(
    'gives an old chat fresh activity after manual %s',
    async (action) => {
      const { orchestrator, store } = harness()
      store.addProject('/repo')
      store.addThread({
        id: 'old',
        provider: 'codex',
        projectPath: '/repo',
        title: 'Old',
        createdAt: 1,
      })
      store.updateSidebarSettings({ autoSettleDays: 1 })
      if (action === 'unsettle') {
        orchestrator.settleThread('old')
        orchestrator.unsettleThread('old')
      } else {
        orchestrator.snoozeThread('old', Date.now() + 60_000)
        orchestrator.unsnoozeThread('old')
      }
      orchestrator.refreshLifecycle()
      expect(store.thread('old')?.lifecycle.state).toBe('active')
      await orchestrator.disposeAll()
    },
  )

  it('loads every persisted thread in bulk and advances the cached status', async () => {
    const store = new Store(':memory:')
    store.addProject('/repo')
    for (let index = 0; index < 3; index += 1) {
      const threadId = `persisted-${index}`
      store.addThread({
        id: threadId,
        projectPath: '/repo',
        provider: 'codex',
        title: `Persisted ${index}`,
      })
      for (let item = 0; item < 20; item += 1) {
        store.append(threadId, message(`${threadId}-${item}`))
      }
      store.append(threadId, {
        type: 'turn.completed',
        turnId: `turn-${index}`,
        status: 'completed',
      })
    }
    const history = vi.spyOn(store, 'history')
    const { orchestrator, sessions } = harness(undefined, store)

    expect(orchestrator.inboxStatus('persisted-0')).toBe('idle')
    expect(orchestrator.inboxStatus('persisted-1')).toBe('idle')
    expect(orchestrator.inboxStatus('persisted-2')).toBe('idle')
    expect(history).not.toHaveBeenCalled()

    const submitted = await orchestrator.submitTurn('persisted-0', 'Continue.')
    history.mockClear()
    if (submitted.queued) throw new Error('expected an immediate turn')
    sessions[0]!.emit({
      type: 'turn.completed',
      turnId: submitted.turnId,
      status: 'completed',
    })
    sessions[0]!.emit({
      type: 'approval.requested',
      request: { id: 'approval-live', kind: 'command', createdAt: 1 },
    })

    expect(orchestrator.inboxStatus('persisted-0')).toBe('approval')
    expect(history).not.toHaveBeenCalled()

    sessions[0]!.emit({ type: 'approval.resolved', id: 'approval-live' })

    expect(orchestrator.inboxStatus('persisted-0')).toBe('ready')
    expect(history).not.toHaveBeenCalled()
    await orchestrator.disposeAll()
  })

  it('archives a chat the server already settled for inactivity', async () => {
    const { orchestrator, store } = harness()
    store.addProject('/repo')
    store.addThread({ id: 'old', provider: 'codex', projectPath: '/repo', title: 'Old' })
    store.settleThread('old', 'inactivity', 5)

    expect(orchestrator.settleThread('old')).toMatchObject({ state: 'settled', reason: 'manual' })
    expect(store.thread('old')?.lifecycle).toMatchObject({ state: 'settled', reason: 'manual' })
    // Archiving it again is nothing to do, not an error.
    expect(orchestrator.settleThread('old')).toMatchObject({ state: 'settled', reason: 'manual' })
    await orchestrator.disposeAll()
  })

  it('supports every manual transition and rejects hidden active work', async () => {
    const { orchestrator, sessions, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')

    expect(orchestrator.settleThread(thread.id).state).toBe('settled')
    expect(() => orchestrator.unsnoozeThread(thread.id)).toThrow(/expected snoozed/)
    expect(orchestrator.unsettleThread(thread.id)).toMatchObject({ state: 'active' })
    expect(orchestrator.snoozeThread(thread.id, Date.now() + 60_000).state).toBe('snoozed')
    expect(orchestrator.unsnoozeThread(thread.id)).toMatchObject({ state: 'active' })
    expect(orchestrator.setThreadKeepActive(thread.id, true)).toMatchObject({
      state: 'active',
      keepActive: true,
    })

    sessions[0]!.turnIds.push('turn-1')
    await orchestrator.submitTurn(thread.id, 'working')
    expect(() => orchestrator.settleThread(thread.id)).toThrow(/status is working/)
    sessions[0]!.emit({ type: 'turn.completed', turnId: 'turn-1', status: 'completed' })
    expect(orchestrator.inboxStatus(thread.id)).toBe('ready')
    expect(store.thread(thread.id)?.unread).toBe(true)

    sessions[0]!.emit({
      type: 'approval.requested',
      request: { id: 'approval-1', kind: 'command', command: 'pnpm test', createdAt: 1 },
    })
    expect(orchestrator.inboxStatus(thread.id)).toBe('approval')
    expect(() => orchestrator.snoozeThread(thread.id, Date.now() + 60_000)).toThrow(
      /status is approval/,
    )
  })

  it('automatically wakes activity and settles only eligible inactive work', async () => {
    const { orchestrator, sessions, store, lifecycles } = harness()
    const wakes = await orchestrator.startThread('codex', '/repo')
    const settles = await orchestrator.startThread('codex', '/repo')
    const kept = await orchestrator.startThread('codex', '/repo')
    const now = Date.now()

    orchestrator.snoozeThread(wakes.id, now + 1_000)
    store.touchThread(settles.id, true, now)
    orchestrator.setThreadKeepActive(kept.id, true)
    orchestrator.refreshLifecycle(now + 4 * 24 * 60 * 60 * 1_000)

    expect(store.thread(wakes.id)?.lifecycle).toMatchObject({ state: 'active' })
    expect(store.thread(settles.id)?.lifecycle).toMatchObject({
      state: 'settled',
      reason: 'inactivity',
    })
    expect(store.thread(settles.id)?.unread).toBe(true)
    expect(store.thread(kept.id)?.lifecycle).toMatchObject({ state: 'active', keepActive: true })

    orchestrator.settleThread(wakes.id)
    sessions[0]!.emit({
      type: 'turn.started',
      turn: { id: 'resumed', threadId: wakes.id, status: 'running', createdAt: now },
    })
    expect(store.thread(wakes.id)?.lifecycle).toMatchObject({ state: 'active' })
    expect(lifecycles.at(-1)).toMatchObject({
      threadId: wakes.id,
      lifecycle: { state: 'active' },
    })
  })

  it('publishes no lifecycle change when the refresh batch rolls back', async () => {
    const { orchestrator, store, lifecycles } = harness()
    const wakes = await orchestrator.startThread('codex', '/repo')
    const fails = await orchestrator.startThread('codex', '/repo')
    const now = Date.now()
    orchestrator.snoozeThread(wakes.id, now + 1_000)
    orchestrator.snoozeThread(fails.id, now + 1_000)
    const published = lifecycles.length
    const wake = store.wakeSnoozedThread.bind(store)
    let calls = 0
    vi.spyOn(store, 'wakeSnoozedThread').mockImplementation((threadId, ...rest) => {
      calls += 1
      if (calls === 2) throw new Error('disk full')
      return wake(threadId, ...rest)
    })

    expect(() => orchestrator.refreshLifecycle(now + 2_000)).toThrow('disk full')

    expect(lifecycles).toHaveLength(published)
    expect(store.thread(wakes.id)?.lifecycle).toMatchObject({ state: 'snoozed' })
    expect(store.thread(fails.id)?.lifecycle).toMatchObject({ state: 'snoozed' })
    await orchestrator.disposeAll()
  })

  it('checks durable queued work without loading every thread queue', async () => {
    const store = new Store(':memory:')
    store.addProject('/repo')
    store.addThread({
      id: 'idle',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Idle',
      createdAt: 0,
    })
    store.addThread({
      id: 'queued',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Queued',
      createdAt: 0,
    })
    store.enqueueQueuedTurn({
      id: 'queued-turn',
      threadId: 'queued',
      text: 'Keep working.',
      attachments: [],
      options: {},
      createdAt: 1,
    })
    const loadQueue = vi.spyOn(store, 'queuedTurns')
    const { orchestrator } = harness(undefined, store)

    orchestrator.refreshLifecycle(4 * 24 * 60 * 60 * 1_000)

    expect(loadQueue).not.toHaveBeenCalled()
    expect(store.thread('idle')?.lifecycle).toMatchObject({ state: 'settled' })
    expect(store.thread('queued')?.lifecycle).toMatchObject({ state: 'active' })
    await orchestrator.disposeAll()
  })

  it('publishes inactivity changes only after the whole batch committed', async () => {
    const { orchestrator, store, lifecycleHook } = harness()
    const first = await orchestrator.startThread('codex', '/repo')
    const second = await orchestrator.startThread('codex', '/repo')
    const now = Date.now()

    store.touchThread(first.id, false, now)
    store.touchThread(second.id, false, now + 1)
    const seen: string[] = []
    lifecycleHook.current = () => {
      seen.push(store.thread(second.id)!.lifecycle.state)
    }

    orchestrator.refreshLifecycle(now + 4 * 24 * 60 * 60 * 1_000)

    expect(seen).toEqual(['settled', 'settled'])
    expect(store.thread(first.id)?.lifecycle).toMatchObject({
      state: 'settled',
      reason: 'inactivity',
    })
    await orchestrator.disposeAll()
  })

  it('rechecks a snooze deadline when a lifecycle callback changes a later thread', async () => {
    const { orchestrator, store, lifecycleHook } = harness()
    const wakes = await orchestrator.startThread('codex', '/repo')
    const staysSnoozed = await orchestrator.startThread('codex', '/repo')
    const now = Date.now()
    const refreshAt = now + 2_000

    orchestrator.snoozeThread(wakes.id, now + 1_000)
    orchestrator.snoozeThread(staysSnoozed.id, now + 1_001)
    lifecycleHook.current = (_threadId, lifecycle) => {
      if (lifecycle.state !== 'active') return
      lifecycleHook.current = undefined
      store.snoozeThread(staysSnoozed.id, refreshAt + 60_000, refreshAt)
    }

    orchestrator.refreshLifecycle(refreshAt)

    expect(store.thread(wakes.id)?.lifecycle).toMatchObject({ state: 'active' })
    expect(store.thread(staysSnoozed.id)?.lifecycle).toEqual({
      state: 'snoozed',
      snoozedAt: refreshAt,
      wakeAt: refreshAt + 60_000,
    })
    await orchestrator.disposeAll()
  })

  it('uses the later-only schedule path unless the clock moves backwards', async () => {
    vi.useFakeTimers({ now: 10_000 })
    const { orchestrator, sessions, lifecycleScheduleChanges } = harness()
    try {
      await orchestrator.startThread('codex', '/repo')
      lifecycleScheduleChanges.length = 0

      sessions[0]!.emit({
        type: 'turn.completed',
        turnId: 'turn-forward',
        status: 'completed',
      })
      vi.setSystemTime(9_000)
      sessions[0]!.emit({
        type: 'turn.completed',
        turnId: 'turn-backward',
        status: 'completed',
      })

      expect(lifecycleScheduleChanges).toEqual(['later', undefined])
    } finally {
      await orchestrator.disposeAll()
      vi.useRealTimers()
    }
  })

  it('reports the exact deadline added by a new active thread', async () => {
    vi.useFakeTimers({ now: 10_000 })
    const { orchestrator, store, lifecycleScheduleChanges } = harness()
    try {
      const days = store.sidebarSettings().autoSettleDays
      if (days === null) throw new Error('expected automatic settling to be enabled')

      await orchestrator.startThread('codex', '/repo')

      expect(lifecycleScheduleChanges).toEqual([10_000 + days * 24 * 60 * 60 * 1_000])
    } finally {
      await orchestrator.disposeAll()
      vi.useRealTimers()
    }
  })

  it('does not add a deadline when automatic settling is off', async () => {
    const store = new Store(':memory:')
    store.updateSidebarSettings({ autoSettleDays: null })
    const { orchestrator, lifecycleScheduleChanges } = harness(undefined, store)
    try {
      await orchestrator.startThread('codex', '/repo')

      expect(lifecycleScheduleChanges).toEqual(['later'])
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('keeps archived state separate and honors the Off setting', async () => {
    const { orchestrator, store } = harness()
    const archived = await orchestrator.startThread('codex', '/repo')
    const inactive = await orchestrator.startThread('codex', '/repo')
    orchestrator.close(archived.id)

    expect(() => orchestrator.settleThread(archived.id)).toThrow(/archived/)
    store.updateSidebarSettings({ autoSettleDays: null })
    orchestrator.refreshLifecycle(Date.now() + 100 * 24 * 60 * 60 * 1_000)
    expect(store.thread(inactive.id)?.lifecycle).toMatchObject({ state: 'active' })
    expect(store.thread(archived.id)?.closedAt).toBeDefined()
  })
})

describe('session-owned subagent snapshots', () => {
  it.each(['disconnect', 'close', 'shutdown', 'idle release'] as const)(
    'settles a running subagent on %s and preserves its parent turn outcome',
    async (end) => {
      if (end === 'idle release') vi.useFakeTimers()
      const { orchestrator, sessions, store } = harness(undefined, new Store(':memory:'), 8, 1_000)
      try {
        const thread = await orchestrator.startThread('codex', '/repo')
        const session = sessions[0]!
        await orchestrator.sendTurn(thread.id, 'Review the design')
        const item = {
          id: 'reviewer',
          turnId: 's1-turn',
          type: 'tool_call' as const,
          status: 'completed' as const,
          text: 'Reviewer launched',
          createdAt: 1,
          subagent: { id: 'reviewer', state: 'running' as const, background: true, toolUses: 3 },
        }
        session.emit({ type: 'item.completed', item })
        session.emit({ type: 'turn.completed', turnId: item.turnId, status: 'completed' })
        const latest = () => reduceEventLog(emptyThread, store.history(thread.id))
        expect(latest().items.find(({ id }) => id === item.id)?.subagent?.state).toBe('running')

        if (end === 'disconnect') session.emitDisconnected()
        else if (end === 'close') await orchestrator.close(thread.id)
        else if (end === 'shutdown') await orchestrator.disposeAll()
        else await vi.advanceTimersByTimeAsync(1_000)

        expect(latest().items.find(({ id }) => id === item.id)).toMatchObject({
          status: 'completed',
          text: 'Reviewer launched',
          subagent: { state: 'interrupted', background: true, toolUses: 3 },
        })
        expect(
          store
            .history(thread.id)
            .filter(({ event }) => event.type === 'turn.completed')
            .at(-1)?.event,
        ).toMatchObject({ turnId: item.turnId, status: 'completed' })
      } finally {
        await orchestrator.disposeAll()
        vi.useRealTimers()
      }
    },
  )

  it('leaves a background subagent running on Stop and settles a launch still open', async () => {
    const { orchestrator, sessions, store } = harness(undefined, new Store(':memory:'))
    try {
      const thread = await orchestrator.startThread('codex', '/repo')
      const session = sessions[0]!
      session.turnIds = ['launch-turn', 'stopped-turn']
      await orchestrator.sendTurn(thread.id, 'Review the design in the background')
      // Launched by an earlier turn: its launching call completed and it runs on.
      session.emit({
        type: 'item.completed',
        item: {
          id: 'reviewer',
          turnId: 'launch-turn',
          type: 'tool_call',
          status: 'completed',
          text: 'Reviewer launched',
          createdAt: 1,
          subagent: { id: 'reviewer', state: 'running', background: true, toolUses: 3 },
        },
      })
      session.emit({ type: 'turn.completed', turnId: 'launch-turn', status: 'completed' })
      await orchestrator.sendTurn(thread.id, 'Explore the repo')
      // The stopped turn's own launching call has not completed yet.
      session.emit({
        type: 'item.started',
        item: {
          id: 'explorer',
          turnId: 'stopped-turn',
          type: 'tool_call',
          status: 'started',
          text: 'Explorer launched',
          createdAt: 2,
          subagent: { id: 'explorer', state: 'running' },
        },
      })

      await orchestrator.interrupt(thread.id)

      // Stop ends the running turn only; background work keeps running (#2058).
      const items = reduceEventLog(emptyThread, store.history(thread.id)).items
      expect(items.find(({ id }) => id === 'reviewer')).toMatchObject({
        status: 'completed',
        subagent: { state: 'running', background: true, toolUses: 3 },
      })
      // The launch the user stopped is interrupted, not failed; its row reads
      // the sub-agent's own state.
      expect(items.find(({ id }) => id === 'explorer')).toMatchObject({
        status: 'started',
        subagent: { state: 'interrupted' },
      })
      expect(
        store
          .history(thread.id)
          .filter(({ event }) => event.type === 'turn.completed')
          .at(-1)?.event,
      ).toMatchObject({ turnId: 'stopped-turn', status: 'interrupted' })
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it.each(['disconnect', 'idle release', 'shutdown'] as const)(
    "leaves TasteCode's own subagents to the broker on %s",
    async (end) => {
      if (end === 'idle release') vi.useFakeTimers()
      const { orchestrator, sessions, store } = harness(undefined, new Store(':memory:'), 8, 1_000)
      try {
        const thread = await orchestrator.startThread('codex', '/repo')
        const session = sessions[0]!
        await orchestrator.sendTurn(thread.id, 'Delegate the review')
        const run = (
          itemId: string,
          shortId: string,
          state: 'running' | 'waiting_for_approval',
          threadId?: string,
        ): StoredSubagentRun => ({
          itemId,
          parentThreadId: thread.id,
          shortId,
          turnId: 's1-turn',
          ...(threadId ? { threadId } : {}),
          provider: 'claude-code',
          task: 'Review src/a.ts',
          state,
          snapshot: {
            id: shortId,
            state: 'running',
            ...(threadId ? { threadId } : {}),
            provider: 'claude-code',
          },
          createdAt: 1,
        })
        // As the broker records them: one runs in a chat of its own, the other waits for
        // the user's approval before it has one.
        for (const entry of [
          run('broker-running', 'a1', 'running', 'child-thread'),
          run('broker-waiting', 'a2', 'waiting_for_approval'),
        ]) {
          store.subagents.add(entry)
          store.append(thread.id, { type: 'item.completed', item: subagentRunItem(entry) })
        }
        session.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })

        if (end === 'disconnect') session.emitDisconnected()
        else if (end === 'idle release') await vi.advanceTimersByTimeAsync(1_000)
        else await orchestrator.disposeAll()

        expect(orchestrator.isRunning(thread.id)).toBe(false)
        const items = reduceEventLog(emptyThread, store.history(thread.id)).items
        for (const id of ['broker-running', 'broker-waiting'])
          expect(items.find((item) => item.id === id)?.subagent?.state).toBe('running')
      } finally {
        await orchestrator.disposeAll()
        vi.useRealTimers()
      }
    },
  )
})

describe('queued turns', () => {
  it('bounds empty queue reads while retaining the hottest entries', async () => {
    const store = new Store(':memory:')
    store.addProject('/repo')
    for (let index = 0; index < 256; index += 1) {
      store.addThread({
        id: `empty-${index}`,
        projectPath: '/repo',
        provider: 'codex',
        title: `Empty ${index}`,
      })
    }
    const loadQueue = vi.spyOn(store, 'queuedTurns')
    const { orchestrator } = harness(undefined, store)
    try {
      for (let index = 0; index < 256; index += 1) {
        expect(orchestrator.queue(`empty-${index}`).items).toEqual([])
      }
      expect(loadQueue).toHaveBeenCalledTimes(256)

      expect(orchestrator.queue('empty-0').items).toEqual([])
      expect(loadQueue).toHaveBeenCalledTimes(257)
      expect(orchestrator.queue('empty-255').items).toEqual([])
      expect(loadQueue).toHaveBeenCalledTimes(257)
    } finally {
      await orchestrator.disposeAll()
      store.close()
    }
  })

  it('restores exact mutations and drains in order after a server restart', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-orchestrator-queue-'))
    const file = path.join(dir, 'harness.db')
    const seededStore = new Store(file)
    const seeded = harness(undefined, seededStore)
    try {
      const thread = await seeded.orchestrator.startThread('codex', '/repo')
      const submit = seeded.orchestrator.submitTurn.bind(seeded.orchestrator)
      await seeded.orchestrator.submitTurn(thread.id, 'Active.', [], {}, 'submission-active')
      seeded.sessions[0]!.emit(turnStarted(thread.id, 'active-turn'))
      for (const [id, attachment, model] of [
        ['submission-a', 'C:\\private\\a.png', 'model-a'],
        ['submission-b', 'C:\\private\\b.png', 'model-b'],
        ['submission-c', 'C:\\private\\c.png', 'model-c'],
      ] as const) {
        await submit(thread.id, 'Repeat.', [attachment], { model }, id)
      }
      seeded.orchestrator.moveQueuedTurn(thread.id, 'submission-c', 'up')
      seeded.orchestrator.deleteQueuedTurn(thread.id, 'submission-a')
      await seeded.orchestrator.disposeAll()
      seededStore.close()

      const restartedStore = new Store(file)
      restartedStore.recoverInterruptedThreads()
      const restarted = harness(undefined, restartedStore)
      try {
        expect(restarted.orchestrator.queue(thread.id).items.map(({ id }) => id)).toEqual([
          'submission-c',
          'submission-b',
        ])
        await restarted.orchestrator.submitTurn(thread.id, 'Wake the queue.')
        await vi.waitFor(() => expect(restarted.sessions[0]?.sent).toEqual(['Repeat.']))
        expect(restarted.sessions[0]?.sentAttachments[0]).toEqual(['C:\\private\\c.png'])
        expect(restarted.sessions[0]?.sentOptions[0]).toEqual({ model: 'model-c' })

        restarted.sessions[0]!.emit({
          type: 'turn.completed',
          turnId: 's1-turn',
          status: 'completed',
        })
        await vi.waitFor(() => expect(restarted.sessions[0]?.sent).toHaveLength(2))
        expect(restarted.orchestrator.queue(thread.id).items).toHaveLength(1)
      } finally {
        await restarted.orchestrator.disposeAll()
        restartedStore.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it('restores a provider-rejected drain without logging prompt content or paths', async () => {
    const { sessions, orchestrator, store, logs } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'Active.')
    await orchestrator.submitTurn(
      thread.id,
      'private prompt content',
      ['C:\\secret\\private.png'],
      {},
      'submission-private',
    )
    sessions[0]!.sendError = new Error(
      'provider rejected private prompt content at C:\\secret\\private.png',
    )

    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })

    await vi.waitFor(() => expect(logs).toContain('could not start queued turn; it remains queued'))
    expect(orchestrator.queue(thread.id).items.map(({ id }) => id)).toEqual(['submission-private'])
    expect(store.queuedTurns(thread.id).map(({ id }) => id)).toEqual(['submission-private'])
    expect(logs.join('\n')).not.toMatch(/private prompt content|secret\\private/)
  })

  it('restores a failed drain from durable state after its empty queue cache was evicted', async () => {
    const { sessions, orchestrator, store, logs } = harness()
    try {
      const thread = await orchestrator.startThread('codex', '/repo')
      const session = sessions[0]!
      await orchestrator.submitTurn(thread.id, 'running')
      await orchestrator.submitTurn(thread.id, 'A', [], {}, 'a')
      session.release = () => {}
      session.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
      await vi.waitFor(() => expect(session.sent).toEqual(['running', 'A']))

      for (let index = 0; index < 256; index += 1) orchestrator.queue(`cold-${index}`)
      await orchestrator.submitTurn(thread.id, 'B', [], {}, 'b')
      session.sendError = new Error('send disconnected')
      session.release?.()
      await vi.waitFor(() =>
        expect(logs).toContain('could not start queued turn; it remains queued'),
      )

      expect(orchestrator.queue(thread.id).items.map((item) => item.text)).toEqual(['A', 'B'])
      expect(store.queuedTurns(thread.id).map((item) => item.text)).toEqual(['A', 'B'])
    } finally {
      await orchestrator.disposeAll()
      store.close()
    }
  })

  it('keeps a resumed runtime drain locked when an old dispatch settles', async () => {
    const { sessions, orchestrator, store } = harness()
    let releaseCurrent: (() => void) | undefined
    try {
      const thread = await orchestrator.startThread('codex', '/repo')
      const oldSession = sessions[0]!
      await orchestrator.submitTurn(thread.id, 'old running')
      await orchestrator.submitTurn(thread.id, 'old queued')
      oldSession.release = () => {}
      oldSession.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
      await vi.waitFor(() => expect(oldSession.sent).toHaveLength(2))
      await orchestrator.disposeAll()

      await orchestrator.submitTurn(thread.id, 'new running')
      const current = sessions[1]!
      await orchestrator.submitTurn(thread.id, 'new queued')
      await orchestrator.submitTurn(thread.id, 'later queued')
      current.release = () => {}
      current.emit({ type: 'turn.completed', turnId: 's2-turn', status: 'completed' })
      await vi.waitFor(() => expect(current.sent).toEqual(['new running', 'new queued']))
      releaseCurrent = current.release

      oldSession.release?.()
      await new Promise<void>((resolve) => setImmediate(resolve))
      await orchestrator.submitTurn(thread.id, 'another queued')
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(current.sent).toEqual(['new running', 'new queued'])
      expect(orchestrator.queue(thread.id).items.map((item) => item.text)).toEqual([
        'later queued',
        'another queued',
      ])
    } finally {
      releaseCurrent?.()
      await new Promise<void>((resolve) => setImmediate(resolve))
      await orchestrator.disposeAll()
      store.close()
    }
  })

  it('does not resurrect work accepted before the provider request rejects', async () => {
    const { sessions, orchestrator, store, logs } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'Active.')
    await orchestrator.submitTurn(thread.id, 'Accepted once.', [], {}, 'submission-accepted')
    sessions[0]!.eventDuringSend = turnStarted(thread.id, 'accepted-turn')
    sessions[0]!.afterEventBarrier = Promise.reject(new Error('request disconnected'))

    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })

    await vi.waitFor(() =>
      expect(logs).toContain('queued turn ended after acceptance or cancellation'),
    )
    expect(store.queuedTurns(thread.id)).toEqual([])
    expect(store.hasUserSubmission(thread.id, 'submission-accepted')).toBe(true)
  })

  it('does not revive a closed thread after a legacy queued send resolves', async () => {
    const { sessions, orchestrator, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'Active.')
    await orchestrator.submitTurn(thread.id, 'Legacy queued work.')
    sessions[0]!.release = () => {}
    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    await vi.waitFor(() => expect(sessions[0]!.sent).toHaveLength(2))

    orchestrator.close(thread.id)
    sessions[0]!.release?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(orchestrator.isTurnRunning(thread.id)).toBe(false)
    expect(orchestrator.queue(thread.id).items).toEqual([])
    expect(store.thread(thread.id)?.closedAt).toBeDefined()
  })

  it('does not touch the store when a queued send rejects after server disposal', async () => {
    const { sessions, orchestrator, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'Active.')
    await orchestrator.submitTurn(thread.id, 'Queued work.')
    sessions[0]!.release = () => {}
    sessions[0]!.sendError = new Error('provider stopped')
    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    await vi.waitFor(() => expect(sessions[0]!.sent).toHaveLength(2))

    await orchestrator.disposeAll()
    store.close()
    sessions[0]!.release?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('does not restore or drain a steer that resolves after server disposal', async () => {
    const { sessions, orchestrator, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'Active.')
    sessions[0]!.emit(turnStarted(thread.id, 'active-turn'))
    const queued = await orchestrator.submitTurn(thread.id, 'Steer later.')
    if (!queued.queued) throw new Error('expected the prompt to queue')
    let release = () => {}
    sessions[0]!.steerBarriers.push(new Promise<void>((resolve) => (release = resolve)))
    const steering = orchestrator.steerQueuedTurn(thread.id, queued.queuedTurn.id)
    await vi.waitFor(() => expect(sessions[0]!.steered).toEqual(['Steer later.']))

    await orchestrator.disposeAll()
    store.close()
    release()

    await expect(steering).resolves.toBeUndefined()
  })

  it('runs queued prompts in order after the active turn completes', async () => {
    const { sessions, orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    sessions[0]!.turnIds.push('first-turn', 'second-turn', 'third-turn')

    await expect(orchestrator.submitTurn(thread.id, 'first')).resolves.toMatchObject({
      queued: false,
    })
    await expect(orchestrator.submitTurn(thread.id, 'second')).resolves.toMatchObject({
      queued: true,
    })
    await expect(orchestrator.submitTurn(thread.id, 'third')).resolves.toMatchObject({
      queued: true,
    })
    expect(orchestrator.queue(thread.id).items.map((item) => item.text)).toEqual([
      'second',
      'third',
    ])

    sessions[0]!.emit({
      type: 'turn.completed',
      turnId: 'first-turn',
      status: 'completed',
    })
    await vi.waitFor(() => expect(sessions[0]!.sent).toEqual(['first', 'second']))
    expect(orchestrator.queue(thread.id).items.map((item) => item.text)).toEqual(['third'])

    sessions[0]!.emit({
      type: 'turn.completed',
      turnId: 'second-turn',
      status: 'completed',
    })
    await vi.waitFor(() => expect(sessions[0]!.sent).toEqual(['first', 'second', 'third']))
    expect(orchestrator.queue(thread.id).items).toEqual([])
  })

  it('stays idle when a queued turn completes before sendTurn returns', async () => {
    const { sessions, orchestrator, store } = harness()
    try {
      const thread = await orchestrator.startThread('codex', '/repo')
      const session = sessions[0]!
      session.turnIds.push('first-turn', 'queued-turn')
      await orchestrator.submitTurn(thread.id, 'first')
      await orchestrator.submitTurn(thread.id, 'queued')
      session.release = () => {}

      session.emit({ type: 'turn.completed', turnId: 'first-turn', status: 'completed' })
      await vi.waitFor(() => expect(session.sent).toEqual(['first', 'queued']))
      session.emit(turnStarted(thread.id, 'queued-turn'))
      session.emit({ type: 'turn.completed', turnId: 'queued-turn', status: 'completed' })
      session.emit(message('Website built.', 'queued-turn'))
      session.release?.()

      await vi.waitFor(() => expect(orchestrator.queue(thread.id).items).toEqual([]))
      await vi.waitFor(() => expect(orchestrator.isTurnRunning(thread.id)).toBe(false))
      expect(reduceEventLog(emptyThread, store.history(thread.id)).running).toBe(false)
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('drains the next prompt when a queued turn completes before sendTurn returns', async () => {
    const { sessions, orchestrator, store } = harness()
    try {
      const thread = await orchestrator.startThread('codex', '/repo')
      const session = sessions[0]!
      session.turnIds.push('first-turn', 'second-turn', 'third-turn')
      await orchestrator.submitTurn(thread.id, 'first', [], {}, 'submission-first')
      await orchestrator.submitTurn(thread.id, 'second', [], {}, 'submission-second')
      await orchestrator.submitTurn(thread.id, 'third', [], {}, 'submission-third')
      session.release = () => {}

      session.emit({ type: 'turn.completed', turnId: 'first-turn', status: 'completed' })
      await vi.waitFor(() => expect(session.sent).toEqual(['first', 'second']))
      session.emit(turnStarted(thread.id, 'second-turn'))
      session.emit({ type: 'turn.completed', turnId: 'second-turn', status: 'completed' })
      const releaseSecond = session.release
      session.release = undefined
      releaseSecond?.()

      await vi.waitFor(() => expect(session.sent).toEqual(['first', 'second', 'third']))
      await vi.waitFor(() => expect(orchestrator.queue(thread.id).items).toEqual([]))
      expect(store.queuedTurns(thread.id)).toEqual([])
      expect(orchestrator.isTurnRunning(thread.id)).toBe(true)
      expect(store.hasUserSubmission(thread.id, 'submission-third')).toBe(true)
    } finally {
      await orchestrator.disposeAll()
      store.close()
    }
  })

  it('drains a queued prompt when a direct send completes before sendTurn returns', async () => {
    const { sessions, orchestrator, store } = harness()
    try {
      const thread = await orchestrator.startThread('codex', '/repo')
      const session = sessions[0]!
      session.turnIds.push('first-turn', 'second-turn')
      session.release = () => {}
      const first = orchestrator.submitTurn(thread.id, 'first')
      await vi.waitFor(() => expect(session.sent).toEqual(['first']))
      await expect(orchestrator.submitTurn(thread.id, 'second')).resolves.toMatchObject({
        queued: true,
      })

      session.emit(turnStarted(thread.id, 'first-turn'))
      session.emit({ type: 'turn.completed', turnId: 'first-turn', status: 'completed' })
      const releaseFirst = session.release
      session.release = undefined
      releaseFirst?.()
      await first

      await vi.waitFor(() => expect(session.sent).toEqual(['first', 'second']))
      expect(orchestrator.queue(thread.id).items).toEqual([])
    } finally {
      await orchestrator.disposeAll()
      store.close()
    }
  })

  it('keeps a queued prompt when claiming it fails and does not crash the drain', async () => {
    const { sessions, orchestrator, store } = harness()
    try {
      const thread = await orchestrator.startThread('codex', '/repo')
      const session = sessions[0]!
      session.turnIds.push('first-turn', 'second-turn')
      await orchestrator.submitTurn(thread.id, 'first')
      await orchestrator.submitTurn(thread.id, 'second')
      const claim = vi.spyOn(store, 'claimQueuedTurn').mockImplementationOnce(() => {
        throw new Error('database is locked')
      })

      session.emit({ type: 'turn.completed', turnId: 'first-turn', status: 'completed' })
      await vi.waitFor(() => expect(claim).toHaveBeenCalled())
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(session.sent).toEqual(['first'])
      expect(store.queuedTurns(thread.id).map((turn) => turn.text)).toEqual(['second'])
    } finally {
      await orchestrator.disposeAll()
      store.close()
    }
  })

  it('leaves later prompts queued when a dispatch reports only a thread error', async () => {
    const { sessions, orchestrator, store } = harness()
    try {
      const thread = await orchestrator.startThread('codex', '/repo')
      const session = sessions[0]!
      session.turnIds.push('first-turn', 'second-turn', 'third-turn')
      await orchestrator.submitTurn(thread.id, 'first')
      await orchestrator.submitTurn(thread.id, 'second')
      await orchestrator.submitTurn(thread.id, 'third')
      session.eventDuringSend = {
        type: 'thread.error',
        threadId: thread.id,
        message: 'Provider disconnected',
      }

      session.emit({ type: 'turn.completed', turnId: 'first-turn', status: 'completed' })
      await vi.waitFor(() => expect(session.sent).toEqual(['first', 'second']))
      await vi.waitFor(() => expect(orchestrator.isTurnRunning(thread.id)).toBe(false))

      expect(orchestrator.queue(thread.id).items.map((item) => item.text)).toEqual(['third'])
      expect(store.queuedTurns(thread.id).map((item) => item.text)).toEqual(['third'])
    } finally {
      await orchestrator.disposeAll()
      store.close()
    }
  })

  it('can remove a queued prompt or steer it into the running turn', async () => {
    const { sessions, orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'first')
    await orchestrator.submitTurn(thread.id, 'remove me')
    const steer = await orchestrator.submitTurn(thread.id, 'steer with this')
    if (!steer.queued) throw new Error('expected the prompt to queue')

    const remove = orchestrator.queue(thread.id).items[0]!
    orchestrator.deleteQueuedTurn(thread.id, remove.id)
    await orchestrator.steerQueuedTurn(thread.id, steer.queuedTurn.id)

    expect(sessions[0]!.steered).toEqual(['steer with this'])
    expect(orchestrator.queue(thread.id).items).toEqual([])
  })

  it('does not send an accepted steer again when its turn finishes before the acknowledgement', async () => {
    const { sessions, orchestrator, store } = harness()
    try {
      const thread = await orchestrator.startThread('codex', '/repo')
      const session = sessions[0]!
      await orchestrator.submitTurn(thread.id, 'running')
      session.emit(turnStarted(thread.id, 'active-turn'))
      const queued = await orchestrator.submitTurn(thread.id, 'steer me', [], {}, 'steer-id')
      if (!queued.queued) throw new Error('expected the prompt to queue')
      let release = () => {}
      session.steerBarriers.push(new Promise<void>((resolve) => (release = resolve)))
      const steering = orchestrator.steerQueuedTurn(thread.id, queued.queuedTurn.id)
      await vi.waitFor(() => expect(session.steered).toEqual(['steer me']))

      session.emit({ type: 'turn.completed', turnId: 'active-turn', status: 'completed' })
      release()
      await steering
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(session.sent).toEqual(['running'])
      expect(orchestrator.queue(thread.id).items).toEqual([])
      expect(store.queuedTurns(thread.id)).toEqual([])
      expect(store.hasUserSubmission(thread.id, 'steer-id')).toBe(true)
    } finally {
      await orchestrator.disposeAll()
      store.close()
    }
  })

  it.each(['resolve', 'reject'] as const)(
    'does not restore a steered prompt after Stop all when steering %s',
    async (outcome) => {
      const { orchestrator, sessions, store } = harness()
      try {
        const thread = await orchestrator.startThread('codex', '/repo')
        const session = sessions[0]!
        await orchestrator.submitTurn(thread.id, 'running')
        const queued = await orchestrator.submitTurn(thread.id, 'old prompt', [], {}, 'old')
        if (!queued.queued) throw new Error('expected queued prompt')
        let resolve: () => void = () => {}
        let reject: (error: Error) => void = () => {}
        session.steerBarriers.push(
          new Promise<void>((yes, no) => {
            resolve = yes
            reject = no
          }),
        )
        const steering = orchestrator.steerQueuedTurn(thread.id, queued.queuedTurn.id)
        const settled =
          outcome === 'reject'
            ? expect(steering).rejects.toThrow('steer disconnected')
            : expect(steering).resolves.toBeUndefined()

        await orchestrator.panicStop()
        session.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'interrupted' })
        if (outcome === 'reject') reject(new Error('steer disconnected'))
        else resolve()
        await settled

        expect(orchestrator.queue(thread.id).items).toEqual([])
        expect(store.queuedTurns(thread.id)).toEqual([])
        await expect(orchestrator.submitTurn(thread.id, 'new prompt')).resolves.toMatchObject({
          queued: false,
        })
        expect(session.sent).toEqual(['running', 'new prompt'])
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    },
  )

  it.each(['dispatched', 'steered'] as const)(
    'hands back a prompt being %s when its project is removed',
    async (claim) => {
      const { orchestrator, sessions, store } = harness()
      const project = '/repo'
      try {
        store.addProject(project)
        const thread = await orchestrator.startThread('codex', project)
        const session = sessions[0]!
        await orchestrator.submitTurn(thread.id, 'running', [], {}, 'running')
        session.emit(turnStarted(thread.id, 's1-turn'))
        const queued = await orchestrator.submitTurn(thread.id, 'next', [], {}, 'next')
        if (!queued.queued) throw new Error('expected the prompt to queue')
        // Claim the prompt and hold it before the agent has accepted it.
        let release = () => {}
        let claimed: Promise<void>
        if (claim === 'dispatched') {
          session.release = () => {}
          session.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
          await vi.waitFor(() => expect(session.sent).toEqual(['running', 'next']))
          release = () => session.release?.()
          claimed = Promise.resolve()
        } else {
          session.steerBarriers.push(new Promise<void>((resolve) => (release = resolve)))
          claimed = orchestrator.steerQueuedTurn(thread.id, queued.queuedTurn.id)
          await vi.waitFor(() => expect(session.steered).toEqual(['next']))
        }

        // What projects.remove does.
        await Promise.all(store.threads(project).map((t) => orchestrator.stopThread(t.id)))
        orchestrator.forgetProject(project)
        store.removeProject(project)
        release()
        await claimed
        await new Promise<void>((resolve) => setImmediate(resolve))
        store.addProject(project)

        expect(orchestrator.queue(thread.id).items.map((item) => item.text)).toEqual(['next'])
        expect(store.queuedThreadIds().has(thread.id)).toBe(true)
      } finally {
        await orchestrator.disposeAll()
        store.close()
      }
    },
  )

  it('restores a failed steer from durable state after its empty queue cache was evicted', async () => {
    const { orchestrator, sessions, store } = harness()
    try {
      const thread = await orchestrator.startThread('codex', '/repo')
      const session = sessions[0]!
      await orchestrator.submitTurn(thread.id, 'running')
      const queued = await orchestrator.submitTurn(thread.id, 'A', [], {}, 'a')
      if (!queued.queued) throw new Error('expected queued prompt')
      let reject: (error: Error) => void = () => {}
      session.steerBarriers.push(new Promise<void>((_resolve, no) => (reject = no)))
      const steering = orchestrator.steerQueuedTurn(thread.id, queued.queuedTurn.id)
      const rejected = expect(steering).rejects.toThrow('steer disconnected')

      for (let index = 0; index < 256; index += 1) orchestrator.queue(`cold-${index}`)
      await orchestrator.submitTurn(thread.id, 'B', [], {}, 'b')
      reject(new Error('steer disconnected'))
      await rejected

      expect(orchestrator.queue(thread.id).items.map((item) => item.text)).toEqual(['A', 'B'])
      expect(store.queuedTurns(thread.id).map((item) => item.text)).toEqual(['A', 'B'])
    } finally {
      await orchestrator.disposeAll()
      store.close()
    }
  })

  it('moves a queued prompt without changing its contents', async () => {
    const { orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.submitTurn(thread.id, 'running')
    await orchestrator.submitTurn(thread.id, 'first queued')
    const second = await orchestrator.submitTurn(thread.id, 'second queued', ['/reference.png'])
    if (!second.queued) throw new Error('expected the prompt to queue')

    orchestrator.moveQueuedTurn(thread.id, second.queuedTurn.id, 'up')

    expect(orchestrator.queue(thread.id).items.map((item) => item.text)).toEqual([
      'second queued',
      'first queued',
    ])
    expect(orchestrator.queue(thread.id).items[0]?.attachments).toEqual(['/reference.png'])
  })
})

// Real Git worktrees, checkpoints and restores can exceed 20 s on loaded Windows runners.
describe('isolated sessions', { timeout: 60_000 }, () => {
  let fixtureRepo: string
  let repo: string
  let trees: string

  // Copy a pristine repository per test instead of repeating five Git setup commands.
  beforeAll(() => {
    fixtureRepo = mkdtempSync(path.join(os.tmpdir(), 'harness-orch-fixture-'))
    execFileSync('git', ['init', '-b', 'main', fixtureRepo], { windowsHide: true })
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: fixtureRepo, windowsHide: true })
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    // As in gitRepositoryTemplate: no gc or maintenance left running in the
    // background after the commit, writing in .git/objects while a test copies
    // the repository (ENOENT on .git/objects in cpSync, twice on macOS).
    git('config', 'gc.auto', '0')
    git('config', 'gc.autoDetach', 'false')
    git('config', 'maintenance.auto', 'false')
    writeFileSync(path.join(fixtureRepo, 'file.txt'), 'original\n')
    git('add', '.')
    git('commit', '-m', 'first')
  }, 60_000)

  afterAll(() => {
    rmSync(fixtureRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  beforeEach(() => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'harness-orch-'))
    repo = path.join(base, 'repo')
    trees = path.join(base, 'trees')
    cpSync(fixtureRepo, repo, { recursive: true })
  })

  afterEach(() => {
    rmSync(path.dirname(repo), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('places new private checkouts in the configured durable data directory', async () => {
    vi.stubEnv('HARNESS_DATA_DIR', path.join(path.dirname(repo), 'data'))
    vi.stubEnv('HARNESS_WORKTREE_DIR', '')
    const { orchestrator, store } = harness()
    try {
      const thread = await orchestrator.startThread('codex', repo, { isolate: true })
      expect(path.dirname(store.thread(thread.id)!.worktreePath!)).toBe(
        path.join(path.dirname(repo), 'data', 'trees'),
      )
    } finally {
      vi.unstubAllEnvs()
      await orchestrator.disposeAll()
    }
  })

  it('starts an isolated nested project in its folder and discards the whole checkout', async () => {
    const nested = path.join(repo, 'apps', 'web')
    mkdirSync(nested, { recursive: true })
    writeFileSync(path.join(nested, 'index.ts'), 'export {}\n')
    execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['commit', '-m', 'nested'], { cwd: repo, windowsHide: true })
    const { orchestrator, store, startedIn } = harness(trees)
    try {
      const thread = await orchestrator.startThread('codex', nested, { isolate: true })
      const workPath = store.thread(thread.id)!.worktreePath!
      const checkout = path.dirname(path.dirname(workPath))

      expect(path.relative(checkout, workPath)).toBe(path.join('apps', 'web'))
      expect(startedIn.at(-1)).toBe(workPath)
      expect(existsSync(path.join(workPath, 'index.ts'))).toBe(true)

      await orchestrator.discardWorktree(thread.id)
      expect(existsSync(checkout)).toBe(false)
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('keeps uncommitted work when a nested project folder was deleted from its checkout', async () => {
    const nested = path.join(repo, 'apps', 'web')
    mkdirSync(nested, { recursive: true })
    writeFileSync(path.join(nested, 'index.ts'), 'export {}\n')
    execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['commit', '-m', 'nested'], { cwd: repo, windowsHide: true })
    const { orchestrator, store } = harness(trees)
    try {
      const thread = await orchestrator.startThread('codex', nested, { isolate: true })
      const workPath = store.thread(thread.id)!.worktreePath!
      const checkout = path.dirname(path.dirname(workPath))
      writeFileSync(path.join(checkout, 'file.txt'), 'agent work\n')
      rmSync(workPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

      expect(await orchestrator.hasUnsavedWork(thread.id)).toBe(true)
      await expect(orchestrator.discardWorktree(thread.id)).rejects.toThrow(/uncommitted/i)
      expect(readFileSync(path.join(checkout, 'file.txt'), 'utf8')).toBe('agent work\n')
      expect(store.thread(thread.id)?.worktreePath).toBe(workPath)

      await orchestrator.discardWorktree(thread.id, true)
      expect(existsSync(checkout)).toBe(false)
      expect(store.thread(thread.id)?.worktreePath).toBeUndefined()
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('forgets a fully deleted nested checkout without inspecting a repository above it', async () => {
    const host = path.join(path.dirname(repo), 'host')
    execFileSync('git', ['init', '-b', 'main', host], { windowsHide: true })
    writeFileSync(path.join(host, 'notes.txt'), 'unrelated work\n')
    const nested = path.join(repo, 'apps', 'web')
    mkdirSync(nested, { recursive: true })
    writeFileSync(path.join(nested, 'index.ts'), 'export {}\n')
    execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['commit', '-m', 'nested'], { cwd: repo, windowsHide: true })
    const { orchestrator, store } = harness(path.join(host, 'trees'))
    try {
      const thread = await orchestrator.startThread('codex', nested, { isolate: true })
      const workPath = store.thread(thread.id)!.worktreePath!
      rmSync(path.dirname(path.dirname(workPath)), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      })

      expect(await orchestrator.hasUnsavedWork(thread.id)).toBe(false)
      await orchestrator.discardWorktree(thread.id)
      expect(store.thread(thread.id)?.worktreePath).toBeUndefined()
      expect(readFileSync(path.join(host, 'notes.txt'), 'utf8')).toBe('unrelated work\n')
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('cleans a private checkout when MCP credential resolution fails before provider startup', async () => {
    const { orchestrator, store, credentialFailure } = harness(trees)
    orchestrator.addMcpServer('codex', repo, {
      id: 'docs',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: { source: 'credential', credentialRef: 'mcp/docs/auth' } },
      },
    })
    credentialFailure.current = new Error('Credential unavailable')
    await expect(orchestrator.startThread('codex', repo, { isolate: true })).rejects.toThrow(
      'Credential unavailable',
    )
    expect(store.threads()).toEqual([])
    expect(existsSync(trees) ? readdirSync(trees) : []).toEqual([])
    const branches = execFileSync('git', ['branch', '--list'], { cwd: repo, encoding: 'utf8' })
    expect(branches.trim()).toBe('* main')
    await orchestrator.disposeAll()
  })

  it('keeps Side chat checkpoints and restore guards in the parent private checkout', async () => {
    const { orchestrator, sessions, store } = harness(trees)
    const parent = await orchestrator.startThread('codex', repo, { isolate: true })
    await orchestrator.submitTurn(parent.id, 'Main question', [], {}, 'main-question')
    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    const side = await orchestrator.startSideThread(parent.id)
    const checkout = store.thread(parent.id)!.worktreePath!
    expect(store.thread(side.id)?.worktreePath).toBe(checkout)
    writeFileSync(path.join(checkout, 'file.txt'), 'private state\n')
    await orchestrator.sendTurn(side.id, 'temporary task')
    expect(orchestrator.checkpoints(side.id)).toHaveLength(1)
    await expect(orchestrator.switchBranch(checkout, 'main')).rejects.toThrow(/still working/)
    sessions[1]!.emit({ type: 'turn.completed', turnId: 's2-turn', status: 'completed' })
    await orchestrator.closeSideThread(side.id)
    expect(existsSync(checkout)).toBe(true)
    expect(readFileSync(path.join(checkout, 'file.txt'), 'utf8')).toBe('private state\n')
    await orchestrator.disposeAll()
  })

  it('does not discard a checkout that another chat opened as its project', async () => {
    const { orchestrator, store } = harness(trees)
    const owner = await orchestrator.startThread('codex', repo, { isolate: true })
    const checkout = store.thread(owner.id)!.worktreePath!
    await orchestrator.startThread('codex', checkout)
    await expect(orchestrator.discardWorktree(owner.id, true)).rejects.toThrow(
      /another project or chat/,
    )
    expect(existsSync(path.join(checkout, 'file.txt'))).toBe(true)
    await orchestrator.disposeAll()
  })

  it('rejects late starts after project removal without re-adding the project', async () => {
    const { orchestrator, store, startBarriers, startedIn, sessions } = harness(trees)
    store.addProject(repo)
    let release!: () => void
    startBarriers.push(new Promise<void>((resolve) => (release = resolve)))
    const starting = orchestrator.startThread('codex', repo)
    const rejected = expect(starting).rejects.toThrow(/cancelled/)
    await vi.waitFor(() => expect(startedIn).toHaveLength(1))
    orchestrator.forgetProject(repo)
    store.removeProject(repo)
    release()
    await rejected
    expect(store.project(repo)).toBeUndefined()
    expect(sessions[0]?.disposed).toBe(true)
    await orchestrator.disposeAll()
  })

  it('retains checkout guards until an agent that refused Stop has ended', async () => {
    const { orchestrator, sessions } = harness(trees)
    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.submitTurn(thread.id, 'running')
    const session = sessions[0]!
    session.interruptError = new Error('Stop failed')
    let ended!: () => void
    session.disposeBarrier = new Promise<void>((resolve) => (ended = resolve))
    // The chat shows the turn stopped at once, so the agent that refused is ended.
    const stopping = orchestrator.interrupt(thread.id)
    await vi.waitFor(() => expect(session.disposed).toBe(true))
    expect(orchestrator.isTurnRunning(thread.id)).toBe(false)
    await expect(orchestrator.switchBranch(repo, 'main')).rejects.toThrow(/still working/)
    ended()
    await expect(stopping).resolves.toBeUndefined()
    await orchestrator.disposeAll()
  })

  it('sends restore context once without adding it to the visible prompt', async () => {
    const { orchestrator, sessions, store } = harness(trees)
    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.submitTurn(thread.id, 'initial')
    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    const point = orchestrator.checkpoints(thread.id)[0]!
    await orchestrator.restoreCheckpoint(thread.id, point.id)
    await orchestrator.submitTurn(thread.id, 'after restore')
    expect(sessions[0]!.sent.at(-1)).toContain('Your provider memory may still include turns')
    expect(text(store.history(thread.id))).toEqual(['after restore'])
    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    await orchestrator.submitTurn(thread.id, 'next')
    expect(sessions[0]!.sent.at(-1)).toBe('next')
    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    const { undo } = await orchestrator.restoreCheckpoint(thread.id, point.id)
    await orchestrator.undoRestore(thread.id, undo)
    await orchestrator.submitTurn(thread.id, 'after undo')
    expect(sessions[0]!.sent.at(-1)).toContain('Your provider memory may still include turns')
    await orchestrator.disposeAll()
  })

  it('keeps pending restore context across a server restart', async () => {
    const store = new Store(':memory:')
    const first = harness(trees, store)
    const thread = await first.orchestrator.startThread('codex', repo)
    await first.orchestrator.submitTurn(thread.id, 'initial')
    first.sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    const point = first.orchestrator.checkpoints(thread.id)[0]!
    await first.orchestrator.restoreCheckpoint(thread.id, point.id)
    await first.orchestrator.disposeAll()
    expect(store.threadNeedsRestoreContext(thread.id)).toBe(true)

    const second = harness(trees, store)
    await second.orchestrator.submitTurn(thread.id, 'after restart')
    expect(second.sessions[0]!.sent.at(-1)).toContain(
      'Your provider memory may still include turns',
    )
    expect(store.threadNeedsRestoreContext(thread.id)).toBe(false)
    second.sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    await second.orchestrator.submitTurn(thread.id, 'next')
    expect(second.sessions[0]!.sent.at(-1)).toBe('next')
    await second.orchestrator.disposeAll()
  })

  it('rejects deleting a queued prompt that already started or was removed', async () => {
    const { orchestrator, store } = harness(trees)
    const thread = await orchestrator.startThread('codex', repo)
    expect(() => orchestrator.deleteQueuedTurn(thread.id, 'missing')).toThrow(
      'That queued prompt already started or was removed.',
    )
    await orchestrator.submitTurn(thread.id, 'running')
    const queued = await orchestrator.submitTurn(thread.id, 'queued')
    if (!queued.queued) throw new Error('expected the second prompt to queue')
    vi.spyOn(store, 'deleteQueuedTurn').mockReturnValueOnce(false)
    expect(() => orchestrator.deleteQueuedTurn(thread.id, queued.queuedTurn.id)).toThrow(
      'That queued prompt already started or was removed.',
    )
    expect(orchestrator.queue(thread.id).items.map(({ id }) => id)).toEqual([queued.queuedTurn.id])
    await orchestrator.disposeAll()
  })

  it('refuses diff rejection while another chat is working in the same checkout', async () => {
    const { orchestrator, store } = harness(trees)
    const owner = await orchestrator.startThread('codex', repo, { isolate: true })
    const checkout = store.thread(owner.id)!.worktreePath!
    writeFileSync(path.join(checkout, 'file.txt'), 'agent work\n')
    const diff = await orchestrator.diff(owner.id)
    const file = diff.files[0]!
    const borrower = await orchestrator.startThread('codex', checkout)
    await orchestrator.submitTurn(borrower.id, 'keep editing')

    await expect(
      orchestrator.reviewHunk(owner.id, diff.version, file.path, file.hunks[0]!.id, 'reject'),
    ).rejects.toThrow(/still working in this folder/)
    expect(readFileSync(path.join(checkout, 'file.txt'), 'utf8')).toBe('agent work\n')
    await orchestrator.disposeAll()
  })

  it('runs the agent in its own checkout, not in the project folder', async () => {
    const { startedIn, orchestrator } = harness(trees)

    await orchestrator.startThread('codex', repo, { isolate: true })

    expect(startedIn[0]).not.toBe(repo)
    expect(existsSync(path.join(startedIn[0]!, 'file.txt'))).toBe(true)
  })

  it('still records the project as the repository the user chose', async () => {
    const { store, orchestrator } = harness(trees)

    const thread = await orchestrator.startThread('codex', repo, { isolate: true })

    // The private checkout is where the work happens; it is not what the
    // session belongs to.
    expect(store.thread(thread.id)?.projectPath).toBe(repo)
    expect(store.thread(thread.id)?.worktreePath).toBe(startedInOf(store, thread.id))
  })

  it('runs in the project folder itself when isolation was not asked for', async () => {
    const { startedIn, store, orchestrator } = harness(trees)

    const thread = await orchestrator.startThread('codex', repo)

    expect(startedIn[0]).toBe(repo)
    expect(store.thread(thread.id)?.worktreePath).toBeUndefined()
  })

  it('refuses diff review in a shared project checkout', async () => {
    const { orchestrator } = harness(trees)
    const thread = await orchestrator.startThread('codex', repo)

    // The Edited files card matches this text to show the turn's patch instead.
    await expect(orchestrator.diff(thread.id)).rejects.toThrow('requires an isolated session')
  })

  it('does not reject work while the agent turn is running', async () => {
    const { store, orchestrator } = harness(trees)
    const thread = await orchestrator.startThread('codex', repo, { isolate: true })
    const worktree = store.thread(thread.id)!.worktreePath!
    writeFileSync(path.join(worktree, 'file.txt'), 'agent work\n')
    const diff = await orchestrator.diff(thread.id)
    const file = diff.files[0]!

    await orchestrator.submitTurn(thread.id, 'keep working')

    await expect(
      orchestrator.reviewHunk(thread.id, diff.version, file.path, file.hunks[0]!.id, 'reject'),
    ).rejects.toThrow(/turn is running/)
    expect(readFileSync(path.join(worktree, 'file.txt'), 'utf8')).toBe('agent work\n')
  })

  it('refuses to discard a checkout holding work nobody has committed', async () => {
    const { store, orchestrator } = harness(trees)

    const thread = await orchestrator.startThread('codex', repo, { isolate: true })
    writeFileSync(path.join(store.thread(thread.id)!.worktreePath!, 'file.txt'), 'agent work\n')

    await expect(orchestrator.discardWorktree(thread.id)).rejects.toThrow(/uncommitted/i)
    // Refusing has to actually leave it there.
    expect(existsSync(store.thread(thread.id)!.worktreePath!)).toBe(true)
  })

  it('stops a live agent before discarding its checkout', async () => {
    const { store, orchestrator, sessions } = harness(trees)
    const thread = await orchestrator.startThread('codex', repo, { isolate: true })
    const worktreePath = store.thread(thread.id)!.worktreePath!

    await orchestrator.discardWorktree(thread.id)

    expect(sessions[0]!.disposed).toBe(true)
    expect(store.thread(thread.id)?.closedAt).toBeTypeOf('number')
    expect(existsSync(worktreePath)).toBe(false)
  })

  it('keeps the checkout when its agent fails to stop', async () => {
    const { store, orchestrator, sessions } = harness(trees)
    const thread = await orchestrator.startThread('codex', repo, { isolate: true })
    const worktreePath = store.thread(thread.id)!.worktreePath!
    sessions[0]!.disposeBarrier = Promise.reject(new Error('agent did not exit'))
    sessions[0]!.disposeBarrier.catch(() => undefined)

    await expect(orchestrator.discardWorktree(thread.id, true)).rejects.toThrow(
      'agent did not exit',
    )

    expect(existsSync(worktreePath)).toBe(true)
    expect(store.thread(thread.id)?.worktreePath).toBe(worktreePath)
  })

  it('refuses to discard a checkout while its agent is working', async () => {
    const { store, orchestrator, sessions } = harness(trees)
    const thread = await orchestrator.startThread('codex', repo, { isolate: true })
    const worktreePath = store.thread(thread.id)!.worktreePath!
    await orchestrator.submitTurn(thread.id, 'keep working')

    await expect(orchestrator.discardWorktree(thread.id, true)).rejects.toThrow(/still working/)

    expect(sessions[0]!.disposed).toBe(false)
    expect(existsSync(worktreePath)).toBe(true)
  })

  it('waits for the checkout terminal to exit before discarding its worktree', async () => {
    const { store, orchestrator } = harness(trees)
    const thread = await orchestrator.startThread('codex', repo, { isolate: true })
    const worktreePath = store.thread(thread.id)!.worktreePath!

    orchestrator.openTerminal(thread.id, 80, 24)
    await orchestrator.discardWorktree(thread.id)

    expect(existsSync(worktreePath)).toBe(false)
  })

  it('closing a session leaves its checkout alone', async () => {
    const { store, orchestrator } = harness(trees)

    const thread = await orchestrator.startThread('codex', repo, { isolate: true })
    const worktreePath = store.thread(thread.id)!.worktreePath!

    orchestrator.close(thread.id)

    // Closing ends the process. It says nothing about the work in there.
    expect(existsSync(worktreePath)).toBe(true)
  })

  it('prunes missing checkouts without resuming their chats in the main project', async () => {
    const { store, orchestrator, resumedIn } = harness(trees)
    try {
      const gone = await orchestrator.startThread('codex', repo, { isolate: true })
      const alive = await orchestrator.startThread('codex', repo, { isolate: true })
      const missingPath = store.thread(gone.id)!.worktreePath!
      rmSync(missingPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      await orchestrator.disposeAll()

      await orchestrator.recoverWorktrees()

      expect(store.thread(gone.id)?.worktreePath).toBe(missingPath)
      expect(store.thread(alive.id)?.worktreePath).toBeDefined()
      const registered = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repo,
        encoding: 'utf8',
        windowsHide: true,
      })
      expect(registered).not.toContain(path.basename(missingPath))
      await expect(orchestrator.submitTurn(gone.id, 'continue')).rejects.toThrow(
        'The private checkout for this chat is missing',
      )
      expect(resumedIn).toEqual([])
    } finally {
      await orchestrator.disposeAll()
      store.close()
    }
  })

  it('leaves nothing behind when the agent fails to start', async () => {
    const store = new Store(':memory:')
    const orchestrator = new Orchestrator(store, {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
      worktreeRoot: trees,
      runtimeFor: () => ({
        async start() {
          throw new Error('binary not found')
        },
        async listModels() {
          return []
        },
      }),
    })

    await expect(orchestrator.startThread('codex', repo, { isolate: true })).rejects.toThrow(
      /binary not found/,
    )

    // A checkout for a session that never started is litter, and the next
    // attempt would trip over it.
    expect(existsSync(trees) ? readdirSync(trees) : []).toEqual([])
  })
})

describe('rolling a session back', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'harness-cp-orch-'))
    execFileSync('git', ['init', '-b', 'main', repo], { windowsHide: true })
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true })
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    git('config', 'core.autocrlf', 'false')
    writeFileSync(path.join(repo, 'file.txt'), 'original\n')
    git('add', '.')
    git('commit', '-m', 'first')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('takes a checkpoint before the agent writes, not after', async () => {
    const { orchestrator } = harness()

    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'change the file')

    // A checkpoint taken afterwards would record the damage rather than the
    // state worth returning to.
    const checkpoints = orchestrator.checkpoints(thread.id)
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]?.label).toBe('change the file')
  })

  it('stores a checkpoint label that stops before an emoji split at 60 code units', async () => {
    const { orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'y'.repeat(59) + '🌊 reply with ok')
    expect(orchestrator.checkpoints(thread.id)[0]?.label).toBe(`${'y'.repeat(59)}…`)
  })

  it('stores an ascii checkpoint label cut at 60 code units', async () => {
    const { orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'b'.repeat(80))
    expect(orchestrator.checkpoints(thread.id)[0]?.label).toBe(`${'b'.repeat(60)}…`)
  })

  it('stores an end-trimmed ellipsis for a long prompt and the prompt itself when it is short', async () => {
    const { orchestrator } = harness()
    const longThread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(longThread.id, `${'word '.repeat(12)}more`)
    const nested = path.join(repo, 'nested')
    mkdirSync(nested)
    const shortThread = await orchestrator.startThread('codex', nested)
    await orchestrator.sendTurn(shortThread.id, 'keep this short')
    expect(orchestrator.checkpoints(longThread.id)[0]?.label).toBe(
      'word word word word word word word word word word word word…',
    )
    expect(orchestrator.checkpoints(shortThread.id)[0]?.label).toBe('keep this short')
  })

  it('refuses restore through another task while the shared checkout is busy', async () => {
    const { orchestrator, sessions } = harness()
    const first = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(first.id, 'save original')
    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    const point = orchestrator.checkpoints(first.id)[0]!
    const nested = path.join(repo, 'nested')
    mkdirSync(nested)
    const second = await orchestrator.startThread('codex', nested)
    sessions[1]!.turnIds.push('busy-turn')
    await orchestrator.sendTurn(second.id, 'working')
    await expect(orchestrator.restoreCheckpoint(first.id, point.id)).rejects.toThrow(
      /Chats are still working in this folder/,
    )
    sessions[1]!.emit(turnStarted(second.id, 'busy-turn'))
    writeFileSync(path.join(repo, 'file.txt'), 'second task work\n')
    await expect(orchestrator.restoreCheckpoint(first.id, point.id)).rejects.toThrow(
      /Chats are still working in this folder/,
    )
    await expect(orchestrator.undoRestore(first.id, 'old-token')).rejects.toThrow(
      /Chats are still working in this folder/,
    )
    await expect(orchestrator.undoTurnChanges(first.id, 'turn', 'patch')).rejects.toThrow(
      /Chats are still working in this folder/,
    )
    await expect(orchestrator.switchBranch(repo, 'main')).rejects.toThrow(
      /Chats are still working in this folder/,
    )
    expect(readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('second task work\n')
    sessions[1]!.emit({ type: 'turn.completed', turnId: 'busy-turn', status: 'completed' })
    await orchestrator.restoreCheckpoint(first.id, point.id)
    expect(readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('original\n')
    await orchestrator.disposeAll()
  })

  it('releases the shared checkout when a start with the old Design marker throws before the agent accepts it', async () => {
    const { orchestrator, sessions } = harness()
    try {
      const first = await orchestrator.startThread('codex', repo)
      await orchestrator.sendTurn(first.id, 'save original')
      sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
      const point = orchestrator.checkpoints(first.id)[0]!
      const designer = await orchestrator.startThread('codex', repo)
      sessions[1]!.sendTurn = () => {
        throw new Error('provider failed before returning a promise')
      }

      await expect(
        orchestrator.sendTurn(designer.id, 'Build a site.', [DESIGN_BRIEF_ATTACHMENT]),
      ).rejects.toThrow('provider failed before returning a promise')

      // A start that never reached the agent must not keep the chat "starting"
      // or hold the checkout that restores in other chats need.
      expect(orchestrator.isTurnRunning(designer.id)).toBe(false)
      writeFileSync(path.join(repo, 'file.txt'), 'changed\n')
      await orchestrator.restoreCheckpoint(first.id, point.id)
      expect(readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('original\n')
    } finally {
      await orchestrator.disposeAll()
    }
  })

  it('builds the turn diff from its checkpoint when the agent reports none, and undoes it', async () => {
    const { orchestrator, sessions, store } = harness()
    const thread = await orchestrator.startThread('claude-code', repo)
    sessions[0]!.turnIds.push('turn-1')
    await orchestrator.sendTurn(thread.id, 'change the file and add one')
    sessions[0]!.emit(turnStarted(thread.id, 'turn-1'))
    writeFileSync(path.join(repo, 'file.txt'), 'agent change\n')
    writeFileSync(path.join(repo, 'added.txt'), 'new file\n')
    sessions[0]!.emit(fileEdit('file.txt', 'turn-1'))
    // Claude Code names files by absolute path.
    sessions[0]!.emit(fileEdit(path.join(repo, 'added.txt'), 'turn-1'))
    sessions[0]!.emit(message('Done.', 'turn-1'))
    sessions[0]!.emit({ type: 'turn.completed', turnId: 'turn-1', status: 'completed' })

    await vi.waitFor(() => expect(store.turnDiff(thread.id, 'turn-1')).toBeTruthy(), {
      timeout: 15_000,
    })
    const diff = store.turnDiff(thread.id, 'turn-1')!
    expect(diff).toContain('diff --git a/file.txt b/file.txt')
    expect(diff).toContain('+agent change')
    expect(diff).toContain('diff --git a/added.txt b/added.txt')

    await orchestrator.undoTurnChanges(thread.id, 'turn-1', diff)
    expect(readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('original\n')
    expect(existsSync(path.join(repo, 'added.txt'))).toBe(false)
    await orchestrator.disposeAll()
  })

  it('keeps files the agent did not report out of a turn diff built from its checkpoint', async () => {
    const { orchestrator, sessions, store } = harness()
    const thread = await orchestrator.startThread('claude-code', repo)
    sessions[0]!.turnIds.push('turn-1')
    await orchestrator.sendTurn(thread.id, 'change the file')
    sessions[0]!.emit(turnStarted(thread.id, 'turn-1'))
    writeFileSync(path.join(repo, 'file.txt'), 'agent change\n')
    sessions[0]!.emit(fileEdit('file.txt', 'turn-1'))
    // Meanwhile the user edits another file, and a command rewrites a third.
    writeFileSync(path.join(repo, 'notes.txt'), 'user work\n')
    writeFileSync(path.join(repo, 'formatted.txt'), 'from a formatter\n')
    sessions[0]!.emit({
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        turnId: 'turn-1',
        type: 'command',
        status: 'completed',
        command: 'npx prettier --write .',
        createdAt: 0,
      },
    })
    sessions[0]!.emit({ type: 'turn.completed', turnId: 'turn-1', status: 'completed' })

    await vi.waitFor(() => expect(store.turnDiff(thread.id, 'turn-1')).toBeTruthy(), {
      timeout: 15_000,
    })
    const diff = store.turnDiff(thread.id, 'turn-1')!
    expect(diff).toContain('diff --git a/file.txt b/file.txt')
    expect(diff).not.toContain('notes.txt')
    expect(diff).not.toContain('formatted.txt')

    await orchestrator.undoTurnChanges(thread.id, 'turn-1', diff)
    expect(readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('original\n')
    expect(readFileSync(path.join(repo, 'notes.txt'), 'utf8')).toBe('user work\n')
    await orchestrator.disposeAll()
  })

  it("keeps an agent's own turn diff", async () => {
    const { orchestrator, sessions, store } = harness()
    const thread = await orchestrator.startThread('claude-code', repo)
    sessions[0]!.turnIds.push('turn-1')
    await orchestrator.sendTurn(thread.id, 'change the file')
    sessions[0]!.emit(turnStarted(thread.id, 'turn-1'))
    writeFileSync(path.join(repo, 'file.txt'), 'agent change\n')
    sessions[0]!.emit(fileEdit('file.txt', 'turn-1'))
    sessions[0]!.emit({ type: 'diff.updated', turnId: 'turn-1', diff: 'agent patch' })
    sessions[0]!.emit({ type: 'turn.completed', turnId: 'turn-1', status: 'completed' })

    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(store.turnDiff(thread.id, 'turn-1')).toBe('agent patch')
    await orchestrator.disposeAll()
  })

  it('takes no second snapshot after a turn that ran no command and changed no file', async () => {
    const { orchestrator, sessions, store } = harness()
    const thread = await orchestrator.startThread('claude-code', repo)
    sessions[0]!.turnIds.push('turn-1')
    await orchestrator.sendTurn(thread.id, 'only answer')
    sessions[0]!.emit(turnStarted(thread.id, 'turn-1'))
    writeFileSync(path.join(repo, 'unrelated.txt'), 'user work\n')
    sessions[0]!.emit(message('An answer.', 'turn-1'))
    sessions[0]!.emit({ type: 'turn.completed', turnId: 'turn-1', status: 'completed' })

    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(store.turnDiff(thread.id, 'turn-1')).toBeUndefined()
    await orchestrator.disposeAll()
  })

  it('takes no second snapshot for an agent that reports its turn diffs itself', async () => {
    const { orchestrator, sessions, store } = harness()
    const thread = await orchestrator.startThread('codex', repo)
    sessions[0]!.turnIds.push('turn-1')
    await orchestrator.sendTurn(thread.id, 'only answer')
    sessions[0]!.emit(turnStarted(thread.id, 'turn-1'))
    writeFileSync(path.join(repo, 'unrelated.txt'), 'user work\n')
    sessions[0]!.emit(fileEdit('unrelated.txt', 'turn-1'))
    sessions[0]!.emit({ type: 'turn.completed', turnId: 'turn-1', status: 'completed' })

    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(store.turnDiff(thread.id, 'turn-1')).toBeUndefined()
    await orchestrator.disposeAll()
  })

  it('builds no turn diff when another chat worked in the same checkout', async () => {
    const { orchestrator, sessions, store } = harness()
    const first = await orchestrator.startThread('claude-code', repo)
    const second = await orchestrator.startThread('claude-code', repo)
    sessions[0]!.turnIds.push('turn-1')
    sessions[1]!.turnIds.push('turn-2')
    await orchestrator.sendTurn(first.id, 'change the file')
    sessions[0]!.emit(turnStarted(first.id, 'turn-1'))
    await orchestrator.sendTurn(second.id, 'add a file')
    sessions[1]!.emit(turnStarted(second.id, 'turn-2'))
    writeFileSync(path.join(repo, 'file.txt'), 'first chat\n')
    writeFileSync(path.join(repo, 'added.txt'), 'second chat\n')
    sessions[0]!.emit(fileEdit('file.txt', 'turn-1'))
    sessions[1]!.emit(fileEdit('added.txt', 'turn-2'))
    sessions[1]!.emit({ type: 'turn.completed', turnId: 'turn-2', status: 'completed' })
    sessions[0]!.emit({ type: 'turn.completed', turnId: 'turn-1', status: 'completed' })

    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(store.turnDiff(first.id, 'turn-1')).toBeUndefined()
    expect(store.turnDiff(second.id, 'turn-2')).toBeUndefined()
    await orchestrator.disposeAll()
  })

  it('undoes only the patch from an edit block and keeps the conversation', async () => {
    const { orchestrator, sessions, store } = harness()
    const thread = await orchestrator.startThread('codex', repo)
    sessions[0]!.turnIds.push('turn-1')
    await orchestrator.sendTurn(thread.id, 'change one file')
    sessions[0]!.emit(turnStarted(thread.id, 'turn-1'))

    writeFileSync(path.join(repo, 'file.txt'), 'agent change\n')
    const relative = execFileSync('git', ['diff', '--binary', '--no-color', '--', 'file.txt'], {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
    })
    const root = repo.replaceAll('\\', '/')
    // In one pass: a second replace would also rewrite the `b/file.txt` at the end of a
    // temporary folder whose random name ends in "b" (one run in 62).
    const absolute = relative.replaceAll(
      /([ab])\/file\.txt/g,
      (_match, side: string) => `${side}/${root}/file.txt`,
    )
    sessions[0]!.emit({ type: 'diff.updated', turnId: 'turn-1', diff: absolute })
    sessions[0]!.emit(message('Done with the requested edit.', 'turn-1'))
    sessions[0]!.emit({ type: 'turn.completed', turnId: 'turn-1', status: 'completed' })
    writeFileSync(path.join(repo, 'unrelated.txt'), 'user work\n')

    await orchestrator.undoTurnChanges(thread.id, 'turn-1', absolute)

    expect(readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('original\n')
    expect(readFileSync(path.join(repo, 'unrelated.txt'), 'utf8')).toBe('user work\n')
    expect(text(store.history(thread.id))).toEqual(['Done with the requested edit.'])
    expect(store.turnDiff(thread.id, 'turn-1')).toBe('')
  })

  it('puts the files back and drops the conversation that described them', async () => {
    const { sessions, store, orchestrator } = harness()

    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'first task')
    sessions[0]!.emit(message('did the first thing'))
    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })

    await orchestrator.sendTurn(thread.id, 'second task')
    writeFileSync(path.join(repo, 'file.txt'), 'the agent went the wrong way\n')
    sessions[0]!.emit(message('did the wrong thing'))
    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })

    const second = orchestrator.checkpoints(thread.id)[1]!
    await orchestrator.restoreCheckpoint(thread.id, second.id)

    expect(readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('original\n')
    // Leaving the transcript would have it describing work that is gone.
    const texts = store
      .history(thread.id)
      .map((e) => (e.event.type === 'item.completed' ? e.event.item.text : undefined))
      .filter(Boolean)
    expect(texts).toEqual(['did the first thing'])
  })

  it('restores files and conversation when a restore is undone', async () => {
    const { orchestrator, sessions, store } = harness()

    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'a task')
    writeFileSync(path.join(repo, 'file.txt'), 'work the user might want\n')
    sessions[0]!.emit(message('work the user might want'))
    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })

    const first = orchestrator.checkpoints(thread.id)[0]!
    const { undo } = await orchestrator.restoreCheckpoint(thread.id, first.id)

    expect(readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('original\n')
    expect(store.history(thread.id)).toEqual([])

    await orchestrator.undoRestore(thread.id, undo)

    expect(readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('work the user might want\n')
    expect(text(store.history(thread.id))).toEqual(['work the user might want'])
    await expect(orchestrator.undoRestore(thread.id, undo)).rejects.toThrow(
      'restore can no longer be undone',
    )
  })

  it('names what changed since a checkpoint', async () => {
    const { orchestrator } = harness()

    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'a task')
    writeFileSync(path.join(repo, 'file.txt'), 'changed\n')
    writeFileSync(path.join(repo, 'new.txt'), 'added\n')

    const first = orchestrator.checkpoints(thread.id)[0]!
    const files = await orchestrator.changedSinceCheckpoint(thread.id, first.id)
    expect(files.sort()).toEqual(['file.txt', 'new.txt'])
  })

  it('rejects inspection of a missing checkpoint', async () => {
    const { orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', repo)

    await expect(orchestrator.changedSinceCheckpoint(thread.id, 404)).rejects.toThrow(
      'no such checkpoint',
    )
  })

  it('refuses to restore while the agent is still writing', async () => {
    const { orchestrator, sessions } = harness()

    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'a task')
    sessions[0]!.emit({
      type: 'turn.started',
      turn: { id: 'turn-1', threadId: thread.id, status: 'running', createdAt: 0 },
    })

    const checkpoint = orchestrator.checkpoints(thread.id)[0]!
    await expect(orchestrator.restoreCheckpoint(thread.id, checkpoint.id)).rejects.toThrow(
      'cannot restore during a running turn',
    )
  })

  it('refuses to restore while a turn is still taking its checkpoint', async () => {
    const { orchestrator } = harness()
    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'first task')
    const first = orchestrator.checkpoints(thread.id)[0]!

    let release = (_value: checkpoint.Snapshot) => {}
    vi.spyOn(checkpoint, 'takeSnapshot').mockReturnValueOnce(
      new Promise<checkpoint.Snapshot>((resolve) => (release = resolve)),
    )
    const sending = orchestrator.sendTurn(thread.id, 'second task')
    await vi.waitFor(() => expect(orchestrator.isTurnRunning(thread.id)).toBe(true))

    try {
      await expect(orchestrator.restoreCheckpoint(thread.id, first.id)).rejects.toThrow(
        'cannot restore during a running turn',
      )
    } finally {
      release({ commit: 'checkpoint', clean: true })
      await sending
    }
  })

  it('refuses to undo a restore while a turn is still taking its checkpoint', async () => {
    const { orchestrator, sessions } = harness()
    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'first task')
    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    writeFileSync(path.join(repo, 'file.txt'), 'work to restore later\n')
    const first = orchestrator.checkpoints(thread.id)[0]!
    const { undo } = await orchestrator.restoreCheckpoint(thread.id, first.id)

    let release = (_value: checkpoint.Snapshot) => {}
    vi.spyOn(checkpoint, 'takeSnapshot').mockReturnValueOnce(
      new Promise<checkpoint.Snapshot>((resolve) => (release = resolve)),
    )
    const sending = orchestrator.sendTurn(thread.id, 'second task')
    await vi.waitFor(() => expect(orchestrator.isTurnRunning(thread.id)).toBe(true))

    try {
      await expect(orchestrator.undoRestore(thread.id, undo)).rejects.toThrow(
        'cannot restore during a running turn',
      )
    } finally {
      release({ commit: 'checkpoint', clean: true })
      await sending
    }
  })

  it('refuses a second restore while the first restore is still in progress', async () => {
    const { orchestrator, sessions } = harness()
    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'first task')
    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    const first = orchestrator.checkpoints(thread.id)[0]!

    let release = (_value: checkpoint.Snapshot) => {}
    const restoringSnapshot = new Promise<checkpoint.Snapshot>((resolve) => (release = resolve))
    const restoreSnapshot = vi
      .spyOn(checkpoint, 'restoreSnapshot')
      .mockClear()
      .mockReturnValueOnce(restoringSnapshot)
    const restoring = orchestrator.restoreCheckpoint(thread.id, first.id)
    await vi.waitFor(() => expect(restoreSnapshot).toHaveBeenCalledTimes(1))

    const history = Promise.resolve(orchestrator.history(thread.id))
    let historySettled = false
    void history.then(() => (historySettled = true))
    try {
      await new Promise((resolve) => setImmediate(resolve))
      expect(historySettled).toBe(false)
      await expect(orchestrator.restoreCheckpoint(thread.id, first.id)).rejects.toThrow(
        'cannot restore while another restore is running',
      )
    } finally {
      release({ commit: first.commit, clean: false })
      await restoring
    }
    expect(await history).toEqual([])
  })

  it('refuses a new turn while a checkpoint restore is still in progress', async () => {
    const { orchestrator, sessions } = harness()
    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'first task')
    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    const first = orchestrator.checkpoints(thread.id)[0]!

    let release = (_value: checkpoint.Snapshot) => {}
    const restoringSnapshot = new Promise<checkpoint.Snapshot>((resolve) => (release = resolve))
    const restoreSnapshot = vi
      .spyOn(checkpoint, 'restoreSnapshot')
      .mockClear()
      .mockReturnValueOnce(restoringSnapshot)
    const restoring = orchestrator.restoreCheckpoint(thread.id, first.id)
    await vi.waitFor(() => expect(restoreSnapshot).toHaveBeenCalledTimes(1))

    try {
      await expect(orchestrator.sendTurn(thread.id, 'too soon')).rejects.toThrow(
        'cannot start a turn while restoring a checkpoint',
      )
      expect(sessions[0]!.sent).toEqual(['first task'])
    } finally {
      release({ commit: first.commit, clean: false })
      await restoring
    }
  })

  // Real Git worktrees, a checkpoint and a held rejection: ~5.7 s on a loaded Windows laptop.
  it('refuses restore and undo while a diff rejection is still in progress', async () => {
    const trees = path.join(path.dirname(repo), 'trees')
    const { orchestrator, store, sessions } = harness(trees)
    const thread = await orchestrator.startThread('codex', repo, { isolate: true })
    const worktree = store.thread(thread.id)!.worktreePath!
    await orchestrator.sendTurn(thread.id, 'first task')
    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    writeFileSync(path.join(worktree, 'file.txt'), 'work to restore later\n')
    const first = orchestrator.checkpoints(thread.id)[0]!
    const { undo } = await orchestrator.restoreCheckpoint(thread.id, first.id)

    writeFileSync(path.join(worktree, 'file.txt'), 'reject this change\n')
    const diff = await orchestrator.diff(thread.id)
    const file = diff.files[0]!
    const heldSnapshot = await checkpoint.takeSnapshot(worktree)
    let release = (_value: checkpoint.Snapshot) => {}
    const takeSnapshot = vi
      .spyOn(checkpoint, 'takeSnapshot')
      .mockClear()
      .mockReturnValueOnce(new Promise<checkpoint.Snapshot>((resolve) => (release = resolve)))
    const reviewing = orchestrator.reviewHunk(
      thread.id,
      diff.version,
      file.path,
      file.hunks[0]!.id,
      'reject',
    )
    await vi.waitFor(() => expect(takeSnapshot).toHaveBeenCalledTimes(1))

    try {
      await expect(orchestrator.restoreCheckpoint(thread.id, first.id)).rejects.toThrow(
        'cannot restore while a diff rejection is running',
      )
      await expect(orchestrator.undoRestore(thread.id, undo)).rejects.toThrow(
        'cannot restore while a diff rejection is running',
      )
    } finally {
      release(heldSnapshot)
      await reviewing.catch(() => undefined)
    }
  }, 60_000)

  it('keeps the original files as a recovery checkpoint when restore and rollback both fail', async () => {
    const { orchestrator, sessions } = harness()
    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'first task')
    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    const first = orchestrator.checkpoints(thread.id)[0]!
    vi.spyOn(checkpoint, 'restoreSnapshot').mockRejectedValueOnce(
      new checkpoint.RestoreSnapshotError({ commit: 'original-files', clean: false }, [
        new Error('restore failed'),
        new Error('rollback failed'),
      ]),
    )

    await expect(orchestrator.restoreCheckpoint(thread.id, first.id)).rejects.toThrow(
      /Recovery: original files before failed restore/,
    )
    expect(orchestrator.checkpoints(thread.id).at(-1)).toMatchObject({
      commit: 'original-files',
      label: 'Recovery: original files before failed restore',
    })
  })

  it('refuses hunk and file rejection while a checkpoint restore is still in progress', async () => {
    const { orchestrator, sessions } = harness()
    const thread = await orchestrator.startThread('codex', repo)
    await orchestrator.sendTurn(thread.id, 'first task')
    sessions[0]!.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    const first = orchestrator.checkpoints(thread.id)[0]!

    let release = (_value: checkpoint.Snapshot) => {}
    const restoreSnapshot = vi
      .spyOn(checkpoint, 'restoreSnapshot')
      .mockClear()
      .mockReturnValueOnce(new Promise<checkpoint.Snapshot>((resolve) => (release = resolve)))
    const restoring = orchestrator.restoreCheckpoint(thread.id, first.id)
    await vi.waitFor(() => expect(restoreSnapshot).toHaveBeenCalledTimes(1))

    try {
      await expect(
        orchestrator.reviewHunk(thread.id, 'version', 'file.txt', 'hunk', 'reject'),
      ).rejects.toThrow('Refresh the diff and try again.')
      await expect(
        orchestrator.reviewFile(thread.id, 'version', 'file.txt', 'reject'),
      ).rejects.toThrow('Refresh the diff and try again.')
    } finally {
      release({ commit: first.commit, clean: false })
      await restoring
    }
  })

  it('does not fail a turn just because the folder is not a repository', async () => {
    const { orchestrator } = harness()
    const plain = mkdtempSync(path.join(os.tmpdir(), 'harness-plain-'))

    const thread = await orchestrator.startThread('codex', plain)
    // A backup the user never asked for must not be able to block their work.
    await expect(orchestrator.sendTurn(thread.id, 'a task')).resolves.toBeDefined()
    expect(orchestrator.checkpoints(thread.id)).toEqual([])

    rmSync(plain, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
})

function startedInOf(store: Store, threadId: string): string | undefined {
  return store.thread(threadId)?.worktreePath
}

function text(entries: Array<{ event: DomainEvent }>): Array<string | undefined> {
  return entries
    .filter((entry) => entry.event.type === 'item.completed')
    .map((entry) => (entry.event.type === 'item.completed' ? entry.event.item.text : undefined))
}

describe('overnight race pins', () => {
  it('ignores late events after the task row was deleted', async () => {
    const { orchestrator, sessions, store } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    await orchestrator.close(thread.id)
    store.deleteThread(thread.id)
    orchestrator.forgetDeletedThread(thread.id)
    expect(() =>
      sessions[0]!.emit({ type: 'thread.error', threadId: thread.id, message: 'late event' }),
    ).not.toThrow()
    expect(store.history(thread.id)).toEqual([])
    await orchestrator.disposeAll()
  })

  it('stops a running turn when its chat is deleted, and its later output stays out', async () => {
    const { orchestrator, sessions, store } = harness()
    const thread = await orchestrator.startThread('claude-code', '/repo')
    await orchestrator.submitTurn(thread.id, 'running')
    expect(orchestrator.isTurnRunning(thread.id)).toBe(true)
    const savedSession = store.thread(thread.id)!.providerSessionId ?? thread.id
    // The order thread.delete runs in.
    await orchestrator.close(thread.id)
    store.deleteThread(thread.id, { keepSessionOut: true })
    orchestrator.forgetDeletedThread(thread.id)
    expect(sessions[0]!.disposed).toBe(true)
    expect(orchestrator.isTurnRunning(thread.id)).toBe(false)
    sessions[0]!.emit({
      type: 'item.completed',
      item: {
        id: 'late',
        turnId: 'late-turn',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        text: 'late answer',
        createdAt: Date.now(),
      },
    })
    expect(store.thread(thread.id)).toBeUndefined()
    expect(store.history(thread.id)).toEqual([])
    expect(store.leftProviderSessions('claude-code')).toEqual([savedSession])
    await orchestrator.disposeAll()
  })

  it('waits for a pending provider start before panic reports success', async () => {
    const { orchestrator, sessions } = harness()
    const thread = await orchestrator.startThread('codex', '/repo')
    const session = sessions[0]!
    session.release = () => {}
    const sending = orchestrator.sendTurn(thread.id, 'pending model change')
    const failed = expect(sending).rejects.toThrow(/panic stop/)
    await vi.waitFor(() => expect(session.sent).toHaveLength(1))
    let stopped = false
    const panic = orchestrator.panicStop().then((result) => {
      stopped = true
      return result
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(session.interrupted).toBe(false)
    session.release?.()
    await failed
    await expect(panic).resolves.toMatchObject({ sessions: [{ status: 'interrupted' }] })
    expect(session.interrupted).toBe(true)
    await orchestrator.disposeAll()
  })

  it('disposes a resume that lands after the thread was closed', async () => {
    const store = new Store(':memory:')
    store.addProject('/repo')
    store.addThread({ id: 'thread-1', projectPath: '/repo', provider: 'codex', title: 'T' })
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const session = new FakeSession('s1')
    const orchestrator = new Orchestrator(store, {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
      mcpConfig: temporaryMcpConfig(),
      readCredential: () => '',
      runtimeFor: () => ({
        async start() {
          throw new Error('start is not under test')
        },
        async listModels() {
          return []
        },
        async resume(threadId: string, workspacePath: string) {
          await barrier
          return {
            thread: { id: threadId, provider: 'codex' as const, workspacePath, createdAt: 1 },
            session,
          }
        },
      }),
    })

    const resuming = orchestrator.submitTurn('thread-1', 'hello')
    resuming.catch(() => undefined)
    // Let the resume begin, close the thread underneath it, then let the
    // provider "answer".
    await new Promise((resolve) => setTimeout(resolve, 0))
    orchestrator.close('thread-1')
    store.deleteThread('thread-1')
    orchestrator.forgetDeletedThread('thread-1')
    release()

    await expect(resuming).rejects.toThrow(/closed while resuming/)
    // The late session must be disposed, never attached as a zombie.
    expect(session.disposed).toBe(true)
  })
})

describe('panic versus an in-flight queue drain', () => {
  it('a drain that already grabbed a prompt cannot start it after panic', async () => {
    const { orchestrator, sessions, store } = harness()
    store.addProject('/repo')
    const thread = await orchestrator.startThread('codex', '/repo')
    const session = sessions[0]!

    // Turn A active, turn B queued behind it.
    await orchestrator.submitTurn(thread.id, 'turn A')
    const queued = await orchestrator.submitTurn(thread.id, 'turn B')
    expect(queued.queued).toBe(true)

    // Hold the next sendTurn open, then complete A so the drain grabs B and
    // blocks inside the adapter call.
    session.release = () => {}
    session.emit({ type: 'turn.completed', turnId: 's1-turn', status: 'completed' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const panic = orchestrator.panicStop()
    session.release?.()
    await panic
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The panicked drain must not leave turn B running or re-queued.
    expect(orchestrator.inboxStatus(thread.id)).not.toBe('working')
    expect(orchestrator.queue(thread.id).items).toEqual([])
  })
})
