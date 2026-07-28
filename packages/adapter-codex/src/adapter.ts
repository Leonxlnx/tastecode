import { EventEmitter } from 'node:events'
import type { Capabilities, DomainEvent, Thread } from '@harness/contracts'
import { mapThreadItem } from './map-item.js'
import { StdioJsonRpc } from './jsonrpc.js'
import { spawnCli } from './spawn.js'
import type { AgentMessageDeltaNotification } from './generated/v2/AgentMessageDeltaNotification'
import type { ItemCompletedNotification } from './generated/v2/ItemCompletedNotification'
import type { ItemStartedNotification } from './generated/v2/ItemStartedNotification'
import type { ThreadStartResponse } from './generated/v2/ThreadStartResponse'
import type { TurnCompletedNotification } from './generated/v2/TurnCompletedNotification'
import type { TurnStartedNotification } from './generated/v2/TurnStartedNotification'
import type { TurnStartResponse } from './generated/v2/TurnStartResponse'

/**
 * Tier 1 adapter: drives `codex app-server` over JSON-RPC.
 *
 * This is the richest integration any vendor offers, which is why it is the
 * first one built — designing the internal domain model against the best
 * available protocol keeps it from collapsing to a lowest common denominator.
 *
 * Note what this adapter does NOT do: it never reads `~/.codex/auth.json` or
 * any other credential. The binary authenticates itself. See rules/security.md.
 */

const CLIENT_NAME = 'personal-harness'

export const CODEX_CAPABILITIES: Capabilities = {
  steer: true,
  fork: true,
  interrupt: true,
  reasoningItems: true,
  approvals: true,
  images: true,
}

export type CodexAdapterEvents = {
  event: [DomainEvent]
  log: [string]
}

export class CodexAdapter extends EventEmitter<CodexAdapterEvents> {
  #rpc: StdioJsonRpc | undefined
  #started = false

  get capabilities(): Capabilities {
    return CODEX_CAPABILITIES
  }

  /** Spawn the app-server and complete the handshake. Idempotent. */
  async start(): Promise<void> {
    if (this.#started) return

    const child = spawnCli('codex', ['app-server'])
    const rpc = new StdioJsonRpc(child)
    this.#rpc = rpc

    rpc.onStderr((text) => this.emit('log', text.trimEnd()))
    rpc.onNotification((method, params) => this.#onNotification(method, params))

    // The server may ask us things mid-turn (approvals). Until the approval UI
    // exists in M3, decline rather than silently auto-approving: an agent that
    // runs commands the user never saw is the failure we least want.
    rpc.onServerRequest((method, _params, respond) => {
      this.emit('log', `server request not yet handled: ${method}`)
      respond({ decision: 'denied' })
    })

    await rpc.request('initialize', {
      clientInfo: { name: CLIENT_NAME, title: 'Personal Harness', version: '0.0.0' },
    })
    rpc.notify('initialized', {})
    this.#started = true
  }

  async startThread(workspacePath: string): Promise<Thread> {
    const response = await this.#call<ThreadStartResponse>('thread/start', { cwd: workspacePath })
    return {
      id: response.thread.id,
      provider: 'codex',
      workspacePath,
      createdAt: Date.now(),
    }
  }

  async sendTurn(threadId: string, text: string): Promise<string> {
    const response = await this.#call<TurnStartResponse>('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    })
    return response.turn.id
  }

  async interrupt(threadId: string): Promise<void> {
    await this.#call('turn/interrupt', { threadId })
  }

  /** Inject input without restarting the turn. Codex is one of the few engines that can. */
  async steer(threadId: string, text: string): Promise<void> {
    await this.#call('turn/steer', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    })
  }

  dispose(): void {
    this.#rpc?.dispose()
    this.#rpc = undefined
    this.#started = false
  }

  #call<T>(method: string, params: unknown): Promise<T> {
    if (!this.#rpc) throw new Error('adapter not started')
    return this.#rpc.request<T>(method, params)
  }

  #onNotification(method: string, params: unknown): void {
    const emit = (event: DomainEvent) => this.emit('event', event)

    switch (method) {
      case 'turn/started': {
        const p = params as TurnStartedNotification
        emit({
          type: 'turn.started',
          turn: {
            id: p.turn.id,
            threadId: p.threadId,
            status: 'running',
            createdAt: Date.now(),
          },
        })
        return
      }

      case 'turn/completed': {
        const p = params as TurnCompletedNotification
        emit({
          type: 'turn.completed',
          turnId: p.turn.id,
          // `inProgress` should not reach us here, but map it rather than crash.
          status: p.turn.status === 'inProgress' ? 'completed' : p.turn.status,
        })
        return
      }

      case 'item/started': {
        const p = params as ItemStartedNotification
        emit({
          type: 'item.started',
          item: mapThreadItem(p.item, {
            turnId: p.turnId,
            status: 'started',
            createdAt: p.startedAtMs,
          }),
        })
        return
      }

      case 'item/completed': {
        const p = params as ItemCompletedNotification
        emit({
          type: 'item.completed',
          item: mapThreadItem(p.item, {
            turnId: p.turnId,
            status: 'completed',
            createdAt: p.completedAtMs,
          }),
        })
        return
      }

      case 'item/agentMessage/delta': {
        const p = params as AgentMessageDeltaNotification
        emit({ type: 'item.delta', turnId: p.turnId, itemId: p.itemId, textDelta: p.delta })
        return
      }

      default:
        // Codex emits far more than we consume (realtime audio, MCP progress,
        // remote control). Ignoring the rest is correct; logging it is how we
        // notice when something worth mapping appears.
        this.emit('log', `unmapped notification: ${method}`)
    }
  }
}
