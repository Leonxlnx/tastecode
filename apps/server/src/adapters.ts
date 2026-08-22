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
  ProviderId,
  StoredModelConnection,
  Thread,
} from '@harness/contracts'
import { createApiWorkspaceTools } from './api-workspace-tools.js'
import {
  actionableLaunchError,
  customHarnessRun,
  customHarnessSpawn,
  resolveCustomHarnessLaunch,
  runCustomHarness,
} from './custom-harness-launch.js'

function lazyImport<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => (pending ??= load())
}

const loadAcpAdapter = lazyImport(() => import('@harness/adapter-acp'))
const loadAntigravityAdapter = lazyImport(() => import('@harness/adapter-antigravity'))
const loadApiAdapter = lazyImport(() => import('@harness/adapter-api'))
const loadClaudeAdapter = lazyImport(() => import('@harness/adapter-claude-code'))
const loadCodexAdapter = lazyImport(() => import('@harness/adapter-codex'))
const loadCursorAdapter = lazyImport(() => import('@harness/adapter-cursor'))
const loadGrokAdapter = lazyImport(() => import('@harness/adapter-grok'))
const loadOpenCodeAdapter = lazyImport(() => import('@harness/adapter-opencode'))
const loadPiAdapter = lazyImport(() => import('@harness/adapter-pi'))

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
  /** Built-in ACP agent or user-owned harness source to launch. */
  agent?: string | undefined
  /** Server-owned direct API connection. Required only by the API runtime. */
  connectionId?: string | undefined
  /** Provider-owned history should not retain product-internal background work. */
  ephemeral?: boolean | undefined
  /**
   * Run this session in a private git worktree rather than in the project
   * folder itself, so two agents cannot overwrite each other.
   */
  isolate?: boolean | undefined
  /** Internal project overrides and their already-resolved OS credentials. */
  mcpServers?: McpServerConfig[] | undefined
  mcpCredentials?: Record<string, string> | undefined
  /**
   * Server-owned, opaque provider resume identity. It is intentionally
   * separate from the stable TasteCode thread id passed to `resume`.
   */
  providerSessionId?: string | undefined
}

export function apiRuntime(
  connection: StoredModelConnection,
  apiKey: string,
  onLog: (line: string) => void,
): ProviderRuntime {
  return {
    async start(workspacePath, options) {
      const {
        ApiAgentSession,
        createAnthropicMessagesTransport,
        createOpenAiCompatibleTransport,
        createOpenAiResponsesTransport,
      } = await loadApiAdapter()
      const transport =
        connection.transport === 'openai-responses'
          ? createOpenAiResponsesTransport({ apiKey, baseUrl: connection.baseUrl })
          : connection.transport === 'anthropic-messages'
            ? createAnthropicMessagesTransport({ apiKey, baseUrl: connection.baseUrl })
            : createOpenAiCompatibleTransport({
                apiKey,
                provider:
                  connection.preset === 'openrouter' ||
                  connection.preset === 'kimi' ||
                  connection.preset === 'zai'
                    ? connection.preset
                    : 'custom',
                baseUrl: connection.baseUrl,
              })
      const model = options.model ?? connection.defaultModel
      if (!model) throw new Error(`choose a model for "${connection.displayName}"`)
      const workspaceTools = createApiWorkspaceTools(workspacePath, options.approval)
      const session = new ApiAgentSession({
        model,
        transport,
        secrets: [apiKey],
        ...workspaceTools,
        ...(options.instructions
          ? {
              instructions: options.instructions,
            }
          : {}),
      })
      session.on('log', onLog)
      const thread = session.startThread(workspacePath, connection.id)
      return { thread, session }
    },
    async listModels() {
      const { listAnthropicModels, listOpenAiCompatibleModels, listOpenAiModels } =
        await loadApiAdapter()
      const options = {
        apiKey,
        baseUrl: connection.baseUrl,
        ...(connection.defaultModel
          ? {
              defaultModel: connection.defaultModel,
            }
          : {}),
      }
      if (connection.transport === 'openai-responses') return listOpenAiModels(options)
      if (connection.transport === 'anthropic-messages') return listAnthropicModels(options)
      return listOpenAiCompatibleModels({
        ...options,
        provider:
          connection.preset === 'openrouter' ||
          connection.preset === 'kimi' ||
          connection.preset === 'zai'
            ? connection.preset
            : 'custom',
      })
    },
  }
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
  /** Provider reported or rotated the opaque identity needed after a restart. */
  onProviderSessionId?(listener: (providerSessionId: string) => void): void
  respondToApproval(approvalId: string, decision: ApprovalDecision): void
  respondToUserInput?(requestId: string, answers: Record<string, string[]>): void
  /**
   * Live access-level change for a running thread. Providers that map the
   * mode onto launch switches cannot change it mid-run and leave this
   * undefined; the orchestrator then only records the new mode for the
   * design-flow note and future turns.
   */
  setApproval?(approval: ApprovalMode): void | Promise<void>
  dispose(): void
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
    case 'acp':
      return acpRuntime(onLog, resolveHarness)
    case 'cursor':
      return cursorRuntime(onLog, resolveHarness)
    case 'opencode':
      return openCodeRuntime(onLog, resolveHarness)
    case 'antigravity':
      return antigravityRuntime(onLog, resolveHarness)
    case 'grok':
      return grokRuntime(onLog, resolveHarness)
    case 'pi':
      return piRuntime(onLog, resolveHarness)
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
  // ACP also has built-in agent IDs. Every other non-empty source is a
  // persisted custom harness and must fail loudly if it was removed.
  if (!harness) {
    if (provider === 'acp') return undefined
    throw new Error(`custom harness "${id}" no longer exists`)
  }
  if (harness.provider !== provider) {
    throw new Error(`custom harness "${harness.displayName}" is configured for ${harness.provider}`)
  }
  return harness
}

function requireHarness(
  provider: ProviderId,
  id: string | undefined,
  resolveHarness: (id: string) => CustomHarness | undefined,
): CustomHarness {
  const harness = harnessFor(provider, id, resolveHarness)
  if (!harness) throw new Error(`${provider} requires a configured custom harness`)
  return harness
}

const CUSTOM_HARNESS_PROTOCOL_LABELS = {
  codex: 'Codex app-server',
  'claude-code': 'Claude Code stream JSON',
  grok: 'Grok streaming JSON',
  cursor: 'Cursor stream JSON',
  opencode: 'OpenCode HTTP server',
  antigravity: 'Antigravity stream JSON',
  pi: 'Pi RPC',
  acp: 'ACP',
} satisfies Record<CustomHarness['provider'], string>

/**
 * Side-effect-bounded compatibility check. Native/ACP integrations complete a
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
        adapter.dispose()
      }
    }
    case 'opencode': {
      const { OpenCodeAdapter } = await loadOpenCodeAdapter()
      const adapter = new OpenCodeAdapter({ spawn })
      adapter.on('log', onLog)
      try {
        await customHarnessDeadline(harness, 'start its HTTP server', adapter.start())
        const models = await customHarnessDeadline(harness, 'list models', adapter.listModels())
        return modelProbeCheck(label, models, 'HTTP protocol detected')
      } finally {
        adapter.dispose()
      }
    }
    case 'pi': {
      const { PiAdapter } = await loadPiAdapter()
      const adapter = new PiAdapter({
        command: harness.command,
        args: [],
        displayName: harness.displayName,
        spawn,
        workspacePath,
      })
      adapter.on('log', onLog)
      try {
        const models = await customHarnessDeadline(harness, 'complete Pi RPC', adapter.listModels())
        return modelProbeCheck(label, models, 'RPC handshake completed')
      } finally {
        adapter.dispose()
      }
    }
    case 'acp': {
      const { AcpAdapter } = await loadAcpAdapter()
      const adapter = new AcpAdapter(harness.id, {
        name: harness.displayName,
        command: harness.command,
        args: [],
        spawn,
      })
      adapter.on('log', onLog)
      try {
        const result = await customHarnessDeadline(
          harness,
          'complete the ACP handshake',
          adapter.verifyCompatibility(workspacePath),
        )
        const agent = [result.agentName, result.agentVersion].filter(Boolean).join(' ')
        return {
          label,
          status: 'passed',
          detail: `Initialize handshake completed${agent ? ` with ${agent}` : ''}.`,
        }
      } finally {
        adapter.dispose()
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
        adapter.dispose()
      }
    }
    case 'cursor': {
      const { CursorAdapter } = await loadCursorAdapter()
      const adapter = new CursorAdapter({
        spawn,
        run: customHarnessRun(harness, workspacePath),
      })
      adapter.on('log', onLog)
      try {
        const models = await customHarnessDeadline(harness, 'list models', adapter.listModels())
        return modelProbeCheck(label, models, 'Stream-json CLI model command responded')
      } finally {
        adapter.dispose()
      }
    }
    case 'antigravity': {
      const { AntigravityAdapter } = await loadAntigravityAdapter()
      const adapter = new AntigravityAdapter({ spawn })
      adapter.on('log', onLog)
      try {
        const models = await customHarnessDeadline(harness, 'list models', adapter.listModels())
        return modelProbeCheck(label, models, 'Streaming CLI model command responded')
      } finally {
        adapter.dispose()
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

function grokRuntime(
  onLog: (line: string) => void,
  resolveHarness: (id: string) => CustomHarness | undefined,
): ProviderRuntime {
  const acpAdapterFor = async (harness: CustomHarness | undefined, options: StartOptions) => {
    const [{ AcpAdapter, prepareAcpMcpServers }, { grokCommand }] = await Promise.all([
      loadAcpAdapter(),
      loadGrokAdapter(),
    ])
    return new AcpAdapter('grok', {
      name: harness?.displayName ?? 'Grok',
      command: grokCommand(),
      args: [
        'agent',
        ...(options.model ? ['--model', options.model] : []),
        ...(options.effort ? ['--reasoning-effort', options.effort] : []),
        'stdio',
      ],
      provider: 'grok',
      mcpServers: prepareAcpMcpServers(options.mcpServers ?? [], options.mcpCredentials ?? {}),
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
    onProviderSessionId: (listener) => adapter.on('providerSessionId', listener),
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
        try {
          const starting = adapter.startThread(workspacePath, {
            model: options.model,
            approval: options.approval,
            instructions: options.instructions,
          })
          const thread = harness
            ? await customHarnessOperation(harness, 'start an MCP-enabled ACP session', starting)
            : await starting
          return { thread, session: adapter }
        } catch (error) {
          adapter.dispose()
          throw error
        }
      }
      const { GrokAdapter } = await loadGrokAdapter()
      const adapter = new GrokAdapter(harness ? { spawn: customHarnessSpawn(harness) } : {})
      adapter.on('log', onLog)
      const thread = await adapter.startThread(workspacePath, {
        model: options.model,
        effort: options.effort,
        approval: options.approval,
        instructions: options.instructions,
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
        try {
          const resuming = adapter.resumeThread(threadId, workspacePath, {
            model: options.model,
            approval: options.approval,
            instructions: options.instructions,
          })
          const thread = harness
            ? await customHarnessOperation(harness, 'resume an MCP-enabled ACP session', resuming)
            : await resuming
          return { thread, session: adapter }
        } catch (error) {
          adapter.dispose()
          throw error
        }
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

function antigravityRuntime(
  onLog: (line: string) => void,
  resolveHarness: (id: string) => CustomHarness | undefined,
): ProviderRuntime {
  return {
    async start(workspacePath, options) {
      const harness = harnessFor('antigravity', options.agent, resolveHarness)
      const { AntigravityAdapter } = await loadAntigravityAdapter()
      const adapter = new AntigravityAdapter(harness ? { spawn: customHarnessSpawn(harness) } : {})
      adapter.on('log', onLog)
      const thread = await adapter.startThread(workspacePath, {
        model: options.model,
        effort: options.effort,
        approval: options.approval,
        instructions: options.instructions,
      })
      return {
        thread,
        session: {
          capabilities: adapter.capabilities,
          sendTurn: (threadId, text, attachments, turnOptions) =>
            adapter.sendTurn(threadId, text, attachments, turnOptions),
          interrupt: () => adapter.interrupt(),
          // Print mode decides permissions from the launch switches; there is
          // no mid-turn callback to answer.
          respondToApproval: () => {},
          dispose: () => adapter.dispose(),
          on: (event: 'event' | 'log', listener: never) => adapter.on(event, listener),
        },
      }
    },
    async listModels(agent) {
      const harness = harnessFor('antigravity', agent, resolveHarness)
      const { AntigravityAdapter } = await loadAntigravityAdapter()
      return new AntigravityAdapter(
        harness ? { spawn: customHarnessSpawn(harness) } : {},
      ).listModels()
    },
  }
}

function cursorRuntime(
  onLog: (line: string) => void,
  resolveHarness: (id: string) => CustomHarness | undefined,
): ProviderRuntime {
  return {
    async start(workspacePath, options) {
      const harness = harnessFor('cursor', options.agent, resolveHarness)
      const { CursorAdapter } = await loadCursorAdapter()
      const adapter = new CursorAdapter(
        harness ? { spawn: customHarnessSpawn(harness), run: customHarnessRun(harness) } : {},
      )
      adapter.on('log', onLog)
      const thread = await adapter.startThread(workspacePath, {
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
        ...(options.approval ? { approval: options.approval } : {}),
        ...(options.instructions
          ? {
              instructions: options.instructions,
            }
          : {}),
      })
      return { thread, session: adapter }
    },
    async resume(threadId, workspacePath, options) {
      const harness = harnessFor('cursor', options.agent, resolveHarness)
      const { CursorAdapter } = await loadCursorAdapter()
      const adapter = new CursorAdapter(
        harness ? { spawn: customHarnessSpawn(harness), run: customHarnessRun(harness) } : {},
      )
      adapter.on('log', onLog)
      const thread = await adapter.resumeThread(threadId, workspacePath, {
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
        ...(options.approval ? { approval: options.approval } : {}),
        ...(options.instructions
          ? {
              instructions: options.instructions,
            }
          : {}),
      })
      return { thread, session: adapter }
    },
    async listModels(agent) {
      const harness = harnessFor('cursor', agent, resolveHarness)
      const { CursorAdapter } = await loadCursorAdapter()
      return new CursorAdapter(
        harness ? { spawn: customHarnessSpawn(harness), run: customHarnessRun(harness) } : {},
      ).listModels()
    },
  }
}

function openCodeRuntime(
  onLog: (line: string) => void,
  resolveHarness: (id: string) => CustomHarness | undefined,
): ProviderRuntime {
  return {
    async start(workspacePath, options) {
      const harness = harnessFor('opencode', options.agent, resolveHarness)
      const { OpenCodeAdapter } = await loadOpenCodeAdapter()
      const adapter = new OpenCodeAdapter({
        ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
        ...(options.mcpCredentials
          ? {
              mcpCredentials: options.mcpCredentials,
            }
          : {}),
        ...(harness
          ? {
              spawn: customHarnessSpawn(harness),
            }
          : {}),
      })
      adapter.on('log', onLog)
      try {
        if (harness) {
          await customHarnessOperation(harness, 'start its server', adapter.start())
        } else {
          await adapter.start()
        }
        const start = adapter.startThread(workspacePath, {
          ...(options.model ? { model: options.model } : {}),
          ...(options.effort ? { effort: options.effort } : {}),
          ...(options.approval ? { approval: options.approval } : {}),
          ...(options.instructions
            ? {
                instructions: options.instructions,
              }
            : {}),
        })
        const thread = harness
          ? await customHarnessOperation(harness, 'create a session', start)
          : await start
        return { thread, session: adapter }
      } catch (error) {
        adapter.dispose()
        throw error
      }
    },
    async resume(threadId, workspacePath, options) {
      const harness = harnessFor('opencode', options.agent, resolveHarness)
      const { OpenCodeAdapter } = await loadOpenCodeAdapter()
      const adapter = new OpenCodeAdapter({
        ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
        ...(options.mcpCredentials
          ? {
              mcpCredentials: options.mcpCredentials,
            }
          : {}),
        ...(harness
          ? {
              spawn: customHarnessSpawn(harness),
            }
          : {}),
      })
      adapter.on('log', onLog)
      try {
        if (harness) {
          await customHarnessOperation(harness, 'start its server', adapter.start())
        } else {
          await adapter.start()
        }
        const resume = adapter.resumeThread(threadId, workspacePath, {
          ...(options.model ? { model: options.model } : {}),
          ...(options.effort ? { effort: options.effort } : {}),
          ...(options.approval ? { approval: options.approval } : {}),
          ...(options.instructions
            ? {
                instructions: options.instructions,
              }
            : {}),
        })
        const thread = harness
          ? await customHarnessOperation(harness, 'resume its session', resume)
          : await resume
        return { thread, session: adapter }
      } catch (error) {
        adapter.dispose()
        throw error
      }
    },
    async listModels(agent) {
      return listOpenCodeModels(harnessFor('opencode', agent, resolveHarness))
    },
  }
}

/**
 * Single-flight: every OpenCode model listing spawns a real `opencode serve`
 * process for its lifetime, so concurrent or rapid-fire requests must share
 * one run instead of forking one process each. A renderer refresh loop once
 * held ~170 of these processes alive at the same time — the server, not the
 * client, is where that has to be impossible.
 */
const openCodeModelListings = new Map<string, Promise<Model[]>>()

function listOpenCodeModels(harness?: CustomHarness): Promise<Model[]> {
  const key = harness?.id ?? 'default'
  const existing = openCodeModelListings.get(key)
  if (existing) return existing
  const listing = (async () => {
    const { OpenCodeAdapter } = await loadOpenCodeAdapter()
    const adapter = new OpenCodeAdapter(harness ? { spawn: customHarnessSpawn(harness) } : {})
    try {
      const listing = adapter.listModels()
      return harness ? await customHarnessOperation(harness, 'list models', listing) : await listing
    } finally {
      adapter.dispose()
    }
  })().finally(() => {
    openCodeModelListings.delete(key)
  })
  openCodeModelListings.set(key, listing)
  return listing
}

function codexRuntime(
  onLog: (line: string) => void,
  resolveHarness: (id: string) => CustomHarness | undefined,
): ProviderRuntime {
  return {
    async start(workspacePath, options) {
      const harness = harnessFor('codex', options.agent, resolveHarness)
      const { CodexAdapter } = await loadCodexAdapter()
      const adapter = new CodexAdapter({
        ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
        ...(options.mcpCredentials
          ? {
              mcpCredentials: options.mcpCredentials,
            }
          : {}),
        ...(harness
          ? {
              spawn: customHarnessSpawn(harness),
            }
          : {}),
      })
      adapter.on('log', onLog)
      try {
        if (harness) {
          await customHarnessOperation(harness, 'initialize app-server', adapter.start())
        } else {
          await adapter.start()
        }
        const thread = await adapter.startThread(workspacePath, options)
        return { thread, session: adapter }
      } catch (error) {
        // A failing thread/start must not leak the app-server child it spawned.
        adapter.dispose()
        throw error
      }
    },
    async resume(threadId, workspacePath, options) {
      const harness = harnessFor('codex', options.agent, resolveHarness)
      const { CodexAdapter } = await loadCodexAdapter()
      const adapter = new CodexAdapter({
        ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
        ...(options.mcpCredentials
          ? {
              mcpCredentials: options.mcpCredentials,
            }
          : {}),
        ...(harness
          ? {
              spawn: customHarnessSpawn(harness),
            }
          : {}),
      })
      adapter.on('log', onLog)
      try {
        if (harness) {
          await customHarnessOperation(harness, 'initialize app-server', adapter.start())
        } else {
          await adapter.start()
        }
        const thread = await adapter.resumeThread(threadId, workspacePath, {
          ...(options.instructions
            ? {
                instructions: options.instructions,
              }
            : {}),
          ...(options.approval ? { approval: options.approval } : {}),
        })
        return { thread, session: adapter }
      } catch (error) {
        adapter.dispose()
        throw error
      }
    },
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
        adapter.dispose()
      }
    },
  }
}

function acpRuntime(
  onLog: (line: string) => void,
  resolveHarness: (id: string) => CustomHarness | undefined,
): ProviderRuntime {
  return {
    async start(workspacePath, options) {
      if (!options.agent) throw new Error('no ACP agent chosen')
      const harness = harnessFor('acp', options.agent, resolveHarness)
      const { AcpAdapter } = await loadAcpAdapter()
      const adapter = new AcpAdapter(
        options.agent,
        harness
          ? {
              name: harness.displayName,
              command: harness.command,
              args: [],
              spawn: customHarnessSpawn(harness),
            }
          : undefined,
      )
      adapter.on('log', onLog)
      try {
        const starting = adapter.startThread(workspacePath, {
          approval: options.approval,
          model: options.model,
          instructions: options.instructions,
        })
        const thread = harness
          ? await customHarnessOperation(harness, 'complete the ACP session handshake', starting)
          : await starting
        return { thread, session: adapter }
      } catch (error) {
        adapter.dispose()
        throw error
      }
    },
    async resume(threadId, workspacePath, options) {
      if (!options.agent) throw new Error('no ACP agent chosen')
      const harness = harnessFor('acp', options.agent, resolveHarness)
      const { AcpAdapter } = await loadAcpAdapter()
      const adapter = new AcpAdapter(
        options.agent,
        harness
          ? {
              name: harness.displayName,
              command: harness.command,
              args: [],
              spawn: customHarnessSpawn(harness),
            }
          : undefined,
      )
      adapter.on('log', onLog)
      try {
        const resuming = adapter.resumeThread(threadId, workspacePath, {
          approval: options.approval,
          model: options.model,
          instructions: options.instructions,
        })
        const thread = harness
          ? await customHarnessOperation(harness, 'resume the ACP session', resuming)
          : await resuming
        return { thread, session: adapter }
      } catch (error) {
        adapter.dispose()
        throw error
      }
    },
    async listModels(agent) {
      if (!agent) return []
      const harness = harnessFor('acp', agent, resolveHarness)
      const { AcpAdapter } = await loadAcpAdapter()
      return new AcpAdapter(
        agent,
        harness
          ? {
              name: harness.displayName,
              command: harness.command,
              args: [],
              spawn: customHarnessSpawn(harness),
            }
          : undefined,
      ).listModels()
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
    dispose: () => adapter.dispose(),
    on: (event: 'event' | 'log', listener: never) => adapter.on(event, listener),
  })

  return {
    async start(workspacePath, options) {
      const adapter = await adapterFor(options.agent, workspacePath)
      const thread = await adapter.startThread(workspacePath, {
        model: options.model,
        effort: options.effort,
        approval: options.approval,
        instructions: options.instructions,
        ephemeral: options.ephemeral,
      })
      return { thread, session: sessionFor(adapter) }
    },
    async resume(threadId, workspacePath, options) {
      const adapter = await adapterFor(options.agent, workspacePath)
      const thread = await adapter.resumeThread(threadId, workspacePath, {
        model: options.model,
        effort: options.effort,
        approval: options.approval,
        instructions: options.instructions,
      })
      return { thread, session: sessionFor(adapter) }
    },
    async listModels(agent) {
      const adapter = await adapterFor(agent)
      try {
        return await adapter.listModels()
      } finally {
        adapter.dispose()
      }
    },
  }
}

function piRuntime(
  onLog: (line: string) => void,
  resolveHarness: (id: string) => CustomHarness | undefined,
): ProviderRuntime {
  const adapterFor = async (agent: string | undefined, workspacePath?: string) => {
    const harness = requireHarness('pi', agent, resolveHarness)
    const { PiAdapter } = await loadPiAdapter()
    const adapter = new PiAdapter({
      command: harness.command,
      args: [],
      displayName: harness.displayName,
      spawn: customHarnessSpawn(harness, workspacePath),
      ...(workspacePath ? { workspacePath } : {}),
    })
    adapter.on('log', onLog)
    return adapter
  }
  return {
    async start(workspacePath, options) {
      const harness = requireHarness('pi', options.agent, resolveHarness)
      const adapter = await adapterFor(options.agent, workspacePath)
      try {
        const starting = adapter.startThread(workspacePath, {
          model: options.model,
          effort: options.effort,
          approval: options.approval,
          instructions: options.instructions,
        })
        const thread = await customHarnessOperation(
          harness,
          'complete the Pi RPC handshake',
          starting,
        )
        return { thread, session: adapter }
      } catch (error) {
        adapter.dispose()
        throw error
      }
    },
    async listModels(agent) {
      const harness = requireHarness('pi', agent, resolveHarness)
      const adapter = await adapterFor(agent)
      try {
        return await customHarnessOperation(harness, 'list Pi models', adapter.listModels())
      } finally {
        adapter.dispose()
      }
    },
  }
}
