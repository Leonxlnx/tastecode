import { EventEmitter } from 'node:events'
import type {
  ApprovalDecision,
  ApprovalMode,
  Capabilities,
  DomainEvent,
  Model,
  Thread,
} from '@harness/contracts'
import { spawnCli, StdioJsonRpc } from '@harness/proc'
import { discoverAgentModels, findAgentSpec, type AcpAgentSpec } from './agents.js'
import { optionFor, type PermissionOption } from './approvals.js'
import { Streamer } from './events.js'
import {
  PROTOCOL_VERSION,
  type InitializeResult,
  type NewSessionResult,
  type PermissionOptionKind,
  type PromptResult,
  type RequestPermissionParams,
  type SessionNotification,
} from './protocol.js'

/**
 * One adapter for every agent that speaks the Agent Client Protocol.
 *
 * This is the whole argument for supporting ACP: Gemini, Kimi, Qwen and
 * anything else that adopts it arrive through this file rather than through a
 * new package each. Agent-specific knowledge is limited to a launch command in
 * agents.ts.
 *
 * Verified against gemini-cli in `--experimental-acp` mode.
 *
 * As with every adapter here, we spawn the vendor's binary and let it
 * authenticate itself. See rules/security.md.
 */

export type AcpAdapterEvents = {
  event: [DomainEvent]
  log: [string]
}

export type AcpStartOptions = {
  instructions?: string | undefined
  approval?: ApprovalMode | undefined
  model?: string | undefined
}

export class AcpAdapter extends EventEmitter<AcpAdapterEvents> {
  #spec: AcpAgentSpec
  #rpc: StdioJsonRpc | undefined
  #sessionId: string | undefined
  #streamer: Streamer | undefined
  #turnCounter = 0
  #instructions: string | undefined
  #instructionsPending = false
  #approval: ApprovalMode = 'ask'
  #images = false
  #loadSession = false
  /**
   * Permission requests waiting on the user.
   *
   * The agent blocks on the JSON-RPC id until we reply, so the responder is
   * held here rather than answered eagerly — replying early would be answering
   * on the user's behalf, which is the one thing an approval must never do.
   */
  #pendingApprovals = new Map<string, (result: unknown) => void>()
  /** The options the agent offered, kept until the user answers. */
  #optionsById = new Map<string, PermissionOption[]>()

  constructor(agentId: string) {
    super()
    const spec = findAgentSpec(agentId)
    if (!spec) throw new Error(`unknown ACP agent "${agentId}"`)
    this.#spec = spec
  }

  get capabilities(): Capabilities {
    return {
      // ACP has no steer or fork. It does have cancellation and thinking, and
      // permission requests are core to it rather than optional.
      steer: false,
      fork: false,
      interrupt: true,
      reasoningItems: true,
      approvals: true,
      images: this.#images,
    }
  }

  async startThread(workspacePath: string, options: AcpStartOptions = {}): Promise<Thread> {
    this.#setApproval(options.approval)
    this.#instructions = options.instructions
    this.#instructionsPending = Boolean(options.instructions)
    const rpc = await this.#connect(workspacePath, options.model)

    const session = await rpc
      .request<NewSessionResult>('session/new', { cwd: workspacePath, mcpServers: [] })
      .catch((error: unknown) => {
        // Agents report an expired or missing login as a bare protocol error.
        // Passing that through gives the user two words and no way forward, so
        // it becomes the one instruction that actually fixes it.
        const message = error instanceof Error ? error.message : String(error)
        if (/auth/i.test(message)) {
          throw new Error(
            `${this.#spec.name} is not signed in. Run \`${this.#spec.command}\` once in a ` +
              `terminal and sign in there — we deliberately never handle its credentials.`,
          )
        }
        throw error
      })
    if (!session.sessionId) throw new Error(`${this.#spec.name} started no session`)
    this.#sessionId = session.sessionId
    await this.#selectSessionModel(options.model)

    return {
      id: `acp-${this.#spec.id}-${session.sessionId}`,
      provider: 'acp',
      workspacePath,
      createdAt: Date.now(),
    }
  }

  async resumeThread(
    threadId: string,
    workspacePath: string,
    options: AcpStartOptions = {},
  ): Promise<Thread> {
    this.#setApproval(options.approval)
    this.#instructions = options.instructions
    this.#instructionsPending = false
    const sessionId = parseAcpThreadId(threadId, this.#spec.id)
    const rpc = await this.#connect(workspacePath, options.model)
    if (!this.#loadSession) {
      this.dispose()
      throw new Error(`${this.#spec.name} does not support session resume`)
    }
    await rpc.request('session/load', { sessionId, cwd: workspacePath, mcpServers: [] })
    this.#sessionId = sessionId
    await this.#selectSessionModel(options.model)
    return {
      id: `acp-${this.#spec.id}-${sessionId}`,
      provider: 'acp',
      workspacePath,
      createdAt: Date.now(),
    }
  }

  async sendTurn(threadId: string, text: string): Promise<string> {
    const rpc = this.#rpc
    if (!rpc || !this.#sessionId) throw new Error('session not started')

    const turnId = `${threadId}-turn-${++this.#turnCounter}`
    this.#streamer = new Streamer(turnId)

    this.emit('event', {
      type: 'turn.started',
      turn: { id: turnId, threadId, status: 'running', createdAt: Date.now() },
    })

    // Deliberately not awaited inline: updates stream in while this is pending,
    // and the caller needs the turn id now to route them.
    const prompt =
      this.#instructionsPending && this.#instructions
        ? `<system-instructions>\n${this.#instructions}\n</system-instructions>\n\n${text}`
        : text
    this.#instructionsPending = false
    void rpc
      .request<PromptResult>('session/prompt', {
        sessionId: this.#sessionId,
        prompt: [{ type: 'text', text: prompt }],
      })
      .then((result) => this.#finishTurn(turnId, result.stopReason))
      .catch((error: unknown) => {
        this.emit('event', {
          type: 'thread.error',
          threadId,
          message: error instanceof Error ? error.message : String(error),
        })
        this.emit('event', { type: 'turn.completed', turnId, status: 'failed' })
      })

    return turnId
  }

  async interrupt(): Promise<void> {
    if (!this.#rpc || !this.#sessionId) return
    // A notification, not a request: the agent acknowledges by resolving the
    // in-flight prompt with `cancelled`, not by replying to this.
    this.#rpc.notify('session/cancel', { sessionId: this.#sessionId })
  }

  respondToApproval(approvalId: string, decision: ApprovalDecision): void {
    const respond = this.#pendingApprovals.get(approvalId)
    if (!respond) return
    this.#pendingApprovals.delete(approvalId)

    const optionId = optionFor(this.#optionsById.get(approvalId) ?? [], decision)
    this.#optionsById.delete(approvalId)
    respond(
      optionId
        ? { outcome: { outcome: 'selected', optionId } }
        : // No matching option means we cannot express the answer. Cancelling is
          // the safe reading: it does not proceed.
          { outcome: { outcome: 'cancelled' } },
    )
    this.emit('event', { type: 'approval.resolved', id: approvalId })

    if (decision === 'abort') void this.interrupt()
  }

  async listModels(): Promise<Model[]> {
    return discoverAgentModels(this.#spec.id)
  }

  dispose(): void {
    this.#rpc?.dispose()
    this.#rpc = undefined
    this.#sessionId = undefined
    this.#loadSession = false
    this.#pendingApprovals.clear()
  }

  async #connect(workspacePath: string, model: string | undefined): Promise<StdioJsonRpc> {
    const args =
      model && this.#spec.modelArg
        ? [...this.#spec.args, this.#spec.modelArg, model]
        : this.#spec.args
    // A second connect (retry after a failed resume, say) must not orphan the
    // agent process the first one spawned.
    this.#rpc?.dispose()
    const child = spawnCli(this.#spec.command, args, { cwd: workspacePath })
    const rpc = new StdioJsonRpc(child, this.#spec.name)
    this.#rpc = rpc
    rpc.onStderr((text) => this.emit('log', text.trimEnd()))
    rpc.onNotification((method, params) => this.#onNotification(method, params))
    rpc.onServerRequest((method, params, respond) => this.#onRequest(method, params, respond))
    const init = await rpc.request<InitializeResult>('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'personal-harness', version: '0.0.0' },
    })
    if (init.protocolVersion !== undefined && init.protocolVersion !== PROTOCOL_VERSION) {
      this.emit(
        'log',
        `${this.#spec.name} speaks ACP ${init.protocolVersion}, this adapter was written for ${PROTOCOL_VERSION}`,
      )
    }
    const version = init.agentInfo?.version
    if (
      version &&
      this.#spec.supportedVersion &&
      !version.startsWith(this.#spec.supportedVersion)
    ) {
      this.emit(
        'log',
        `${this.#spec.name} ${version} is outside verified ${this.#spec.supportedVersion}.x`,
      )
    }
    this.#images = init.agentCapabilities?.promptCapabilities?.image ?? false
    this.#loadSession = init.agentCapabilities?.loadSession ?? false
    return rpc
  }

  async #selectSessionModel(model: string | undefined): Promise<void> {
    if (!model || !this.#spec.modelConfigId || !this.#rpc || !this.#sessionId) return
    await this.#rpc.request('session/set_config_option', {
      sessionId: this.#sessionId,
      configId: this.#spec.modelConfigId,
      value: model,
    })
  }

  #setApproval(approval: ApprovalMode | undefined): void {
    if (approval === 'auto-review') {
      throw new Error('ACP agents do not support automatic approval review')
    }
    this.#approval = approval ?? 'ask'
  }

  #onNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return
    const update = (params as SessionNotification | undefined)?.update
    if (!update || !this.#streamer) return

    if (
      update.sessionUpdate === 'available_commands' ||
      update.sessionUpdate === 'current_mode_update'
    ) {
      return
    }

    for (const event of this.#streamer.translate(update)) {
      this.emit('event', event)
    }
  }

  #onRequest(method: string, params: unknown, respond: (result: unknown) => void): void {
    if (method !== 'session/request_permission') {
      // We declared no filesystem capability, so fs/* should never arrive. If
      // one does, refusing is better than silently reading a file.
      this.emit('log', `unhandled request from ${this.#spec.name}: ${method}`)
      respond(null)
      return
    }

    const request = params as RequestPermissionParams
    const call = request.toolCall ?? {}
    const id = call.toolCallId ?? `approval-${Date.now()}`
    const options = request.options ?? []

    // This is the only place a permissioned call is described. Its completion
    // update carries neither kind nor title, so record them now or the finished
    // command shows up as an anonymous "tool".
    if (call.toolCallId) {
      this.#streamer?.note(call.toolCallId, {
        ...(call.kind ? { kind: call.kind } : {}),
        ...(call.title ? { title: call.title } : {}),
      })
    }

    const auto = this.#autoDecision(call.kind)
    if (auto) {
      const optionId = options.find((option) => option.kind === auto)?.optionId
      if (optionId) {
        respond({ outcome: { outcome: 'selected', optionId } })
        return
      }
      // Fall through and ask, rather than guess at an option the agent did not
      // offer.
    }

    this.#pendingApprovals.set(id, respond)
    this.#optionsById.set(id, options)

    this.emit('event', {
      type: 'approval.requested',
      request: {
        id,
        kind:
          call.kind === 'execute' ? 'command' : call.kind === 'edit' ? 'file_change' : 'command',
        // The title is what the agent says it wants to do, shown verbatim.
        ...(call.kind === 'execute' ? { command: call.title } : { path: call.title }),
        createdAt: Date.now(),
      },
    })
  }

  /**
   * ACP always asks. Our approval modes decide which of those questions the
   * user actually sees — `full` answers all of them, `auto` answers only the
   * ones that do not run a command, and `ask` answers none.
   */
  #autoDecision(kind: string | undefined): PermissionOptionKind | undefined {
    if (this.#approval === 'full') return 'allow_always'
    if (this.#approval === 'auto' && kind !== 'execute') return 'allow_once'
    return undefined
  }

  #finishTurn(turnId: string, stopReason: PromptResult['stopReason']): void {
    for (const event of this.#streamer?.finish() ?? []) this.emit('event', event)

    // Anything still waiting is now unanswerable — the turn it belonged to is
    // over. Clearing them stops the UI showing a card that can never resolve.
    for (const [id] of this.#pendingApprovals) {
      this.emit('event', { type: 'approval.resolved', id })
    }
    this.#pendingApprovals.clear()
    this.#optionsById.clear()

    if (stopReason && stopReason !== 'end_turn' && stopReason !== 'cancelled') {
      this.emit('log', `turn ended: ${stopReason}`)
    }

    this.emit('event', {
      type: 'turn.completed',
      turnId,
      status: stopReason === 'cancelled' ? 'interrupted' : 'completed',
    })
  }
}

export function parseAcpThreadId(threadId: string, agentId: string): string {
  const prefix = `acp-${agentId}-`
  if (!threadId.startsWith(prefix) || threadId.length === prefix.length) {
    throw new Error(`thread does not belong to ACP agent "${agentId}"`)
  }
  return threadId.slice(prefix.length)
}
