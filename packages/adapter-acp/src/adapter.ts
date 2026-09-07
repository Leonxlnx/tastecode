import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  ApprovalDecision,
  ApprovalMode,
  Capabilities,
  DomainEvent,
  McpConfigValue,
  McpServerConfig,
  Model,
  ProviderId,
  Thread,
} from '@harness/contracts'
import {
  spawnCli,
  StdioJsonRpc,
  type JsonRpcRequestOptions,
  type JsonRpcValue,
  type ParsedJsonRpcRequestOptions,
  type ServerRequestHandler,
} from '@harness/proc'
import { discoverAgentModels, findAgentSpec, type AcpAgentSpec } from './agents.js'
import { optionFor, type PermissionOption } from './approvals.js'
import { Streamer } from './events.js'
import { acpSessionUsage, acpTurnUsage } from './usage.js'
import {
  PROTOCOL_VERSION,
  InitializeResultSchema,
  NewSessionResultSchema,
  PromptResultSchema,
  RequestPermissionParamsSchema,
  SessionNotificationSchema,
  type InitializeResult,
  type PermissionOptionKind,
  type PromptResult,
  type ContentBlock,
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

export type AcpLaunchOptions = {
  name: string
  command: string
  args?: string[]
  spawn?: typeof spawnCli
  provider?: ProviderId
  mcpServers?: AcpMcpServer[]
}

export interface AcpRpc {
  onStderr(handler: (text: string) => void): void
  onNotification(handler: (method: string, params: JsonRpcValue | undefined) => void): void
  onServerRequest(handler: ServerRequestHandler): void
  request(
    method: string,
    params?: unknown,
    options?: JsonRpcRequestOptions,
  ): Promise<JsonRpcValue | undefined>
  request<Result>(
    method: string,
    params: unknown,
    options: ParsedJsonRpcRequestOptions<Result>,
  ): Promise<Result>
  notify(method: string, params?: unknown): void
  dispose(): void | Promise<void>
}

export type AcpMcpServer =
  | {
      name: string
      command: string
      args: string[]
      env: Array<{ name: string; value: string }>
    }
  | {
      type: 'http'
      name: string
      url: string
      headers: Array<{ name: string; value: string }>
    }

/** Translate TasteCode's credential-safe config into the ACP session shape. */
export function prepareAcpMcpServers(
  servers: McpServerConfig[],
  credentials: Record<string, string>,
): AcpMcpServer[] {
  const result: AcpMcpServer[] = []
  for (const server of servers) {
    if (!server.enabled) continue
    const transport = server.transport
    if (transport.type === 'stdio') {
      if (transport.cwd) {
        throw new Error(`MCP server "${server.id}" cannot use a custom cwd through ACP`)
      }
      result.push({
        name: server.id,
        command: transport.command,
        args: transport.args ?? [],
        env: Object.entries(transport.environment ?? {}).map(([name, value]) => ({
          name,
          value: resolveMcpValue(value, credentials),
        })),
      })
      continue
    }
    result.push({
      type: 'http',
      name: server.id,
      url: transport.url,
      headers: Object.entries(transport.headers ?? {}).map(([name, value]) => ({
        name,
        value: resolveMcpValue(value, credentials),
      })),
    })
  }
  return result
}

function resolveMcpValue(value: McpConfigValue, credentials: Record<string, string>): string {
  if (value.source === 'literal') return value.value
  const credential = credentials[value.credentialRef]
  if (credential === undefined) {
    throw new Error(`MCP credential "${value.credentialRef}" is unavailable`)
  }
  return credential
}

type AcpLaunchSpec = Pick<
  AcpAgentSpec,
  'id' | 'name' | 'command' | 'args' | 'supportedVersion' | 'modelArg' | 'modelConfigId'
>

const IMAGE_MIME_TYPES = new Map([
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
])

export function acpPromptContent(
  text: string,
  attachments: string[] = [],
  images = false,
): ContentBlock[] {
  if (attachments.length > 0 && !images) throw new Error('ACP agent does not support images')
  return [
    { type: 'text', text },
    ...attachments.map((file) => {
      const mimeType = IMAGE_MIME_TYPES.get(path.extname(file).toLowerCase())
      if (!mimeType) throw new Error(`ACP image type is not supported: ${path.extname(file)}`)
      return {
        type: 'image',
        data: readFileSync(file).toString('base64'),
        mimeType,
        uri: pathToFileURL(file).href,
      }
    }),
  ]
}

export class AcpAdapter extends EventEmitter<AcpAdapterEvents> {
  #spec: AcpLaunchSpec
  readonly #spawn: typeof spawnCli
  readonly #provider: ProviderId
  readonly #mcpServers: AcpMcpServer[]
  #rpc: AcpRpc | undefined
  #initialize: InitializeResult | undefined
  #sessionId: string | undefined
  #model: string | undefined
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
  #pendingApprovals = new Map<string, (result: JsonRpcValue) => void>()
  /** The options the agent offered, kept until the user answers. */
  #optionsById = new Map<string, PermissionOption[]>()

  constructor(agentId: string, launch?: AcpLaunchOptions) {
    super()
    this.#spawn = launch?.spawn ?? spawnCli
    this.#provider = launch?.provider ?? 'acp'
    this.#mcpServers = launch?.mcpServers ?? []
    if (launch) {
      this.#spec = {
        id: agentId,
        name: launch.name,
        command: launch.command,
        args: launch.args ?? [],
      }
      return
    }
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
    this.#model = options.model
    const rpc = await this.#connect(workspacePath, options.model)

    const session = await rpc
      .request(
        'session/new',
        {
          cwd: workspacePath,
          mcpServers: this.#mcpServers,
        },
        { result: NewSessionResultSchema },
      )
      .catch((cause) => {
        // Agents report an expired or missing login as a bare protocol error.
        // Passing that through gives the user two words and no way forward, so
        // it becomes the one instruction that actually fixes it.
        const message = cause instanceof Error ? cause.message : String(cause)
        if (/auth/i.test(message)) {
          throw new Error(
            `${this.#spec.name} is not signed in. Run \`${this.#spec.command}\` once in a ` +
              `terminal and sign in there — we deliberately never handle its credentials.`,
          )
        }
        throw cause
      })
    if (!session.sessionId) throw new Error(`${this.#spec.name} started no session`)
    this.#sessionId = session.sessionId
    await this.#selectSessionModel(options.model)

    return {
      id: `acp-${this.#spec.id}-${session.sessionId}`,
      provider: this.#provider,
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
    this.#model = options.model
    const sessionId = parseAcpThreadId(threadId, this.#spec.id)
    const rpc = await this.#connect(workspacePath, options.model)
    if (!this.#loadSession) {
      await this.dispose()
      throw new Error(`${this.#spec.name} does not support session resume`)
    }
    await rpc.request('session/load', {
      sessionId,
      cwd: workspacePath,
      mcpServers: this.#mcpServers,
    })
    this.#sessionId = sessionId
    await this.#selectSessionModel(options.model)
    return {
      id: `acp-${this.#spec.id}-${sessionId}`,
      provider: this.#provider,
      workspacePath,
      createdAt: Date.now(),
    }
  }

  async sendTurn(threadId: string, text: string, attachments: string[] = []): Promise<string> {
    const rpc = this.#rpc
    if (!rpc || !this.#sessionId) throw new Error('session not started')

    const prompt =
      this.#instructionsPending && this.#instructions
        ? `<system-instructions>\n${this.#instructions}\n</system-instructions>\n\n${text}`
        : text
    // Read and validate attachments before opening the turn. A preparation
    // error must reject sendTurn without leaving a started turn orphaned.
    const promptContent = acpPromptContent(prompt, attachments, this.#images)

    // The random suffix keeps turn ids from a resumed process distinct from
    // the persisted turns of the process it replaced — a bare counter reset
    // to zero on every construction and merged two different turns' items.
    const turnId = `${threadId}-turn-${++this.#turnCounter}-${crypto.randomUUID().slice(0, 8)}`
    const streamer = new Streamer(turnId)
    this.#streamer = streamer

    this.emit('event', {
      type: 'turn.started',
      turn: { id: turnId, threadId, status: 'running', createdAt: Date.now() },
    })

    // Deliberately not awaited inline: updates stream in while this is pending,
    // and the caller needs the turn id now to route them.
    this.#instructionsPending = false
    void rpc
      .request(
        'session/prompt',
        {
          sessionId: this.#sessionId,
          prompt: promptContent,
        },
        { result: PromptResultSchema },
      )
      .then((result) => this.#finishTurn(threadId, turnId, result, streamer))
      .catch((cause) => {
        this.emit('event', {
          type: 'thread.error',
          threadId,
          message: cause instanceof Error ? cause.message : String(cause),
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

  /** Live access-level change; read again for every permission request. */
  setApproval(approval: ApprovalMode | undefined): void {
    this.#setApproval(approval)
  }

  async listModels(): Promise<Model[]> {
    return discoverAgentModels(this.#spec.id)
  }

  /** Complete the ACP initialize handshake without creating a paid session. */
  async verifyCompatibility(workspacePath: string): Promise<{
    protocolVersion?: number
    agentName?: string
    agentVersion?: string
  }> {
    await this.#connect(workspacePath, undefined)
    const initialize = this.#initialize
    const protocolVersion = initialize?.protocolVersion
    const agentName = initialize?.agentInfo?.name
    const agentVersion = initialize?.agentInfo?.version
    return {
      ...(protocolVersion !== null && protocolVersion !== undefined ? { protocolVersion } : {}),
      ...(agentName ? { agentName } : {}),
      ...(agentVersion ? { agentVersion } : {}),
    }
  }

  async dispose(): Promise<void> {
    const disposing = this.#rpc?.dispose()
    this.#rpc = undefined
    this.#initialize = undefined
    this.#sessionId = undefined
    this.#model = undefined
    this.#loadSession = false
    this.#pendingApprovals.clear()
    await disposing
  }

  async #connect(workspacePath: string, model: string | undefined): Promise<AcpRpc> {
    const args =
      model && this.#spec.modelArg
        ? [...this.#spec.args, this.#spec.modelArg, model]
        : this.#spec.args
    // A second connect (retry after a failed resume, say) must not orphan the
    // agent process the first one spawned.
    const previousRpc = this.#rpc
    this.#rpc = undefined
    await previousRpc?.dispose()
    const rpc = new StdioJsonRpc(
      this.#spawn(this.#spec.command, args, { cwd: workspacePath }),
      this.#spec.name,
    )
    this.#rpc = rpc
    rpc.onStderr((text) => this.emit('log', text.trimEnd()))
    rpc.onNotification((method, params) => this.#onNotification(method, params))
    rpc.onServerRequest((method, params, respond) => this.#onRequest(method, params, respond))
    const init = await rpc.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'tastecode', version: '0.0.0' },
      },
      { result: InitializeResultSchema },
    )
    this.#initialize = init
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

  #onNotification(method: string, params: JsonRpcValue | undefined): void {
    if (method !== 'session/update') return
    const notification = SessionNotificationSchema.safeParse(params)
    if (!notification.success) return
    const update = notification.data.update
    if (!update) return

    if (update.sessionUpdate === 'usage_update') {
      const usage = acpSessionUsage(update, this.#model)
      if (usage) this.emit('event', { type: 'usage.updated', usage })
      return
    }

    if (!this.#streamer) return

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

  #onRequest(
    method: string,
    params: JsonRpcValue | undefined,
    respond: (result: JsonRpcValue) => void,
  ): void {
    if (method !== 'session/request_permission') {
      // We declared no filesystem capability, so fs/* should never arrive. If
      // one does, refusing is better than silently reading a file.
      this.emit('log', `unhandled request from ${this.#spec.name}: ${method}`)
      respond(null)
      return
    }

    const parsed = RequestPermissionParamsSchema.safeParse(params)
    if (!parsed.success) {
      this.emit('log', `invalid permission request from ${this.#spec.name}`)
      respond(null)
      return
    }
    const request = parsed.data
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

    // Deletes and moves are file work, not commands — typing them as
    // 'command' rendered an approval card with an empty command field.
    const kind =
      call.kind === 'execute'
        ? ('command' as const)
        : call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move'
          ? ('file_change' as const)
          : ('command' as const)
    this.emit('event', {
      type: 'approval.requested',
      request: {
        id,
        kind,
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
    // `auto` has no sandbox under ACP, so it may only wave through actions
    // that cannot mutate anything. Deletes, moves, edits and fetches stay
    // questions for the user.
    if (this.#approval === 'auto' && (kind === 'read' || kind === 'search' || kind === 'think')) {
      return 'allow_once'
    }
    return undefined
  }

  #finishTurn(threadId: string, turnId: string, result: PromptResult, streamer?: Streamer): void {
    const stopReason = result.stopReason
    // Finish the streamer this turn owns, never whichever one is current —
    // a late completion must not close the next turn's open items.
    const owned = streamer ?? this.#streamer
    if (owned === this.#streamer) this.#streamer = undefined
    for (const event of owned?.finish() ?? []) this.emit('event', event)
    const usage = acpTurnUsage(result.usage, this.#model)
    if (usage) this.emit('event', { type: 'usage.updated', usage })

    // Anything still waiting is now unanswerable — the turn it belonged to is
    // over. The agent is still blocked on its request, so it must hear
    // "cancelled", not silence; the UI must hear "resolved".
    for (const [id, respond] of this.#pendingApprovals) {
      respond({ outcome: { outcome: 'cancelled' } })
      this.emit('event', { type: 'approval.resolved', id })
    }
    this.#pendingApprovals.clear()
    this.#optionsById.clear()

    // A refused or truncated turn must not look identical to a successful
    // one — the stop reason goes to the user, not into a log nobody reads.
    if (stopReason === 'refusal') {
      this.emit('event', {
        type: 'thread.error',
        threadId,
        message: 'The agent refused to continue this turn.',
      })
    } else if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
      this.emit('event', {
        type: 'thread.error',
        threadId,
        message: `The turn stopped early (${stopReason.replace(/_/g, ' ')}).`,
      })
    } else if (stopReason && stopReason !== 'end_turn' && stopReason !== 'cancelled') {
      this.emit('log', `turn ended: ${stopReason}`)
    }

    this.emit('event', {
      type: 'turn.completed',
      turnId,
      status:
        stopReason === 'cancelled'
          ? 'interrupted'
          : stopReason === 'refusal'
            ? 'failed'
            : 'completed',
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
