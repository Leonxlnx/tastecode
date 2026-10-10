import type { ClaudeCodeAdapter } from '@harness/adapter-claude-code'
import type { GrokAdapter } from '@harness/adapter-grok'
import type {
  ApprovalDecision,
  ApprovalMode,
  Capabilities,
  CustomHarness,
  CustomHarnessVerification,
  CustomHarnessVerificationCheck,
  DomainEvent,
  McpServer,
  McpServerConfig,
  Model,
  ProviderContextSettings,
  ProviderId,
  Thread,
} from '@harness/contracts'
import {
  actionableLaunchError,
  customHarnessSpawn,
  resolveCustomHarnessLaunch,
  runCustomHarness,
} from './custom-harness-launch.js'
import { retryableLazy } from './retryable-lazy.js'
import { mapProviderSession, StartupCleanupError } from './provider-session.js'

// Grok speaks ACP when a project has MCP servers; there is no ACP provider.
const loadAcpAdapter = retryableLazy(() => import('@harness/adapter-acp'))
const loadClaudeAdapter = retryableLazy(() => import('@harness/adapter-claude-code'))
const loadCodexAdapter = retryableLazy(() => import('@harness/adapter-codex'))
const loadGrokAdapter = retryableLazy(() => import('@harness/adapter-grok'))

/**
 * One shape every engine is driven through.
 *
 * The orchestrator above this never learns which provider it is talking to.
 * That is the whole point of the layer: adding an engine is a new case here,
 * not a change to session handling, and capabilities tell the UI what to hide
 * rather than letting it guess.
 */
export type StartOptions = {
  instructions?: string | undefined
  model?: string | undefined
  serviceTier?: string | undefined
  effort?: string | undefined
  approval?: ApprovalMode | undefined
  /** User-owned custom harness to launch instead of the provider's own CLI. */
  agent?: string | undefined
  /** Provider-owned history should not retain product-internal background work. */
  ephemeral?: boolean | undefined
  /**
   * Run this session in a private git worktree rather than in the project
   * folder itself, so two agents cannot overwrite each other.
   */
  isolate?: boolean | undefined
  baseRef?: string | undefined
  /** The user's context settings, already narrowed to what this engine declared. */
  context?: ProviderContextSettings | undefined
  /** Internal project overrides and their already-resolved OS credentials. */
  mcpServers?: McpServerConfig[] | undefined
  mcpCredentials?: Record<string, string> | undefined
  /**
   * Server-owned, opaque provider resume identity. It is intentionally
   * separate from the stable TasteCode thread id passed to `resume`.
   */
  providerSessionId?: string | undefined
}

export type TurnOptions = Pick<StartOptions, 'model' | 'serviceTier' | 'effort'>

export interface AgentSession {
  readonly capabilities: Capabilities
  sendTurn(
    threadId: string,
    text: string,
    attachments?: string[],
    options?: TurnOptions,
  ): Promise<string>
  steer?(threadId: string, text: string, attachments?: string[]): Promise<void>
  interrupt(threadId: string): Promise<void>
  listMcpServers?(threadId?: string): Promise<McpServer[]>
  reloadMcpServers?(
    threadId: string,
    servers: McpServerConfig[],
    credentials: Record<string, string>,
  ): Promise<void>
  startMcpOAuth?(serverId: string, threadId: string): Promise<{ loginId: string; authUrl: string }>
  onMcpOAuth?(
    listener: (result: {
      serverId: string
      loginId: string
      success: boolean
      error: string | null
    }) => void,
  ): void
  /** Provider-owned subscription usage changed; the server should refetch. */
  onUsageChanged?(listener: () => void): void
  /** Provider MCP discovery changed; the project inventory should be refreshed. */
  onMcpChanged?(listener: () => void): (() => void) | void
  /**
   * False when the live session negotiated no way to reload it, so releasing an
   * idle runtime would lose it. Absent means the runtime's `resume` decides.
   */
  readonly resumable?: boolean
  /** The session cannot accept more work; its terminal events have already been emitted. */
  onDisconnected?(listener: () => void): () => void
  /** Provider reported or rotated the opaque identity needed after a restart. */
  onProviderSessionId?(listener: (providerSessionId: string) => void): void
  respondToApproval(approvalId: string, decision: ApprovalDecision): void
  respondToUserInput?(requestId: string, answers: Record<string, string[]>): void
  /**
   * Apply an access-level change to the attached session, at least for its
   * next turn. An already running turn may retain its launch policy.
   * Sessions without this method must be replaced before their next turn.
   */
  setApproval?(approval: ApprovalMode): void | Promise<void>
  dispose(): void | Promise<void>
  on(event: 'event', listener: (event: DomainEvent) => void): void
  on(event: 'log', listener: (line: string) => void): void
}

export type ProviderRuntime = {
  start(
    workspacePath: string,
    options: StartOptions,
  ): Promise<{ thread: Thread; session: AgentSession }>
  resume?(
    threadId: string,
    workspacePath: string,
    options: StartOptions,
  ): Promise<{ thread: Thread; session: AgentSession }>
  listModels(agent?: string): Promise<Model[]>
}

export function providerRuntime(
  provider: ProviderId,
  onLog: (line: string) => void,
  resolveHarness: (id: string) => CustomHarness | undefined = () => undefined,
): ProviderRuntime {
  switch (provider) {
    case 'codex':
      return codexRuntime(onLog, resolveHarness)
    case 'claude-code':
      return claudeRuntime(onLog, resolveHarness)
    case 'grok':
      return grokRuntime(onLog, resolveHarness)
    default:
      throw new Error(`provider "${provider}" is not implemented yet`)
  }
}

function harnessFor(
  provider: ProviderId,
  id: string | undefined,
  resolveHarness: (id: string) => CustomHarness | undefined,
): CustomHarness | undefined {
  if (!id) return undefined
  const harness = resolveHarness(id)
  // A non-empty source is a persisted custom harness and must fail loudly if
  // it was removed.
  if (!harness) throw new Error(`custom harness "${id}" no longer exists`)
  if (harness.provider !== provider) {
    throw new Error(`custom harness "${harness.displayName}" is configured for ${harness.provider}`)
  }
  return harness
}

const CUSTOM_HARNESS_PROTOCOL_LABELS = {
  codex: 'Codex app-server',
  'claude-code': 'Claude Code stream JSON',
  grok: 'Grok streaming JSON',
} satisfies Record<CustomHarness['provider'], string>

/**
 * Side-effect-bounded compatibility check. Native integrations complete a
 * real handshake; one-shot CLIs run only their free discovery/help command,
 * never a model prompt.
 */
export async function verifyCustomHarness(
  harness: CustomHarness,
  workspacePath = process.cwd(),
  onLog: (line: string) => void = () => {},
): Promise<CustomHarnessVerification> {
  const checks: CustomHarnessVerificationCheck[] = []
  const checkedAt = Date.now()
  let resolvedCommand: string | undefined
  try {
    const launch = resolveCustomHarnessLaunch(harness, workspacePath)
    resolvedCommand = launch.command
    checks.push({
      label: 'Executable',
      status: 'passed',
      detail: `Resolved ${harness.command} to ${launch.command}`,
    })
    checks.push({
      label: 'Launch context',
      status: 'passed',
      detail:
        launch.cwd === launch.workspacePath
          ? `Runs in the active workspace at ${launch.workspacePath}`
          : `Boots in ${launch.cwd}; active workspace is exported as HARNESS_WORKSPACE_PATH`,
    })
  } catch (cause) {
    const error = actionableLaunchError(harness, cause)
    checks.push({ label: 'Executable', status: 'failed', detail: error.message })
    return {
      status: 'error',
      summary: `${harness.displayName} cannot start`,
      checkedAt,
      checks,
    }
  }

  try {
    const protocol = await probeCustomHarnessProtocol(harness, workspacePath, onLog)
    checks.push(protocol)
    return {
      status: protocol.status === 'warning' ? 'warning' : 'ready',
      summary:
        protocol.status === 'warning'
          ? `${harness.displayName} launches, with a compatibility warning`
          : `${harness.displayName} is compatible`,
      checkedAt,
      ...(resolvedCommand ? { resolvedCommand } : {}),
      checks,
    }
  } catch (cause) {
    const error = actionableLaunchError(harness, cause)
    checks.push({
      label: CUSTOM_HARNESS_PROTOCOL_LABELS[harness.provider],
      status: 'failed',
      detail: error.message,
    })
    return {
      status: 'error',
      summary: `${harness.displayName} did not pass its protocol check`,
      checkedAt,
      ...(resolvedCommand ? { resolvedCommand } : {}),
      checks,
    }
  }
}

async function probeCustomHarnessProtocol(
  harness: CustomHarness,
  workspacePath: string,
  onLog: (line: string) => void,
): Promise<CustomHarnessVerificationCheck> {
  const spawn = customHarnessSpawn(harness, workspacePath)
  const label = CUSTOM_HARNESS_PROTOCOL_LABELS[harness.provider]
  switch (harness.provider) {
    case 'codex': {
      const { CodexAdapter } = await loadCodexAdapter()
      const adapter = new CodexAdapter({ spawn })
      adapter.on('log', onLog)
      try {
        await customHarnessDeadline(harness, 'initialize', adapter.start())
        return { label, status: 'passed', detail: 'Initialize handshake completed.' }
      } finally {
        await adapter.dispose()
      }
    }
    case 'claude-code': {
      const result = await runCustomHarness(harness, workspacePath, ['--help'])
      const advertisesStreaming = /stream-json/i.test(result.stdout)
      return {
        label,
        status: advertisesStreaming ? 'passed' : 'warning',
        detail: advertisesStreaming
          ? 'The CLI advertises the stream-json transport TasteCode uses.'
          : 'The CLI runs, but its help does not advertise stream-json; the first turn may still fail.',
      }
    }
    case 'grok': {
      const { GrokAdapter } = await loadGrokAdapter()
      const adapter = new GrokAdapter({ spawn })
      adapter.on('log', onLog)
      try {
        const models = await customHarnessDeadline(harness, 'list models', adapter.listModels())
        return modelProbeCheck(label, models, 'Streaming CLI model command responded')
      } finally {
        await adapter.dispose()
      }
    }
  }
}

function modelProbeCheck(
  label: string,
  models: Model[],
  success: string,
): CustomHarnessVerificationCheck {
  return models.length > 0
    ? { label, status: 'passed', detail: `${success}; found ${models.length} model(s).` }
    : {
        label,
        status: 'warning',
        detail: `${success}, but no models were reported. TasteCode will use the provider default.`,
      }
}

function customHarnessDeadline<T>(
  harness: CustomHarness,
  phase: string,
  operation: Promise<T>,
  timeoutMs = 25_000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${harness.displayName} timed out while trying to ${phase}`)),
      timeoutMs,
    )
  })
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function customHarnessOperation<T>(
  harness: CustomHarness,
  phase: string,
  operation: Promise<T>,
): Promise<T> {
  try {
    return await customHarnessDeadline(harness, phase, operation)
  } catch (cause) {
    const error = actionableLaunchError(harness, cause)
    throw new Error(`${harness.displayName} could not ${phase}: ${error.message}`)
  }
}

async function startedSession<TSession extends { dispose(): void | Promise<void> }>(
  session: TSession,
  start: () => Promise<Thread>,
): Promise<{ thread: Thread; session: TSession }> {
  try {
    return { thread: await start(), session }
  } catch (error) {
    try {
      await session.dispose()
    } catch (cleanup) {
      throw new StartupCleanupError(error, cleanup, session)
    }
    throw error
  }
}

function grokRuntime(
  onLog: (line: string) => void,
  resolveHarness: (id: string) => CustomHarness | undefined,
): ProviderRuntime {
  const acpAdapterFor = async (harness: CustomHarness | undefined, options: StartOptions) => {
    const [{ AcpAdapter, prepareAcpMcpServers }, { grokCommand, grokContextEnvironment }] =
      await Promise.all([loadAcpAdapter(), loadGrokAdapter()])
    return new AcpAdapter('grok', {
      name: harness?.displayName ?? 'Grok',
      command: grokCommand(),
      // Grok takes model and effort only as launch switches; the adapter
      // relaunches and reloads the session when a turn changes them.
      argsFor: ({ model, effort }) => [
        'agent',
        ...(model ? ['--model', model] : []),
        ...(effort ? ['--reasoning-effort', effort] : []),
        'stdio',
      ],
      settings: { model: options.model, effort: options.effort },
      provider: 'grok',
      mcpServers: prepareAcpMcpServers(options.mcpServers ?? [], options.mcpCredentials ?? {}),
      env: grokContextEnvironment(options.context),
      ...(harness ? { spawn: customHarnessSpawn(harness) } : {}),
    })
  }

  const printSessionFor = (adapter: GrokAdapter): AgentSession => ({
    capabilities: adapter.capabilities,
    sendTurn: (threadId, text, attachments, turnOptions) =>
      adapter.sendTurn(threadId, text, attachments, turnOptions),
    interrupt: () => adapter.interrupt(),
    // Print mode decides permissions from the launch switches; there is no
    // mid-turn callback to answer.
    respondToApproval: () => {},
    setApproval: (approval) => adapter.setApproval(approval),
    onProviderSessionId: (listener) => {
      adapter.on('providerSessionId', listener)
      // The UUID is chosen at startThread, before this listener exists.
      // Replay it so the server can persist resume identity before the first
      // turn ends — Stop otherwise leaves no native id to continue.
      if (adapter.providerSessionId) listener(adapter.providerSessionId)
    },
    dispose: () => adapter.dispose(),
    on: (event: 'event' | 'log', listener: never) => adapter.on(event, listener),
  })

  return {
    async start(workspacePath, options) {
      const harness = harnessFor('grok', options.agent, resolveHarness)
      const projectMcp = options.mcpServers?.some((server) => server.enabled) ?? false
      if (projectMcp) {
        const adapter = await acpAdapterFor(harness, options)
        adapter.on('log', onLog)
        return startedSession(adapter, async () => {
          const starting = adapter.startThread(workspacePath, {
            model: options.model,
            approval: options.approval,
            instructions: options.instructions,
          })
          return harness
            ? await customHarnessOperation(harness, 'start an MCP-enabled ACP session', starting)
            : await starting
        })
      }
      const { GrokAdapter } = await loadGrokAdapter()
      const adapter = new GrokAdapter(harness ? { spawn: customHarnessSpawn(harness) } : {})
      adapter.on('log', onLog)
      const thread = await adapter.startThread(workspacePath, {
        model: options.model,
        effort: options.effort,
        approval: options.approval,
        instructions: options.instructions,
        context: options.context,
        ...(options.ephemeral ? { ephemeral: true } : {}),
      })
      return { thread, session: printSessionFor(adapter) }
    },
    async resume(threadId, workspacePath, options) {
      const harness = harnessFor('grok', options.agent, resolveHarness)
      // MCP-enabled Grok runs over ACP. Its provider session id is already
      // encoded in the stable `acp-grok-*` thread id, and AcpAdapter performs
      // the protocol capability check before loading it.
      if (threadId.startsWith('acp-grok-')) {
        const adapter = await acpAdapterFor(harness, options)
        adapter.on('log', onLog)
        return startedSession(adapter, async () => {
          const resuming = adapter.resumeThread(threadId, workspacePath, {
            model: options.model,
            approval: options.approval,
            instructions: options.instructions,
          })
          return harness
            ? await customHarnessOperation(harness, 'resume an MCP-enabled ACP session', resuming)
            : await resuming
        })
      }
      if (!options.providerSessionId) {
        throw new Error(
          'This Grok chat cannot resume because TasteCode restarted before Grok returned a native session id. Start a new Grok chat; the local history of this chat is still available.',
        )
      }
      const { GrokAdapter } = await loadGrokAdapter()
      const adapter = new GrokAdapter(harness ? { spawn: customHarnessSpawn(harness) } : {})
      adapter.on('log', onLog)
      const thread = await adapter.resumeThread(
        threadId,
        options.providerSessionId,
        workspacePath,
        {
          model: options.model,
          effort: options.effort,
          approval: options.approval,
          instructions: options.instructions,
          context: options.context,
          ...(options.ephemeral ? { ephemeral: true } : {}),
        },
      )
      return { thread, session: printSessionFor(adapter) }
    },
    async listModels(agent) {
      const harness = harnessFor('grok', agent, resolveHarness)
      const { GrokAdapter } = await loadGrokAdapter()
      return new GrokAdapter(harness ? { spawn: customHarnessSpawn(harness) } : {}).listModels()
    },
  }
}

function codexRuntime(
  onLog: (line: string) => void,
  resolveHarness: (id: string) => CustomHarness | undefined,
): ProviderRuntime {
  const open = async (workspacePath: string, options: StartOptions, threadId?: string) => {
    const harness = harnessFor('codex', options.agent, resolveHarness)
    const { CodexAdapter } = await loadCodexAdapter()
    const adapter = new CodexAdapter({
      ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
      ...(options.mcpCredentials ? { mcpCredentials: options.mcpCredentials } : {}),
      // Codex spawns its app-server without a cwd; the wrapper resolves from the project.
      ...(harness ? { spawn: customHarnessSpawn(harness, workspacePath) } : {}),
    })
    adapter.on('log', onLog)
    return startedSession(adapter, async () => {
      if (harness) {
        await customHarnessOperation(harness, 'initialize app-server', adapter.start())
      } else {
        await adapter.start()
      }
      if (threadId === undefined) return adapter.startThread(workspacePath, options)
      return adapter.resumeThread(options.providerSessionId ?? threadId, workspacePath, {
        ...(options.instructions ? { instructions: options.instructions } : {}),
        ...(options.approval ? { approval: options.approval } : {}),
        ...(options.context ? { context: options.context } : {}),
      })
    })
  }
  return {
    start: open,
    resume: async (threadId, workspacePath, options) =>
      mapProviderSession(threadId, await open(workspacePath, options, threadId)),
    async listModels(agent) {
      const harness = harnessFor('codex', agent, resolveHarness)
      const { CodexAdapter } = await loadCodexAdapter()
      const adapter = new CodexAdapter(harness ? { spawn: customHarnessSpawn(harness) } : {})
      try {
        if (harness) {
          await customHarnessOperation(harness, 'initialize app-server', adapter.start())
          return await customHarnessOperation(harness, 'list models', adapter.listModels())
        }
        await adapter.start()
        return await adapter.listModels()
      } finally {
        await adapter.dispose()
      }
    },
  }
}

function claudeRuntime(
  onLog: (line: string) => void,
  resolveHarness: (id: string) => CustomHarness | undefined,
): ProviderRuntime {
  const adapterFor = async (agent: string | undefined, workspacePath?: string) => {
    const harness = harnessFor('claude-code', agent, resolveHarness)
    const launch = harness
      ? resolveCustomHarnessLaunch(harness, workspacePath ?? process.cwd())
      : undefined
    const { ClaudeCodeAdapter } = await loadClaudeAdapter()
    const adapter = new ClaudeCodeAdapter(
      harness
        ? {
            spawn: customHarnessSpawn(harness, workspacePath),
            environment: launch!.environment,
          }
        : {},
    )
    adapter.on('log', onLog)
    return adapter
  }

  const sessionFor = (adapter: ClaudeCodeAdapter): AgentSession => ({
    capabilities: adapter.capabilities,
    sendTurn: (threadId, text, attachments, turnOptions) =>
      adapter.sendTurn(threadId, text, attachments, turnOptions),
    steer: (threadId, text, attachments) => adapter.steer(threadId, text, attachments),
    interrupt: () => adapter.interrupt(),
    respondToApproval: (id, decision) => adapter.respondToApproval(id, decision),
    respondToUserInput: (id, answers) => adapter.respondToUserInput(id, answers),
    setApproval: (approval) => adapter.setApproval(approval),
    onUsageChanged: (listener) => adapter.on('usageChanged', listener),
    onDisconnected: (listener) => adapter.onDisconnected(listener),
    dispose: () => adapter.dispose(),
    on: (event: 'event' | 'log', listener: never) => adapter.on(event, listener),
  })

  return {
    async start(workspacePath, options) {
      const adapter = await adapterFor(options.agent, workspacePath)
      return startedSession(sessionFor(adapter), () =>
        adapter.startThread(workspacePath, {
          model: options.model,
          effort: options.effort,
          approval: options.approval,
          instructions: options.instructions,
          ephemeral: options.ephemeral,
          mcpServers: options.mcpServers,
          mcpCredentials: options.mcpCredentials,
          context: options.context,
        }),
      )
    },
    async resume(threadId, workspacePath, options) {
      const adapter = await adapterFor(options.agent, workspacePath)
      return mapProviderSession(
        threadId,
        await startedSession(sessionFor(adapter), () =>
          adapter.resumeThread(options.providerSessionId ?? threadId, workspacePath, {
            model: options.model,
            effort: options.effort,
            approval: options.approval,
            instructions: options.instructions,
            mcpServers: options.mcpServers,
            mcpCredentials: options.mcpCredentials,
            context: options.context,
          }),
        ),
      )
    },
    async listModels(agent) {
      const adapter = await adapterFor(agent)
      try {
        return await adapter.listModels()
      } finally {
        await adapter.dispose()
      }
    },
  }
}
