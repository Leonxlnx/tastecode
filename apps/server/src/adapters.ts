import { CodexAdapter } from '@harness/adapter-codex'
import { ClaudeCodeAdapter } from '@harness/adapter-claude-code'
import type {
  ApprovalDecision,
  ApprovalMode,
  Capabilities,
  DomainEvent,
  Model,
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
  model?: string | undefined
  effort?: string | undefined
  approval?: ApprovalMode | undefined
}

export interface AgentSession {
  readonly capabilities: Capabilities
  sendTurn(threadId: string, text: string, attachments?: string[]): Promise<string>
  interrupt(threadId: string): Promise<void>
  respondToApproval(approvalId: string, decision: ApprovalDecision): void
  dispose(): void
  on(event: 'event', listener: (event: DomainEvent) => void): void
  on(event: 'log', listener: (line: string) => void): void
}

export type ProviderRuntime = {
  start(
    workspacePath: string,
    options: StartOptions,
  ): Promise<{ thread: Thread; session: AgentSession }>
  listModels(): Promise<Model[]>
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
    default:
      throw new Error(`provider "${provider}" is not implemented yet`)
  }
}

function codexRuntime(onLog: (line: string) => void): ProviderRuntime {
  return {
    async start(workspacePath, options) {
      const adapter = new CodexAdapter()
      adapter.on('log', onLog)
      await adapter.start()
      const thread = await adapter.startThread(workspacePath, options)
      return { thread, session: adapter }
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

function claudeRuntime(onLog: (line: string) => void): ProviderRuntime {
  return {
    async start(workspacePath, options) {
      const adapter = new ClaudeCodeAdapter()
      adapter.on('log', onLog)
      const thread = await adapter.startThread(workspacePath, {
        model: options.model,
        approval: options.approval,
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
