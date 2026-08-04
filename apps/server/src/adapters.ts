import { AcpAdapter } from '@harness/adapter-acp'
import {
  ApiAgentSession,
  createAnthropicMessagesTransport,
  createOpenAiCompatibleTransport,
  createOpenAiResponsesTransport,
  listAnthropicModels,
  listOpenAiCompatibleModels,
  listOpenAiModels,
} from '@harness/adapter-api'
import { CodexAdapter } from '@harness/adapter-codex'
import { ClaudeCodeAdapter } from '@harness/adapter-claude-code'
import { CursorAdapter } from '@harness/adapter-cursor'
import { OpenCodeAdapter } from '@harness/adapter-opencode'
import type {
  ApprovalDecision,
  ApprovalMode,
  Capabilities,
  DomainEvent,
  McpServer,
  McpServerConfig,
  Model,
  StoredModelConnection,
  ProviderId,
  Thread,
} from '@harness/contracts'

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
  /** Which ACP agent to launch. Ignored by providers that are one engine. */
  agent?: string | undefined
  /** Server-owned direct API connection. Required only by the API runtime. */
  connectionId?: string | undefined
  /**
   * Run this session in a private git worktree rather than in the project
   * folder itself, so two agents cannot overwrite each other.
   */
  isolate?: boolean | undefined
  /** Internal project overrides and their already-resolved OS credentials. */
  mcpServers?: McpServerConfig[] | undefined
  mcpCredentials?: Record<string, string> | undefined
}

export function apiRuntime(
  connection: StoredModelConnection,
  apiKey: string,
  onLog: (line: string) => void,
): ProviderRuntime {
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

  return {
    async start(workspacePath, options) {
      const model = options.model ?? connection.defaultModel
      if (!model) throw new Error(`choose a model for "${connection.displayName}"`)
      const session = new ApiAgentSession({
        model,
        transport,
        secrets: [apiKey],
        ...(options.instructions ? { instructions: options.instructions } : {}),
      })
      session.on('log', onLog)
      const thread = session.startThread(workspacePath, connection.id)
      return { thread, session }
    },
    async listModels() {
      const options = {
        apiKey,
        baseUrl: connection.baseUrl,
        ...(connection.defaultModel ? { defaultModel: connection.defaultModel } : {}),
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
  respondToApproval(approvalId: string, decision: ApprovalDecision): void
  respondToUserInput?(requestId: string, answers: Record<string, string[]>): void
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
): ProviderRuntime {
  switch (provider) {
    case 'codex':
      return codexRuntime(onLog)
    case 'claude-code':
      return claudeRuntime(onLog)
    case 'acp':
      return acpRuntime(onLog)
    case 'cursor':
      return cursorRuntime(onLog)
    case 'opencode':
      return openCodeRuntime(onLog)
    default:
      throw new Error(`provider "${provider}" is not implemented yet`)
  }
}

function cursorRuntime(onLog: (line: string) => void): ProviderRuntime {
  return {
    async start(workspacePath, options) {
      const adapter = new CursorAdapter()
      adapter.on('log', onLog)
      const thread = await adapter.startThread(workspacePath, {
        ...(options.model ? { model: options.model } : {}),
        ...(options.approval ? { approval: options.approval } : {}),
        ...(options.instructions ? { instructions: options.instructions } : {}),
      })
      return { thread, session: adapter }
    },
    async resume(threadId, workspacePath, options) {
      const adapter = new CursorAdapter()
      adapter.on('log', onLog)
      const thread = await adapter.resumeThread(threadId, workspacePath, {
        ...(options.model ? { model: options.model } : {}),
        ...(options.approval ? { approval: options.approval } : {}),
        ...(options.instructions ? { instructions: options.instructions } : {}),
      })
      return { thread, session: adapter }
    },
    async listModels() {
      return []
    },
  }
}

function openCodeRuntime(onLog: (line: string) => void): ProviderRuntime {
  return {
    async start(workspacePath, options) {
      const adapter = new OpenCodeAdapter()
      adapter.on('log', onLog)
      try {
        await adapter.start()
        const thread = await adapter.startThread(workspacePath, {
          ...(options.model ? { model: options.model } : {}),
          ...(options.approval ? { approval: options.approval } : {}),
          ...(options.instructions ? { instructions: options.instructions } : {}),
        })
        return { thread, session: adapter }
      } catch (error) {
        adapter.dispose()
        throw error
      }
    },
    async resume(threadId, workspacePath, options) {
      const adapter = new OpenCodeAdapter()
      adapter.on('log', onLog)
      try {
        await adapter.start()
        const thread = await adapter.resumeThread(threadId, workspacePath, {
          ...(options.instructions ? { instructions: options.instructions } : {}),
        })
        return { thread, session: adapter }
      } catch (error) {
        adapter.dispose()
        throw error
      }
    },
    async listModels() {
      const adapter = new OpenCodeAdapter()
      try {
        return await adapter.listModels()
      } finally {
        adapter.dispose()
      }
    },
  }
}

function codexRuntime(onLog: (line: string) => void): ProviderRuntime {
  return {
    async start(workspacePath, options) {
      const adapter = new CodexAdapter({
        ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
        ...(options.mcpCredentials ? { mcpCredentials: options.mcpCredentials } : {}),
      })
      adapter.on('log', onLog)
      await adapter.start()
      const thread = await adapter.startThread(workspacePath, options)
      return { thread, session: adapter }
    },
    async resume(threadId, workspacePath, options) {
      const adapter = new CodexAdapter({
        ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
        ...(options.mcpCredentials ? { mcpCredentials: options.mcpCredentials } : {}),
      })
      adapter.on('log', onLog)
      try {
        await adapter.start()
        const thread = await adapter.resumeThread(threadId, workspacePath, {
          ...(options.instructions ? { instructions: options.instructions } : {}),
        })
        return { thread, session: adapter }
      } catch (error) {
        adapter.dispose()
        throw error
      }
    },
    async listModels() {
      const adapter = new CodexAdapter()
      try {
        await adapter.start()
        return await adapter.listModels()
      } finally {
        adapter.dispose()
      }
    },
  }
}

function acpRuntime(onLog: (line: string) => void): ProviderRuntime {
  return {
    async start(workspacePath, options) {
      if (!options.agent) throw new Error('no ACP agent chosen')
      const adapter = new AcpAdapter(options.agent)
      adapter.on('log', onLog)
      try {
        const thread = await adapter.startThread(workspacePath, {
          approval: options.approval,
          model: options.model,
          instructions: options.instructions,
        })
        return { thread, session: adapter }
      } catch (error) {
        adapter.dispose()
        throw error
      }
    },
    async resume(threadId, workspacePath, options) {
      if (!options.agent) throw new Error('no ACP agent chosen')
      const adapter = new AcpAdapter(options.agent)
      adapter.on('log', onLog)
      try {
        const thread = await adapter.resumeThread(threadId, workspacePath, {
          approval: options.approval,
          model: options.model,
          instructions: options.instructions,
        })
        return { thread, session: adapter }
      } catch (error) {
        adapter.dispose()
        throw error
      }
    },
    async listModels(agent) {
      if (!agent) return []
      return new AcpAdapter(agent).listModels()
    },
  }
}

function claudeRuntime(onLog: (line: string) => void): ProviderRuntime {
  return {
    async start(workspacePath, options) {
      const adapter = new ClaudeCodeAdapter()
      adapter.on('log', onLog)
      const thread = await adapter.startThread(workspacePath, {
        model: options.model,
        approval: options.approval,
        instructions: options.instructions,
      })
      return {
        thread,
        session: {
          capabilities: adapter.capabilities,
          sendTurn: (threadId, text) => adapter.sendTurn(threadId, text),
          interrupt: () => adapter.interrupt(),
          // Claude Code decides permissions from the mode it was launched
          // with; there is no mid-turn callback to answer.
          respondToApproval: () => {},
          respondToUserInput: () => {},
          dispose: () => adapter.dispose(),
          on: (event: 'event' | 'log', listener: never) => adapter.on(event, listener),
        },
      }
    },
    // Not enumerable over this surface, and a hardcoded list would be wrong
    // within a month. The picker hides itself when this is empty.
    async listModels() {
      return []
    },
  }
}
