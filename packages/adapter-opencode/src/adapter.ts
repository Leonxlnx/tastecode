import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type {
  ApprovalDecision,
  ApprovalMode,
  ApprovalRequest,
  Capabilities,
  DomainEvent,
  McpServerConfig,
  Model,
  Thread,
} from '@harness/contracts'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk'
import { JsonRpcValueSchema, killTree, spawnCli, type JsonRpcValue } from '@harness/proc'
import { z } from 'zod'
import {
  OpenCodeEventMapper,
  OpenCodeV2EventSchema,
  type OpenCodeV2Event,
  type OpenCodeWireEvent,
} from './events.js'

export const OPENCODE_CAPABILITIES: Capabilities = {
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: true,
  approvals: true,
  images: false,
}

type Events = { event: [DomainEvent]; log: [string] }
type OpenCodeProtocol = 'v1' | 'v2'
type Spawn = typeof spawnCli

export type OpenCodeStartOptions = {
  model?: string | undefined
  effort?: string | undefined
  approval?: ApprovalMode | undefined
  instructions?: string | undefined
}

export type OpenCodeTurnOptions = Pick<OpenCodeStartOptions, 'model' | 'effort'>

const OPENCODE_DEFAULT_VARIANT = 'default'

function applyOpenCodeTurnOptions(
  current: OpenCodeTurnOptions,
  next: OpenCodeTurnOptions,
): OpenCodeTurnOptions {
  if (Object.keys(next).length === 0) return current
  const merged = { ...current }
  for (const field of ['model', 'effort'] as const) {
    if (!(field in next)) continue
    const value = next[field]
    if (value === undefined) delete merged[field]
    else merged[field] = value
  }
  return merged
}

const VariantSchema = z.object({ id: z.string(), disabled: z.boolean().optional() })
const VariantMapSchema = z.record(z.string(), z.object({ disabled: z.boolean().optional() }))
const VariantsSchema = z.union([z.array(VariantSchema), VariantMapSchema])
const ReasoningModelSchema = z.object({
  variants: VariantsSchema.optional(),
  options: z.object({ variants: VariantsSchema.optional() }).optional(),
})

/** OpenCode owns variant names and can add custom ones in project config.
 *  Accept both catalog shapes it uses for variants so the result remains
 *  model-specific instead of guessing from the underlying provider name. */
export function openCodeReasoningEfforts(model: unknown): string[] {
  const parsed = ReasoningModelSchema.safeParse(model)
  if (!parsed.success) return []
  const value = parsed.data.variants ?? parsed.data.options?.variants
  const variants = Array.isArray(value)
    ? value.filter((entry) => entry.disabled !== true).map((entry) => entry.id)
    : Object.entries(value ?? {})
        .filter(([, entry]) => entry.disabled !== true)
        .map(([id]) => id)
  if (variants.length === 0) return []
  return [
    OPENCODE_DEFAULT_VARIANT,
    ...new Set(variants.filter((id) => id !== OPENCODE_DEFAULT_VARIANT)),
  ]
}

/**
 * TasteCode MCP config as the `mcp` block of an opencode config. Credential
 * references resolve here — the reference, never the secret, is what crossed
 * the protocol. Verified against opencode 1.x: `OPENCODE_CONFIG_CONTENT`
 * accepts `{ mcp: { name: { type: 'local'|'remote', ... } } }`.
 */
export function openCodeMcpConfig(servers: McpServerConfig[], credentials: Record<string, string>) {
  const resolve = (
    value: { source: 'literal'; value: string } | { source: 'credential'; credentialRef: string },
  ) => (value.source === 'literal' ? value.value : (credentials[value.credentialRef] ?? ''))
  const mcp: Record<string, JsonRpcValue> = {}
  for (const server of servers) {
    if (!server.enabled) {
      mcp[server.id] = { type: 'local', command: ['true'], enabled: false }
      continue
    }
    if (server.transport.type === 'stdio') {
      mcp[server.id] = {
        type: 'local',
        command: [server.transport.command, ...(server.transport.args ?? [])],
        ...(server.transport.environment
          ? {
              environment: Object.fromEntries(
                Object.entries(server.transport.environment).map(([key, value]) => [
                  key,
                  resolve(value),
                ]),
              ),
            }
          : {}),
        enabled: true,
      }
    } else {
      mcp[server.id] = {
        type: 'remote',
        url: server.transport.url,
        ...(server.transport.headers
          ? {
              headers: Object.fromEntries(
                Object.entries(server.transport.headers).map(([key, value]) => [
                  key,
                  resolve(value),
                ]),
              ),
            }
          : {}),
        enabled: true,
      }
    }
  }
  return mcp
}

const OpenCodeV2SessionSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  time: z.object({ created: z.number().optional() }).optional(),
})
const SessionEnvelopeSchema = z.object({ data: OpenCodeV2SessionSchema })
const OpenCodeV2ProviderSchema = z.object({ id: z.string(), name: z.string() })
const ProviderEnvelopeSchema = z.object({ data: z.array(OpenCodeV2ProviderSchema) })
const OpenCodeV2CatalogModelSchema = z.object({
  id: z.string(),
  providerID: z.string(),
  name: z.string(),
  enabled: z.boolean().optional(),
  variants: JsonRpcValueSchema.optional(),
})
const ModelEnvelopeSchema = z.object({ data: z.array(OpenCodeV2CatalogModelSchema) })
const OpenCodeV2AgentSchema = z.object({
  id: z.string(),
  mode: z.string().optional(),
  model: z
    .object({ id: z.string(), providerID: z.string(), variant: z.string().optional() })
    .optional(),
})
const AgentEnvelopeSchema = z.object({ data: z.array(OpenCodeV2AgentSchema) })
const HealthSchema = z.object({ healthy: z.boolean() })
const PermissionAskedDataSchema = z.object({
  id: z.string(),
  action: z.string().optional(),
  resources: z.array(z.string()).optional(),
})
const PermissionRepliedDataSchema = z.object({ requestID: z.string() })
const SessionDataSchema = z.object({ sessionID: z.string().optional() })
const LegacySessionPropertiesSchema = z.object({
  sessionID: z.string().optional(),
  part: z.object({ sessionID: z.string().optional() }).optional(),
  info: z.object({ sessionID: z.string().optional() }).optional(),
})

type OpenCodeV2Session = z.infer<typeof OpenCodeV2SessionSchema>
type OpenCodeV2Provider = z.infer<typeof OpenCodeV2ProviderSchema>
type OpenCodeV2CatalogModel = z.infer<typeof OpenCodeV2CatalogModelSchema>

export class OpenCodeAdapter extends EventEmitter<Events> {
  readonly #spawn: Spawn
  readonly #configuredBaseUrl: string | undefined
  readonly #mcpServers: McpServerConfig[]
  readonly #mcpCredentials: Record<string, string>
  #baseUrl: string | undefined
  #server: { close(): void } | undefined
  #protocol: OpenCodeProtocol | undefined
  #authorization: string | undefined
  #client: OpencodeClient | undefined
  #workspacePath = ''
  #sessionId: string | undefined
  #threadId: string | undefined
  #turnId: string | undefined
  #turnCounter = 0
  /** Whether the server showed any session activity since the turn started. */
  #turnSawActivity = false
  #mapper: OpenCodeEventMapper | undefined
  #eventController: AbortController | undefined
  #approval: ApprovalMode = 'ask'
  #pendingApprovals = new Map<string, { request: ApprovalRequest; surfaced: boolean }>()
  #replyingApprovals = new Map<string, Promise<void>>()
  #model: string | undefined
  #effort: string | undefined
  #instructions: string | undefined
  #instructionsPending = false

  constructor(
    options: {
      baseUrl?: string
      mcpServers?: McpServerConfig[]
      mcpCredentials?: Record<string, string>
      spawn?: Spawn
    } = {},
  ) {
    super()
    this.#spawn = options.spawn ?? spawnCli
    this.#configuredBaseUrl = options.baseUrl
    this.#mcpServers = options.mcpServers ?? []
    this.#mcpCredentials = options.mcpCredentials ?? {}
  }

  get capabilities(): Capabilities {
    return OPENCODE_CAPABILITIES
  }

  async start(): Promise<void> {
    if (this.#baseUrl && this.#protocol) return
    if (this.#configuredBaseUrl) {
      this.#baseUrl = this.#configuredBaseUrl
      this.#protocol = await this.#detectProtocol()
      return
    }
    try {
      const config =
        this.#mcpServers.length > 0
          ? { mcp: openCodeMcpConfig(this.#mcpServers, this.#mcpCredentials) }
          : {}
      const server = await launchOpenCodeServer(config, this.#spawn)
      this.#server = server
      this.#baseUrl = server.url
      this.#authorization = server.authorization
      this.#protocol = await this.#detectProtocol()
    } catch {
      throw new Error('OpenCode is unavailable. Install it and run `opencode` once to sign in.')
    }
  }

  async startThread(workspacePath: string, options: OpenCodeStartOptions = {}): Promise<Thread> {
    this.#validateApproval(options.approval)
    await this.start()
    this.#workspacePath = workspacePath
    this.#approval = options.approval ?? 'ask'
    this.#model = options.model
    this.#effort = options.effort
    this.#instructions = options.instructions
    this.#instructionsPending = Boolean(options.instructions)
    if (this.#protocol === 'v2') {
      const model = openCodeV2Model(this.#model, this.#effort)
      const result = await this.#v2RequestParsed(
        '/api/session',
        {
          method: 'POST',
          body: JSON.stringify({
            title: 'TasteCode',
            location: { directory: workspacePath },
            ...(model ? { model } : {}),
          }),
        },
        SessionEnvelopeSchema,
      )
      const session = result.data
      this.#sessionId = session.id
      this.#threadId = `opencode-${session.id}`
      await this.#subscribe()
      return openCodeThread(session, workspacePath)
    }
    this.#client = this.#newClient(workspacePath)
    await this.#subscribe()
    const { data: session } = await this.#client.session.create({
      body: { title: 'TasteCode' },
      throwOnError: true,
    })
    this.#sessionId = session.id
    this.#threadId = `opencode-${session.id}`
    return {
      id: this.#threadId,
      provider: 'opencode',
      workspacePath,
      title: session.title,
      createdAt: session.time.created,
    }
  }

  async resumeThread(
    threadId: string,
    workspacePath: string,
    options: OpenCodeStartOptions = {},
  ): Promise<Thread> {
    this.#validateApproval(options.approval)
    await this.start()
    this.#workspacePath = workspacePath
    this.#approval = options.approval ?? 'ask'
    this.#model = options.model
    this.#effort = options.effort
    this.#instructions = options.instructions
    this.#instructionsPending = false
    const sessionId = threadId.startsWith('opencode-') ? threadId.slice(9) : threadId
    if (this.#protocol === 'v2') {
      const result = await this.#v2RequestParsed(
        `/api/session/${encodeURIComponent(sessionId)}`,
        {},
        SessionEnvelopeSchema,
      )
      const session = result.data
      this.#sessionId = session.id
      this.#threadId = `opencode-${session.id}`
      await this.#subscribe()
      return openCodeThread(session, workspacePath)
    }
    this.#client = this.#newClient(workspacePath)
    await this.#subscribe()
    const { data: session } = await this.#client.session.get({
      path: { id: sessionId },
      throwOnError: true,
    })
    this.#sessionId = session.id
    this.#threadId = `opencode-${session.id}`
    return {
      id: this.#threadId,
      provider: 'opencode',
      workspacePath,
      title: session.title,
      createdAt: session.time.created,
    }
  }

  async sendTurn(
    threadId: string,
    text: string,
    attachments: string[] = [],
    options: OpenCodeTurnOptions = {},
  ): Promise<string> {
    if (
      (this.#protocol === 'v1' && !this.#client) ||
      !this.#sessionId ||
      threadId !== this.#threadId
    ) {
      throw new Error('OpenCode session has not started')
    }
    if (attachments.length) throw new Error('OpenCode attachments are not supported yet')
    if (this.#turnId) throw new Error('a turn is already running')
    const selection = applyOpenCodeTurnOptions(
      { model: this.#model, effort: this.#effort },
      options,
    )
    this.#model = selection.model
    this.#effort = selection.effort
    const turnId = `${threadId}-turn-${++this.#turnCounter}`
    this.#turnId = turnId
    this.#turnSawActivity = false
    this.#mapper = new OpenCodeEventMapper(turnId, this.#model)
    this.emit('event', {
      type: 'turn.started',
      turn: { id: turnId, threadId, status: 'running', createdAt: Date.now() },
    })
    if (this.#protocol === 'v2') {
      void this.#sendV2Turn(text, turnId).catch(() => this.#failTurn(turnId))
      return turnId
    }
    const model = parseModel(this.#model)
    const variant =
      this.#effort && this.#effort !== OPENCODE_DEFAULT_VARIANT ? this.#effort : undefined
    void this.#client!.session.promptAsync({
      path: { id: this.#sessionId },
      body: {
        parts: [{ type: 'text', text }],
        ...(model ? { model } : {}),
        ...(variant ? { variant } : {}),
        ...(this.#instructions ? { system: this.#instructions } : {}),
      },
      throwOnError: true,
    }).catch(() => this.#failTurn(turnId))
    return turnId
  }

  async interrupt(threadId: string): Promise<void> {
    if (!this.#sessionId || threadId !== this.#threadId) return
    if (this.#protocol === 'v2') {
      await this.#v2Request(`/api/session/${encodeURIComponent(this.#sessionId)}/interrupt`, {
        method: 'POST',
      })
      this.#finishTurn('interrupted')
      return
    }
    if (!this.#client) return
    await this.#client.session.abort({
      path: { id: this.#sessionId },
      throwOnError: true,
    })
    this.#finishTurn('interrupted')
  }

  respondToApproval(approvalId: string, decision: ApprovalDecision): void {
    const pending = this.#pendingApprovals.get(approvalId)
    if (
      !this.#sessionId ||
      !pending ||
      this.#replyingApprovals.has(approvalId) ||
      (this.#protocol !== 'v2' && !this.#client)
    )
      return
    const response =
      decision === 'approve-session' ? 'always' : decision === 'approve' ? 'once' : 'reject'
    const reply = (
      this.#protocol === 'v2'
        ? this.#v2Request(
            `/api/session/${encodeURIComponent(this.#sessionId)}/permission/${encodeURIComponent(approvalId)}/reply`,
            { method: 'POST', body: JSON.stringify({ reply: response }) },
          )
        : this.#client!.postSessionIdPermissionsPermissionId({
            path: { id: this.#sessionId, permissionID: approvalId },
            body: { response },
            throwOnError: true,
          })
    ).then(() => undefined)
    this.#replyingApprovals.set(approvalId, reply)
    void reply
      .then(() => {
        if (
          this.#replyingApprovals.get(approvalId) === reply &&
          this.#pendingApprovals.get(approvalId) === pending &&
          this.#pendingApprovals.delete(approvalId)
        )
          this.emit('event', { type: 'approval.resolved', id: approvalId })
      })
      .catch(() => {
        if (this.#replyingApprovals.get(approvalId) !== reply) return
        this.#replyingApprovals.delete(approvalId)
        if (this.#pendingApprovals.get(approvalId) === pending && !pending.surfaced) {
          pending.surfaced = true
          this.emit('event', { type: 'approval.requested', request: pending.request })
        }
        this.emit('log', 'OpenCode permission response failed')
      })
      .finally(() => {
        if (this.#replyingApprovals.get(approvalId) === reply)
          this.#replyingApprovals.delete(approvalId)
      })
    if (decision === 'abort') {
      // The abort call can reject (server down, restarting); without a catch
      // that rejection escapes respondToApproval and kills the process.
      void this.interrupt(this.#threadId!).catch(() => this.emit('log', 'OpenCode abort failed'))
    }
  }

  /** Live access-level change; read again for every permission request. */
  setApproval(approval: ApprovalMode): void {
    this.#validateApproval(approval)
    this.#approval = approval
  }

  async listModels(): Promise<Model[]> {
    await this.start()
    if (this.#protocol === 'v2') return this.#listV2Models()
    const { data: result } = await this.#newClient().provider.list({
      throwOnError: true,
    })
    return result.all
      .filter((provider) => result.connected.includes(provider.id))
      .flatMap((provider) =>
        Object.values(provider.models).map((model) => {
          const reasoningEfforts = openCodeReasoningEfforts(model)
          return {
            id: `${provider.id}/${model.id}`,
            displayName: `${provider.name} · ${model.name}`,
            isDefault: result.default[provider.id] === model.id,
            reasoningEfforts,
            ...(reasoningEfforts.length > 0
              ? {
                  defaultReasoningEffort: OPENCODE_DEFAULT_VARIANT,
                }
              : {}),
            serviceTiers: [],
          }
        }),
      )
  }

  dispose(): void {
    this.#eventController?.abort()
    this.#server?.close()
    this.#eventController = undefined
    this.#server = undefined
    // Without this a disposed instance stays pointed at the closed port and a
    // later start() early-returns into connection errors instead of respawning.
    this.#baseUrl = this.#configuredBaseUrl
    this.#protocol = undefined
    this.#authorization = undefined
    this.#client = undefined
    this.#sessionId = undefined
    this.#threadId = undefined
    this.#turnId = undefined
    this.#model = undefined
    this.#effort = undefined
    this.#instructionsPending = false
    this.#pendingApprovals.clear()
    this.#replyingApprovals.clear()
  }

  #newClient(directory?: string): OpencodeClient {
    return createOpencodeClient({
      baseUrl: this.#baseUrl!,
      ...(directory ? { directory } : {}),
      ...(this.#authorization
        ? {
            headers: { authorization: this.#authorization },
          }
        : {}),
    })
  }

  async #subscribe(): Promise<void> {
    this.#eventController?.abort()
    const controller = new AbortController()
    this.#eventController = controller
    if (this.#protocol === 'v2') {
      await this.#subscribeV2(controller)
      return
    }
    const { stream } = await this.#client!.event.subscribe({ signal: controller.signal })
    void (async () => {
      try {
        for await (const event of stream) this.#onEvent(event)
      } catch {
        if (!controller.signal.aborted) {
          this.emit('log', 'OpenCode event stream disconnected')
          this.#failTurn()
        }
      }
    })()
  }

  async #detectProtocol(): Promise<OpenCodeProtocol> {
    try {
      const response = await fetch(new URL('/api/health', this.#baseUrl), {
        headers: this.#authorization ? { authorization: this.#authorization } : {},
        signal: AbortSignal.timeout(1500),
      })
      if (!response.ok) return 'v1'
      const health = HealthSchema.safeParse(await response.json())
      return health.success && health.data.healthy ? 'v2' : 'v1'
    } catch {
      return 'v1'
    }
  }

  async #v2Request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers)
    if (this.#authorization) headers.set('authorization', this.#authorization)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const response = await fetch(new URL(path, this.#baseUrl), { ...init, headers })
    if (!response.ok) throw new Error(`OpenCode v2 request failed (${response.status})`)
    if (response.status === 204) return undefined
    return response.json()
  }

  #v2RequestParsed<Result>(
    path: string,
    init: RequestInit,
    result: z.ZodType<Result>,
  ): Promise<Result> {
    return this.#v2Request(path, init).then((value) => result.parse(value))
  }

  async #subscribeV2(controller: AbortController): Promise<void> {
    const response = await fetch(new URL('/api/event', this.#baseUrl), {
      headers: this.#authorization ? { authorization: this.#authorization } : {},
      signal: controller.signal,
    })
    if (!response.ok || !response.body) throw new Error('OpenCode v2 event stream failed')
    void readOpenCodeSse(response.body, (event) => this.#onEvent(event), controller.signal).catch(
      () => {
        if (!controller.signal.aborted) {
          this.emit('log', 'OpenCode event stream disconnected')
          this.#failTurn()
        }
      },
    )
  }

  async #sendV2Turn(text: string, turnId: string): Promise<void> {
    const sessionId = this.#sessionId!
    const model = openCodeV2Model(this.#model, this.#effort)
    if (model) {
      await this.#v2Request(`/api/session/${encodeURIComponent(sessionId)}/model`, {
        method: 'POST',
        body: JSON.stringify({ model }),
      })
    }
    if (this.#turnId !== turnId) return
    const prompt =
      this.#instructionsPending && this.#instructions ? `${this.#instructions}\n\n${text}` : text
    await this.#v2Request(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text: prompt }),
    })
    this.#instructionsPending = false
  }

  async #listV2Models(): Promise<Model[]> {
    const location = `?location%5Bdirectory%5D=${encodeURIComponent(this.#workspacePath || process.cwd())}`
    let providers: OpenCodeV2Provider[] = []
    let models: OpenCodeV2CatalogModel[] = []
    // The v2 service starts accepting HTTP before its location-scoped catalog
    // has loaded. Retry that empty-but-successful state briefly; otherwise the
    // first picker open would incorrectly fall back to "Provider default".
    for (let attempt = 0; attempt < 5; attempt += 1) {
      providers = (
        await this.#v2RequestParsed(`/api/provider${location}`, {}, ProviderEnvelopeSchema)
      ).data
      models = (await this.#v2RequestParsed(`/api/model${location}`, {}, ModelEnvelopeSchema)).data
      if (models.length > 0) break
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    // A cold v2 service can publish connected providers one tick before its
    // model catalog. Resolving those providers once triggers catalog loading;
    // this stays data-driven and avoids any provider-name special case.
    if (models.length === 0 && providers.length > 0) {
      await Promise.all(
        providers.map((provider) =>
          this.#v2Request(`/api/provider/${encodeURIComponent(provider.id)}${location}`),
        ),
      )
      models = (await this.#v2RequestParsed(`/api/model${location}`, {}, ModelEnvelopeSchema)).data
    }
    const agents = await this.#v2RequestParsed(
      `/api/agent${location}`,
      {},
      AgentEnvelopeSchema,
    ).catch(() => ({ data: [] }))
    const defaultModel =
      agents.data.find((agent) => agent.id === 'build')?.model ??
      agents.data.find((agent) => agent.mode === 'primary')?.model
    const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]))
    return models
      .filter((model) => model.enabled !== false && providerNames.has(model.providerID))
      .map((model) => {
        const reasoningEfforts = openCodeReasoningEfforts(model)
        return {
          id: `${model.providerID}/${model.id}`,
          displayName: `${providerNames.get(model.providerID)} · ${model.name}`,
          isDefault: defaultModel?.providerID === model.providerID && defaultModel.id === model.id,
          reasoningEfforts,
          ...(reasoningEfforts.length > 0
            ? {
                defaultReasoningEffort: OPENCODE_DEFAULT_VARIANT,
              }
            : {}),
          serviceTiers: [],
        }
      })
  }

  #onV2Event(event: OpenCodeV2Event): void {
    const data = event.data
    if (event.type === 'permission.asked') {
      const permission = PermissionAskedDataSchema.safeParse(data)
      if (!permission.success) return
      const approvalId = permission.data.id
      const action = permission.data.action ?? ''
      const resources = permission.data.resources ?? []
      const command = /bash|shell|command|execute/i.test(action)
      const request: ApprovalRequest = {
        id: approvalId,
        kind: command ? 'command' : 'file_change',
        ...(command
          ? { command: resources.join(' ') || action }
          : { path: resources[0] || action }),
        createdAt: event.created ?? Date.now(),
      }
      const surfaced = this.#approval === 'ask' || (this.#approval === 'auto' && command)
      this.#pendingApprovals.set(approvalId, { request, surfaced })
      if (this.#approval === 'full' || (this.#approval === 'auto' && !command)) {
        this.respondToApproval(
          approvalId,
          this.#approval === 'full' ? 'approve-session' : 'approve',
        )
        return
      }
      this.emit('event', {
        type: 'approval.requested',
        request,
      })
      return
    }
    if (event.type === 'permission.replied') {
      const permission = PermissionRepliedDataSchema.safeParse(data)
      if (permission.success && this.#pendingApprovals.delete(permission.data.requestID)) {
        const approvalId = permission.data.requestID
        this.emit('event', { type: 'approval.resolved', id: approvalId })
      }
      return
    }
    if (sessionId(event) === this.#sessionId) this.#turnSawActivity = true
    if (this.#mapper) {
      for (const domainEvent of this.#mapper.translate(event)) this.emit('event', domainEvent)
    }
    if (event.type === 'session.execution.succeeded') this.#finishTurn('completed')
    else if (event.type === 'session.execution.interrupted') this.#finishTurn('interrupted')
    else if (event.type === 'session.execution.failed' || event.type === 'session.step.failed') {
      this.#failTurn()
    }
  }

  #onEvent(event: OpenCodeWireEvent): void {
    if (sessionId(event) !== undefined && sessionId(event) !== this.#sessionId) return
    if ('data' in event) {
      this.#onV2Event(event)
      return
    }
    if (event.type === 'permission.updated') {
      const permission = event.properties
      const command = /bash|shell|command/i.test(permission.type)
      const request: ApprovalRequest = {
        id: permission.id,
        kind: command ? 'command' : 'file_change',
        ...(command ? { command: permission.title } : { path: permission.title }),
        createdAt: permission.time.created,
      }
      const autoReply = this.#approval === 'full' || (this.#approval === 'auto' && !command)
      this.#pendingApprovals.set(permission.id, { request, surfaced: !autoReply })
      if (autoReply) {
        this.respondToApproval(
          permission.id,
          this.#approval === 'full' ? 'approve-session' : 'approve',
        )
        return
      }
      this.emit('event', {
        type: 'approval.requested',
        request,
      })
      return
    }
    if (event.type === 'session.error') {
      this.#failTurn()
      return
    }
    if (
      event.type === 'session.idle' ||
      (event.type === 'session.status' && event.properties.status.type === 'idle')
    ) {
      // One completion emits BOTH `session.status idle` and `session.idle`
      // (captured ~1ms apart against the real server). The next turn starts
      // synchronously inside the first one's turn.completed, so the duplicate
      // arrives for a brand-new turn the server has not even seen — finishing
      // it here would report an empty successful turn and stall the caller.
      // Only an idle for a turn with observed session activity may finish it.
      if (!this.#turnSawActivity) return
      this.#finishTurn('completed')
      return
    }
    if (sessionId(event) === this.#sessionId) this.#turnSawActivity = true
    if (!this.#mapper) return
    for (const domainEvent of this.#mapper.translate(event)) this.emit('event', domainEvent)
  }

  #finishTurn(status: 'completed' | 'interrupted'): void {
    if (!this.#turnId) return
    const turnId = this.#turnId
    const finishEvents = this.#mapper?.finish() ?? []
    const approvals = [...this.#pendingApprovals.keys()]
    this.#pendingApprovals.clear()
    // Live-turn state clears before any emit: the orchestrator reacts to
    // `turn.completed` synchronously inside the emit (the design flow sends
    // the next phase prompt right there), and that sendTurn must not be
    // refused as "a turn is already running" (#373).
    this.#turnId = undefined
    this.#mapper = undefined
    for (const event of finishEvents) this.emit('event', event)
    for (const id of approvals) this.emit('event', { type: 'approval.resolved', id })
    this.emit('event', { type: 'turn.completed', turnId, status })
  }

  /** When `turnId` is given, no-op unless it is still the live turn — a late
   *  rejection from a finished turn must not fail whatever runs now. */
  #failTurn(turnId?: string): void {
    if (turnId !== undefined && this.#turnId !== turnId) return
    if (!this.#turnId || !this.#threadId) return
    const failedTurnId = this.#turnId
    const threadId = this.#threadId
    const finishEvents = this.#mapper?.finish('failed') ?? []
    const approvals = [...this.#pendingApprovals.keys()]
    this.#pendingApprovals.clear()
    // Same ordering as #finishTurn: listeners may start the next turn inside
    // these emits, so the live-turn state must already be gone.
    this.#turnId = undefined
    this.#mapper = undefined
    for (const event of finishEvents) this.emit('event', event)
    for (const id of approvals) this.emit('event', { type: 'approval.resolved', id })
    this.emit('log', 'OpenCode request failed')
    this.emit('event', {
      type: 'thread.error',
      threadId,
      message: 'The OpenCode request failed.',
    })
    this.emit('event', { type: 'turn.completed', turnId: failedTurnId, status: 'failed' })
  }

  #validateApproval(approval: ApprovalMode | undefined): void {
    if (approval === 'auto-review') {
      throw new Error('OpenCode does not support automatic approval review')
    }
  }
}

function parseModel(
  value: string | undefined,
): { providerID: string; modelID: string } | undefined {
  if (!value) return undefined
  const slash = value.indexOf('/')
  if (slash < 1 || slash === value.length - 1) throw new Error('OpenCode models use provider/model')
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
}

function openCodeThread(session: OpenCodeV2Session, workspacePath: string): Thread {
  return {
    id: `opencode-${session.id}`,
    provider: 'opencode',
    workspacePath,
    title: session.title || 'OpenCode session',
    createdAt: session.time?.created ?? Date.now(),
  }
}

function openCodeV2Model(
  value: string | undefined,
  effort: string | undefined,
): { id: string; providerID: string; variant?: string } | undefined {
  const model = parseModel(value)
  if (!model) return undefined
  const variant = effort && effort !== OPENCODE_DEFAULT_VARIANT ? effort : undefined
  return {
    id: model.modelID,
    providerID: model.providerID,
    ...(variant ? { variant: variant } : {}),
  }
}

async function launchOpenCodeServer(
  config: Record<string, JsonRpcValue>,
  spawn: Spawn = spawnCli,
): Promise<{
  url: string
  authorization: string
  close(): void
}> {
  // OpenCode v2 currently fixes the Basic-auth username to `opencode`; only
  // the password is configurable on the wire.
  const username = 'opencode'
  const password = randomUUID()
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  return new Promise((resolve, reject) => {
    const child = spawn('opencode', ['serve', '--hostname=127.0.0.1', '--port=0'], {
      env: {
        OPENCODE_SERVER_USERNAME: username,
        OPENCODE_SERVER_PASSWORD: password,
        ...(Object.keys(config).length > 0
          ? {
              OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
            }
          : {}),
      },
    })
    let output = ''
    let settled = false
    const finish = (error?: Error, url?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error || !url) {
        killTree(child)
        reject(error ?? new Error('OpenCode server did not publish a URL'))
        return
      }
      resolve({ url, authorization, close: () => killTree(child) })
    }
    const timer = setTimeout(() => finish(new Error('OpenCode server did not start')), 7000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output = `${output}${chunk}`.slice(-4096)
      const match = output.match(/(?:opencode\s+)?server listening on\s+(https?:\/\/[^\s]+)/i)
      if (match?.[1]) finish(undefined, match[1])
    })
    // Drain stderr without copying it into an exception: startup diagnostics
    // can include auth details, and the actionable error is the safe one above.
    child.stderr.on('data', () => undefined)
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      if (!settled) finish(new Error(`OpenCode server exited with code ${code ?? 'unknown'}`))
    })
  })
}

async function readOpenCodeSse(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: OpenCodeV2Event) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (!signal.aborted) {
      const result = await reader.read()
      if (result.done) return
      buffer += decoder.decode(result.value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (!data) continue
        try {
          const parsed = OpenCodeV2EventSchema.safeParse(JSON.parse(data))
          if (parsed.success) onEvent(parsed.data)
        } catch {
          // One malformed frame must not disconnect an otherwise healthy SSE
          // stream; OpenCode will publish the next durable event independently.
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function sessionId(event: OpenCodeWireEvent): string | undefined {
  if ('data' in event) {
    const data = SessionDataSchema.safeParse(event.data)
    return data.success ? data.data.sessionID : undefined
  }
  const properties = LegacySessionPropertiesSchema.safeParse(event.properties)
  return properties.success
    ? (properties.data.sessionID ??
        properties.data.part?.sessionID ??
        properties.data.info?.sessionID)
    : undefined
}
