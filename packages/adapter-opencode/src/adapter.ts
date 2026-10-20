import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type {
  ApprovalDecision,
  ApprovalMode,
  ApprovalRequest,
  Capabilities,
  DomainEvent,
  McpServer,
  McpServerConfig,
  Model,
  ProviderCommand,
  Skill,
  Thread,
} from '@harness/contracts'
import { createOpencodeClient, type Event, type OpencodeClient } from '@opencode-ai/sdk'
import {
  JsonRpcValueSchema,
  killTree,
  nativeShimTarget,
  readSseData,
  spawnCli,
  type JsonRpcValue,
} from '@harness/proc'
import { mapOpenCodeCommands, mapOpenCodeMcpServers, mapOpenCodeSkills } from './inventory.js'
import { z } from 'zod'
import {
  OpenCodeEventMapper,
  OpenCodeV2EventSchema,
  type OpenCodeV2Event,
  type OpenCodeWireEvent,
} from './events.js'
import { openCodeModels, type OpenCodeCatalogEntry } from './models.js'

export const OPENCODE_CAPABILITIES: Capabilities = {
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: true,
  approvals: true,
  images: false,
}

type Events = { event: [DomainEvent]; log: [string]; disconnected: [] }
/** `/mcp` waits for the directory's servers to connect; a stuck one must not hold a read. */
const INVENTORY_TIMEOUT_MS = 20_000
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
/**
 * `opencode serve` took 9-36 s to print its URL on a loaded PC. The old 7 s limit
 * failed three of four such starts, each of which then had to be killed.
 */
export const OPENCODE_SERVER_START_TIMEOUT_MS = 30_000

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
const OpenCodeV2CatalogModelSchema = z.object({
  id: z.string(),
  providerID: z.string(),
  variants: JsonRpcValueSchema.optional(),
})
const ModelEnvelopeSchema = z.object({ data: z.array(OpenCodeV2CatalogModelSchema) })
/**
 * `GET /config/providers`, captured from 1.18.13: only the providers OpenCode
 * can reach (a stored credential, a provider key in the environment, a config
 * entry, or OpenCode's own free tier), each with the models it can run, which
 * leaves out deprecated ones. It is the set `opencode models` prints. Both
 * protocols serve it; v2's `/api/provider` and `/api/model` instead return
 * the whole models.dev catalog while they warm up.
 */
const ConnectedModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string().optional(),
  capabilities: z
    .object({
      toolcall: z.boolean().optional(),
      output: z.object({ text: z.boolean().optional() }).optional(),
    })
    .optional(),
  status: z.string().optional(),
  release_date: z.string().optional(),
  variants: JsonRpcValueSchema.optional(),
})
const ConnectedProvidersSchema = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      models: z.record(z.string(), ConnectedModelSchema),
    }),
  ),
  default: z.record(z.string(), z.string()).optional(),
})
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
/**
 * 1.18.31's v1 stream asks with `permission.asked`, not `permission.updated`:
 * the permission names the tool's class (bash, edit, external_directory) and
 * the metadata carries the command or file.
 */
const V1PermissionAskedSchema = z.object({
  type: z.literal('permission.asked'),
  properties: z.object({
    id: z.string(),
    permission: z.string(),
    patterns: z.array(z.string()).optional(),
    metadata: z.record(z.string(), JsonRpcValueSchema).optional(),
  }),
})
const V1PermissionRepliedSchema = z.object({
  type: z.literal('permission.replied'),
  properties: PermissionRepliedDataSchema,
})
const SessionDataSchema = z.object({ sessionID: z.string().optional() })
const LegacySessionPropertiesSchema = z.object({
  sessionID: z.string().optional(),
  part: z.object({ sessionID: z.string().optional() }).optional(),
  info: z.object({ sessionID: z.string().optional() }).optional(),
})

type OpenCodeV2Session = z.infer<typeof OpenCodeV2SessionSchema>
type OpenCodeV2CatalogModel = z.infer<typeof OpenCodeV2CatalogModelSchema>
type ConnectedProviders = z.infer<typeof ConnectedProvidersSchema>

export class OpenCodeAdapter extends EventEmitter<Events> {
  #processStop: Promise<void> = Promise.resolve()
  readonly #spawn: Spawn
  /** Only the default launch looks for the executable behind npm's shim. */
  readonly #customSpawn: boolean
  readonly #configuredBaseUrl: string | undefined
  readonly #mcpServers: McpServerConfig[]
  readonly #mcpCredentials: Record<string, string>
  readonly #config: Record<string, JsonRpcValue>
  readonly #environment: Record<string, string>
  #baseUrl: string | undefined
  #server: { close(): Promise<void> } | undefined
  #starting: Promise<void> | undefined
  /** Stops a serve that has not printed its URL yet; #server cannot reach it. */
  #launchAbort: AbortController | undefined
  #generation = 0
  #protocol: OpenCodeProtocol | undefined
  #authorization: string | undefined
  #client: OpencodeClient | undefined
  #workspacePath = ''
  #sessionId: string | undefined
  #threadId: string | undefined
  #turnId: string | undefined
  /** Whether the server showed any session activity since the turn started. */
  #turnSawActivity = false
  #mapper: OpenCodeEventMapper | undefined
  #eventController: AbortController | undefined
  #streamFailure: Error | undefined
  #disconnected = false
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
      /** Extra opencode config for the launched server, beside the MCP block. */
      config?: Record<string, JsonRpcValue>
      /** Extra variables for the launched server, such as a key the config references. */
      environment?: Record<string, string>
      spawn?: Spawn
    } = {},
  ) {
    super()
    this.#spawn = options.spawn ?? spawnCli
    this.#customSpawn = options.spawn !== undefined
    this.#configuredBaseUrl = options.baseUrl
    this.#mcpServers = options.mcpServers ?? []
    this.#mcpCredentials = options.mcpCredentials ?? {}
    this.#config = options.config ?? {}
    this.#environment = options.environment ?? {}
  }

  get capabilities(): Capabilities {
    return OPENCODE_CAPABILITIES
  }

  /**
   * Model listing and thread start can race on a fresh instance. They share one
   * launch so the losing call cannot orphan a second `opencode serve` process.
   */
  async start(): Promise<void> {
    if (this.#baseUrl && this.#protocol) return
    if (!this.#starting) {
      const starting = this.#launch().finally(() => {
        if (this.#starting === starting) this.#starting = undefined
      })
      this.#starting = starting
    }
    return this.#starting
  }

  async #launch(): Promise<void> {
    if (this.#configuredBaseUrl) {
      this.#baseUrl = this.#configuredBaseUrl
      this.#protocol = await this.#detectProtocol()
      return
    }
    const generation = this.#generation
    const abort = new AbortController()
    this.#launchAbort = abort
    let server: Awaited<ReturnType<typeof launchOpenCodeServer>>
    try {
      const config = {
        ...this.#config,
        ...(this.#mcpServers.length > 0
          ? { mcp: openCodeMcpConfig(this.#mcpServers, this.#mcpCredentials) }
          : {}),
      }
      server = await launchOpenCodeServer(
        config,
        this.#spawn,
        this.#customSpawn ? 'opencode' : ((await nativeShimTarget('opencode')) ?? 'opencode'),
        abort.signal,
        this.#environment,
      )
    } catch {
      if (generation !== this.#generation)
        throw new Error('OpenCode stopped while it was starting.')
      throw new Error('OpenCode is unavailable. Install it and run `opencode` once to sign in.')
    } finally {
      if (this.#launchAbort === abort) this.#launchAbort = undefined
    }
    // dispose() cannot reach a server that was still launching.
    if (generation !== this.#generation) {
      await server.close()
      throw new Error('OpenCode stopped while it was starting.')
    }
    this.#server = server
    this.#baseUrl = server.url
    this.#authorization = server.authorization
    const protocol = await this.#detectProtocol()
    if (generation !== this.#generation) throw new Error('OpenCode stopped while it was starting.')
    this.#protocol = protocol
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
      if (this.#streamFailure) throw this.#streamFailure
      return openCodeThread(session, workspacePath)
    }
    this.#client = this.#newClient(workspacePath)
    await this.#subscribe()
    const { data: session } = await this.#client.session.create({
      body: { title: 'TasteCode' },
      throwOnError: true,
    })
    if (this.#streamFailure) throw this.#streamFailure
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
      if (this.#streamFailure) throw this.#streamFailure
      return openCodeThread(session, workspacePath)
    }
    this.#client = this.#newClient(workspacePath)
    await this.#subscribe()
    const { data: session } = await this.#client.session.get({
      path: { id: sessionId },
      throwOnError: true,
    })
    if (this.#streamFailure) throw this.#streamFailure
    this.#sessionId = session.id
    this.#threadId = `opencode-${session.id}`
    // A turn without a model runs on the user's global OpenCode default, not
    // on the model this chat used; keep the chat's own.
    this.#model ??= await this.#lastV1Model(session.id)
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
    if (this.#streamFailure) throw this.#streamFailure
    if (this.#turnId) throw new Error('a turn is already running')
    const selection = applyOpenCodeTurnOptions(
      { model: this.#model, effort: this.#effort },
      options,
    )
    // v1 parses the model synchronously. Do it before the turn opens: a throw
    // after turn.started left #turnId set and refused every later turn.
    const model = this.#protocol === 'v1' ? parseModel(selection.model) : undefined
    this.#model = selection.model
    this.#effort = selection.effort
    const turnId = `${threadId}-turn-${randomUUID()}`
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

  onDisconnected(listener: () => void): () => void {
    this.on('disconnected', listener)
    // The stream may end between opening the session and its owner attaching.
    if (this.#disconnected) listener()
    return () => this.off('disconnected', listener)
  }

  /**
   * The models of the providers OpenCode reports as connected, newest first.
   * A model of a provider without a credential cannot run, so it is never
   * offered, however large the models.dev catalog behind it is.
   */
  async listModels(): Promise<Model[]> {
    await this.start()
    const directory = this.#workspacePath || process.cwd()
    const [connected, v2] = await Promise.all([
      this.#readConnectedProviders(directory),
      this.#protocol === 'v2' ? this.#readV2ModelDetails(directory) : undefined,
    ])
    return openCodeModels(
      connected.providers.flatMap((provider) =>
        Object.values(provider.models)
          .filter((model) => model.status !== 'deprecated')
          .map((model): OpenCodeCatalogEntry => {
            const id = `${provider.id}/${model.id}`
            // A v2 session takes a variant from v2's own catalog row, so v2 offers
            // only those; 1.18.13 lists none there and the effort stays OpenCode's.
            const reasoningEfforts = openCodeReasoningEfforts(v2 ? v2.catalog.get(id) : model)
            return {
              providerID: provider.id,
              providerName: provider.name,
              modelID: model.id,
              name: model.name,
              family: model.family,
              status: model.status,
              releaseDate: model.release_date,
              toolCall: model.capabilities?.toolcall,
              textOutput: model.capabilities?.output?.text,
              isDefault: v2
                ? v2.defaultModel === id
                : connected.default?.[provider.id] === model.id,
              reasoningEfforts,
              ...(reasoningEfforts.length > 0
                ? { defaultReasoningEffort: OPENCODE_DEFAULT_VARIANT }
                : {}),
            }
          }),
      ),
    )
  }

  dispose(): Promise<void> {
    this.#eventController?.abort()
    // A serve still starting can take 30 s to print its URL. Stop it now and wait
    // for it: a host that exits after dispose would otherwise orphan it.
    this.#launchAbort?.abort()
    const launching = this.#starting?.then(
      () => undefined,
      () => undefined,
    )
    const closing = this.#server?.close() ?? this.#processStop
    const stopped = launching ? Promise.all([closing, launching]).then(() => undefined) : closing
    this.#generation += 1
    this.#starting = undefined
    this.#eventController = undefined
    this.#disconnected = false
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
    this.#processStop = stopped
    return stopped
  }

  /** Commands and skills OpenCode runs itself when a message starts with `/name`. */
  async listCommands(_threadId?: string): Promise<ProviderCommand[]> {
    return this.commands(this.#workspacePath)
  }

  /** The MCP servers this chat's server loaded, with their state. */
  async listMcpServers(_threadId?: string): Promise<McpServer[]> {
    return this.mcpServers(this.#workspacePath)
  }

  async commands(directory: string): Promise<ProviderCommand[]> {
    return mapOpenCodeCommands(await this.#inventory('/command', directory))
  }

  async skills(directory: string): Promise<Skill[]> {
    return mapOpenCodeSkills(await this.#inventory('/skill', directory), directory)
  }

  /** OpenCode connects a directory's servers on the first read, which can take seconds. */
  async mcpServers(directory: string): Promise<McpServer[]> {
    return mapOpenCodeMcpServers(await this.#inventory('/mcp', directory))
  }

  #inventory(route: '/command' | '/skill' | '/mcp', directory: string): Promise<unknown> {
    if (!this.#baseUrl || !directory) return Promise.reject(new Error('OpenCode is not running'))
    return this.#v2Request(`${route}?directory=${encodeURIComponent(directory)}`, {
      signal: AbortSignal.timeout(INVENTORY_TIMEOUT_MS),
    })
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
    this.#streamFailure = undefined
    this.#disconnected = false
    this.#eventController?.abort()
    const controller = new AbortController()
    this.#eventController = controller
    const protocol = this.#protocol!
    const url = new URL(protocol === 'v2' ? '/api/event' : '/event', this.#baseUrl)
    if (protocol === 'v1') url.searchParams.set('directory', this.#workspacePath)
    const response = await fetch(url, {
      headers: this.#authorization ? { authorization: this.#authorization } : {},
      signal: controller.signal,
    })
    if (!response.ok || !response.body) throw new Error('OpenCode event stream failed')
    void readOpenCodeSse(
      response.body,
      (event) => this.#onEvent(event),
      controller.signal,
      protocol,
    )
      .catch(() => undefined)
      .finally(() => {
        if (controller.signal.aborted || controller !== this.#eventController) return
        this.#streamFailure = new Error('OpenCode event stream disconnected')
        this.emit('log', this.#streamFailure.message)
        this.#failTurn()
        // A terminal listener may already have disposed or replaced this stream.
        if (controller.signal.aborted || controller !== this.#eventController) return
        this.#disconnected = true
        this.emit('disconnected')
      })
  }

  /** The newest model a v1 session ran on; a failed read leaves the model unset. */
  async #lastV1Model(sessionId: string): Promise<string | undefined> {
    try {
      const { data } = await this.#client!.session.messages({
        path: { id: sessionId },
        query: { limit: 20 },
        throwOnError: true,
      })
      if (!Array.isArray(data)) return undefined
      for (const { info } of [...data].reverse()) {
        if (info.role === 'user') return `${info.model.providerID}/${info.model.modelID}`
        if (info.role === 'assistant') return `${info.providerID}/${info.modelID}`
      }
    } catch {
      // The turn still names its own model when the user picks one.
    }
    return undefined
  }

  /**
   * 1.18.31 serves both protocols, and its v2 admits a prompt without ever
   * running the agent loop (`/wait` answers "not available yet"). So v1 wins
   * while the server still has it; only a v2-only server gets v2.
   */
  async #detectProtocol(): Promise<OpenCodeProtocol> {
    try {
      const response = await fetch(new URL('/path', this.#baseUrl), {
        headers: this.#authorization ? { authorization: this.#authorization } : {},
        signal: AbortSignal.timeout(1500),
      })
      if (response.ok) return 'v1'
    } catch {
      // Unreachable or slow: the v2 probe below decides.
    }
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

  async #readConnectedProviders(directory: string): Promise<ConnectedProviders> {
    if (this.#protocol === 'v2') {
      // The route predates v2 and answers on the same server; it waits for the
      // catalog to load, so a cold start needs no retry.
      return this.#v2RequestParsed(
        `/config/providers?directory=${encodeURIComponent(directory)}`,
        {},
        ConnectedProvidersSchema,
      )
    }
    const { data } = await this.#newClient(directory).config.providers({ throwOnError: true })
    return ConnectedProvidersSchema.parse(data)
  }

  /**
   * The build agent's model and v2's catalog rows, which carry the variants a
   * v2 session accepts. Either may be missing on a cold start; neither decides
   * which models are offered.
   */
  async #readV2ModelDetails(directory: string): Promise<{
    defaultModel: string | undefined
    catalog: Map<string, OpenCodeV2CatalogModel>
  }> {
    const location = `?location%5Bdirectory%5D=${encodeURIComponent(directory)}`
    const [agents, catalog] = await Promise.all([
      this.#v2RequestParsed(`/api/agent${location}`, {}, AgentEnvelopeSchema).catch(() => ({
        data: [],
      })),
      this.#v2RequestParsed(`/api/model${location}`, {}, ModelEnvelopeSchema).catch(() => ({
        data: [],
      })),
    ])
    const agentModel =
      agents.data.find((agent) => agent.id === 'build')?.model ??
      agents.data.find((agent) => agent.mode === 'primary')?.model
    return {
      defaultModel: agentModel ? `${agentModel.providerID}/${agentModel.id}` : undefined,
      catalog: new Map(catalog.data.map((model) => [`${model.providerID}/${model.id}`, model])),
    }
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
        // A persistent engine grant would bypass a later switch back to Ask.
        this.respondToApproval(approvalId, 'approve')
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
    const asked = V1PermissionAskedSchema.safeParse(event)
    if (asked.success) {
      const { id, permission, patterns = [], metadata = {} } = asked.data.properties
      const command = /bash|shell|command|execute/i.test(permission)
      const named = (key: string) => (typeof metadata[key] === 'string' ? metadata[key] : '')
      const request: ApprovalRequest = {
        id,
        kind: command ? 'command' : 'file_change',
        ...(command
          ? { command: named('command') || patterns.join(' ') || permission }
          : { path: named('filepath') || patterns[0] || permission }),
        createdAt: Date.now(),
      }
      const autoReply = this.#approval === 'full' || (this.#approval === 'auto' && !command)
      this.#pendingApprovals.set(id, { request, surfaced: !autoReply })
      if (autoReply) {
        // Session grants are reserved for an explicit user approval.
        this.respondToApproval(id, 'approve')
        return
      }
      this.emit('event', { type: 'approval.requested', request })
      return
    }
    const replied = V1PermissionRepliedSchema.safeParse(event)
    if (replied.success) {
      // Answered elsewhere, or by a rule the user saved with "always".
      const approvalId = replied.data.properties.requestID
      if (this.#pendingApprovals.delete(approvalId)) {
        this.emit('event', { type: 'approval.resolved', id: approvalId })
      }
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
        // Session grants are reserved for an explicit user approval.
        this.respondToApproval(permission.id, 'approve')
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
  /** opencode.exe itself where npm installed it, so its pid is the server's and cleanup reaches it. */
  command = 'opencode',
  /** Aborted when the adapter is disposed: the serve is stopped before it prints its URL. */
  signal?: AbortSignal,
  environment: Record<string, string> = {},
): Promise<{
  url: string
  authorization: string
  close(): Promise<void>
}> {
  // OpenCode v2 currently fixes the Basic-auth username to `opencode`; only
  // the password is configurable on the wire.
  const username = 'opencode'
  const password = randomUUID()
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  if (signal?.aborted) throw new Error('OpenCode stopped while it was starting.')
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['serve', '--hostname=127.0.0.1', '--port=0'], {
      env: {
        ...environment,
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
    const stop = () => finish(new Error('OpenCode stopped while it was starting.'))
    const finish = (error?: Error, url?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      if (error || !url) {
        void killTree(child).then(
          () => reject(error ?? new Error('OpenCode server did not publish a URL')),
          reject,
        )
        return
      }
      resolve({ url, authorization, close: () => killTree(child) })
    }
    const timer = setTimeout(
      () => finish(new Error('OpenCode server did not start')),
      OPENCODE_SERVER_START_TIMEOUT_MS,
    )
    signal?.addEventListener('abort', stop, { once: true })
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

const OpenCodeV1EventSchema = z.object({
  type: z.string(),
  properties: z.record(z.string(), JsonRpcValueSchema),
})

async function readOpenCodeSse(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: OpenCodeWireEvent) => void,
  signal: AbortSignal,
  protocol: OpenCodeProtocol,
): Promise<void> {
  for await (const data of readSseData(stream)) {
    if (signal.aborted) return
    if (!data) continue
    try {
      const value: unknown = JSON.parse(data)
      if (protocol === 'v2') {
        const parsed = OpenCodeV2EventSchema.safeParse(value)
        if (parsed.success) onEvent(parsed.data)
      } else {
        const parsed = OpenCodeV1EventSchema.safeParse(value)
        // SAFETY: The SDK also validates only JSON. Check the common envelope
        // first; the mapper consumes the captured event variants, and the
        // surrounding catch discards malformed variant-specific payloads.
        if (parsed.success) onEvent(parsed.data as Event)
      }
    } catch {
      // A malformed event does not invalidate the following durable event.
    }
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
