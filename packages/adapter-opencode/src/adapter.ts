import { EventEmitter } from 'node:events'
import type {
  ApprovalDecision,
  ApprovalMode,
  Capabilities,
  DomainEvent,
  McpServerConfig,
  Model,
  Thread,
} from '@harness/contracts'
import {
  createOpencodeClient,
  createOpencodeServer,
  type Event,
  type OpencodeClient,
} from '@opencode-ai/sdk'
import { OpenCodeEventMapper } from './events.js'

export const OPENCODE_CAPABILITIES: Capabilities = {
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: true,
  approvals: true,
  images: false,
}

type Events = { event: [DomainEvent]; log: [string] }

/**
 * Harness MCP config as the `mcp` block of an opencode config. Credential
 * references resolve here — the reference, never the secret, is what crossed
 * the protocol. Verified against opencode 1.x: `OPENCODE_CONFIG_CONTENT`
 * accepts `{ mcp: { name: { type: 'local'|'remote', ... } } }`.
 */
export function openCodeMcpConfig(
  servers: McpServerConfig[],
  credentials: Record<string, string>,
): Record<string, unknown> {
  const resolve = (
    value: { source: 'literal'; value: string } | { source: 'credential'; credentialRef: string },
  ) => (value.source === 'literal' ? value.value : (credentials[value.credentialRef] ?? ''))
  const mcp: Record<string, unknown> = {}
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

export class OpenCodeAdapter extends EventEmitter<Events> {
  readonly #configuredBaseUrl: string | undefined
  readonly #mcpServers: McpServerConfig[]
  readonly #mcpCredentials: Record<string, string>
  #baseUrl: string | undefined
  #server: { close(): void } | undefined
  #client: OpencodeClient | undefined
  #workspacePath = ''
  #sessionId: string | undefined
  #threadId: string | undefined
  #turnId: string | undefined
  #turnCounter = 0
  #mapper: OpenCodeEventMapper | undefined
  #eventController: AbortController | undefined
  #approval: ApprovalMode = 'ask'
  #pendingApprovals = new Set<string>()
  #model: string | undefined
  #instructions: string | undefined

  constructor(
    options: {
      baseUrl?: string
      mcpServers?: McpServerConfig[]
      mcpCredentials?: Record<string, string>
    } = {},
  ) {
    super()
    this.#configuredBaseUrl = options.baseUrl
    this.#mcpServers = options.mcpServers ?? []
    this.#mcpCredentials = options.mcpCredentials ?? {}
  }

  get capabilities(): Capabilities {
    return OPENCODE_CAPABILITIES
  }

  async start(): Promise<void> {
    if (this.#baseUrl) return
    if (this.#configuredBaseUrl) {
      this.#baseUrl = this.#configuredBaseUrl
      return
    }
    try {
      const serverOptions: Parameters<typeof createOpencodeServer>[0] = {
        hostname: '127.0.0.1',
        port: 0,
      }
      if (this.#mcpServers.length > 0) {
        serverOptions.config = {
          mcp: openCodeMcpConfig(this.#mcpServers, this.#mcpCredentials) as never,
        }
      }
      const server = await createOpencodeServer(serverOptions)
      this.#server = server
      this.#baseUrl = server.url
    } catch {
      throw new Error('OpenCode is unavailable. Install it and run `opencode` once to sign in.')
    }
  }

  async startThread(
    workspacePath: string,
    options: { model?: string; approval?: ApprovalMode; instructions?: string } = {},
  ): Promise<Thread> {
    this.#validateApproval(options.approval)
    await this.start()
    this.#workspacePath = workspacePath
    this.#approval = options.approval ?? 'ask'
    this.#model = options.model
    this.#instructions = options.instructions
    this.#client = this.#newClient(workspacePath)
    await this.#subscribe()
    const { data: session } = await this.#client.session.create({
      body: { title: 'Personal Harness' },
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
    options: { instructions?: string } = {},
  ): Promise<Thread> {
    await this.start()
    this.#workspacePath = workspacePath
    this.#instructions = options.instructions
    this.#client = this.#newClient(workspacePath)
    await this.#subscribe()
    const sessionId = threadId.startsWith('opencode-') ? threadId.slice(9) : threadId
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

  async sendTurn(threadId: string, text: string, attachments: string[] = []): Promise<string> {
    if (!this.#client || !this.#sessionId || threadId !== this.#threadId) {
      throw new Error('OpenCode session has not started')
    }
    if (attachments.length) throw new Error('OpenCode attachments are not supported yet')
    if (this.#turnId) throw new Error('a turn is already running')
    const turnId = `${threadId}-turn-${++this.#turnCounter}`
    this.#turnId = turnId
    this.#mapper = new OpenCodeEventMapper(turnId)
    this.emit('event', {
      type: 'turn.started',
      turn: { id: turnId, threadId, status: 'running', createdAt: Date.now() },
    })
    const model = parseModel(this.#model)
    void this.#client.session
      .promptAsync({
        path: { id: this.#sessionId },
        body: {
          parts: [{ type: 'text', text }],
          ...(model ? { model } : {}),
          ...(this.#instructions ? { system: this.#instructions } : {}),
        },
        throwOnError: true,
      })
      .catch(() => this.#failTurn())
    return turnId
  }

  async interrupt(threadId: string): Promise<void> {
    if (!this.#client || !this.#sessionId || threadId !== this.#threadId) return
    await this.#client.session.abort({
      path: { id: this.#sessionId },
      throwOnError: true,
    })
    this.#finishTurn('interrupted')
  }

  respondToApproval(approvalId: string, decision: ApprovalDecision): void {
    if (!this.#client || !this.#sessionId || !this.#pendingApprovals.has(approvalId)) return
    this.#pendingApprovals.delete(approvalId)
    const response =
      decision === 'approve-session' ? 'always' : decision === 'approve' ? 'once' : 'reject'
    void this.#client
      .postSessionIdPermissionsPermissionId({
        path: { id: this.#sessionId, permissionID: approvalId },
        body: { response },
        throwOnError: true,
      })
      .then(() => this.emit('event', { type: 'approval.resolved', id: approvalId }))
      .catch(() => this.emit('log', 'OpenCode permission response failed'))
    if (decision === 'abort') void this.interrupt(this.#threadId!)
  }

  async listModels(): Promise<Model[]> {
    await this.start()
    const { data: result } = await this.#newClient().provider.list({
      throwOnError: true,
    })
    return result.all
      .filter((provider) => result.connected.includes(provider.id))
      .flatMap((provider) =>
        Object.values(provider.models).map((model) => ({
          id: `${provider.id}/${model.id}`,
          displayName: `${provider.name} · ${model.name}`,
          isDefault: result.default[provider.id] === model.id,
          reasoningEfforts: [],
          serviceTiers: [],
        })),
      )
  }

  dispose(): void {
    this.#eventController?.abort()
    this.#server?.close()
    this.#eventController = undefined
    this.#server = undefined
    this.#client = undefined
    this.#sessionId = undefined
    this.#threadId = undefined
    this.#turnId = undefined
    this.#pendingApprovals.clear()
  }

  #newClient(directory?: string): OpencodeClient {
    return createOpencodeClient({
      baseUrl: this.#baseUrl!,
      ...(directory ? { directory } : {}),
    })
  }

  async #subscribe(): Promise<void> {
    this.#eventController?.abort()
    const controller = new AbortController()
    this.#eventController = controller
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

  #onEvent(event: Event): void {
    if (sessionId(event) !== undefined && sessionId(event) !== this.#sessionId) return
    if (event.type === 'permission.updated') {
      const permission = event.properties
      const command = /bash|shell|command/i.test(permission.type)
      if (this.#approval === 'full' || (this.#approval === 'auto' && !command)) {
        this.#pendingApprovals.add(permission.id)
        this.respondToApproval(
          permission.id,
          this.#approval === 'full' ? 'approve-session' : 'approve',
        )
        return
      }
      this.#pendingApprovals.add(permission.id)
      this.emit('event', {
        type: 'approval.requested',
        request: {
          id: permission.id,
          kind: command ? 'command' : 'file_change',
          ...(command ? { command: permission.title } : { path: permission.title }),
          createdAt: permission.time.created,
        },
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
      this.#finishTurn('completed')
      return
    }
    if (!this.#mapper) return
    for (const domainEvent of this.#mapper.translate(event)) this.emit('event', domainEvent)
  }

  #finishTurn(status: 'completed' | 'interrupted'): void {
    if (!this.#turnId) return
    for (const event of this.#mapper?.finish() ?? []) this.emit('event', event)
    for (const id of this.#pendingApprovals) this.emit('event', { type: 'approval.resolved', id })
    this.#pendingApprovals.clear()
    this.emit('event', { type: 'turn.completed', turnId: this.#turnId, status })
    this.#turnId = undefined
    this.#mapper = undefined
  }

  #failTurn(): void {
    if (!this.#turnId || !this.#threadId) return
    for (const event of this.#mapper?.finish('failed') ?? []) this.emit('event', event)
    for (const id of this.#pendingApprovals) this.emit('event', { type: 'approval.resolved', id })
    this.#pendingApprovals.clear()
    this.emit('log', 'OpenCode request failed')
    this.emit('event', {
      type: 'thread.error',
      threadId: this.#threadId,
      message: 'The OpenCode request failed.',
    })
    this.emit('event', { type: 'turn.completed', turnId: this.#turnId, status: 'failed' })
    this.#turnId = undefined
    this.#mapper = undefined
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

function sessionId(event: Event): string | undefined {
  const properties = event.properties as {
    sessionID?: string
    part?: { sessionID?: string }
    info?: { sessionID?: string }
  }
  return properties.sessionID ?? properties.part?.sessionID ?? properties.info?.sessionID
}
