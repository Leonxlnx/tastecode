import { createInterface } from 'node:readline'
import type {
  CanUseTool,
  McpServerConfig,
  McpServerStatus,
  McpSetServersResult,
  ModelInfo,
  Options,
  PermissionMode,
  PermissionResult,
  SDKControlGetUsageResponse,
  SDKControlInitializeResponse,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
  SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import {
  claudeSdkSpawner,
  type ClaudeQueryRuntime,
  type ClaudeUsageQueryRuntime,
} from './sdk-runtime.js'

/**
 * `claude -p` driven by TasteCode itself. Claude Code's print mode with
 * stream-json on both pipes is the protocol the Agent SDK speaks under its
 * `query()`: user messages and control requests go in as JSON lines, and the
 * session's messages, control answers and its own requests (tool permission)
 * come out. This runtime takes the same options and offers the same controls,
 * so the adapter hosts a session the same way through either; this one runs
 * no SDK code. Captured from claude 2.1.310.
 */

/** The SDK's grace between closing stdin and stopping a CLI that has not exited. */
const GRACEFUL_EXIT_MS = 2_000

/**
 * The SDK leaves these unanswered: they are for a remote machine serving the
 * session's tools. A dialog without a handler stays open for a client that has one.
 */
const UNANSWERED_REQUESTS = new Set([
  'remote_tool_call',
  'remote_plumbing_call',
  'remote_tools_probe',
  'remote_tools_reannounce',
  'request_user_dialog',
])

const ControlResponseSchema = z.object({
  type: z.literal('control_response'),
  response: z.union([
    z.object({
      subtype: z.literal('success'),
      request_id: z.string(),
      response: z.unknown().optional(),
    }),
    z.object({ subtype: z.literal('error'), request_id: z.string(), error: z.string() }),
  ]),
})
const ControlRequestSchema = z.object({
  type: z.literal('control_request'),
  request_id: z.string(),
  request: z.looseObject({ subtype: z.string() }),
})
const ControlCancelSchema = z.object({
  type: z.literal('control_cancel_request'),
  request_id: z.string(),
})
const ToolPermissionRequestSchema = z.looseObject({
  subtype: z.literal('can_use_tool'),
  tool_name: z.string(),
  input: z.record(z.string(), z.unknown()),
  tool_use_id: z.string(),
  permission_suggestions: z.array(z.unknown()).optional(),
  blocked_path: z.string().optional(),
  decision_reason: z.string().optional(),
  title: z.string().optional(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  agent_id: z.string().optional(),
})
const PendingPermissionsSchema = z.object({
  pending_permission_requests: z.array(ControlRequestSchema).optional(),
})
const CommandsChangedSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('commands_changed'),
  commands: z.array(z.unknown()),
})
const ResultSchema = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
})

type ControlRequest = z.infer<typeof ControlRequestSchema>

/**
 * The flags the SDK builds for the same options, after `-p`. Only options the
 * adapter and the limit read pass are known; the rest have no flag here.
 */
export function claudeCliArgs(options: Options): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--input-format',
    'stream-json',
  ]
  if (options.effort) args.push(`--effort=${options.effort}`)
  if (options.model) args.push(`--model=${options.model}`)
  if (options.canUseTool) args.push('--permission-prompt-tool=stdio')
  if (options.resume) args.push(`--resume=${options.resume}`)
  if (options.allowedTools?.length) args.push(`--allowedTools=${options.allowedTools.join(',')}`)
  if (options.disallowedTools?.length)
    args.push(`--disallowedTools=${options.disallowedTools.join(',')}`)
  if (options.mcpServers && Object.keys(options.mcpServers).length > 0)
    args.push('--mcp-config', JSON.stringify({ mcpServers: options.mcpServers }))
  if (options.settingSources !== undefined)
    args.push(`--setting-sources=${options.settingSources.join(',')}`)
  if (options.strictMcpConfig) args.push('--strict-mcp-config')
  if (options.permissionMode) args.push(`--permission-mode=${options.permissionMode}`)
  if (options.allowDangerouslySkipPermissions) args.push('--allow-dangerously-skip-permissions')
  if (options.includePartialMessages) args.push('--include-partial-messages')
  for (const directory of options.additionalDirectories ?? []) args.push(`--add-dir=${directory}`)
  if (options.sessionId) args.push(`--session-id=${options.sessionId}`)
  if (options.persistSession === false) args.push('--no-session-persistence')
  if (options.settings !== undefined)
    args.push(
      '--settings',
      typeof options.settings === 'string' ? options.settings : JSON.stringify(options.settings),
    )
  return args
}

/** What the SDK sends at startup for the same system prompt option. */
function initializeRequest(systemPrompt: Options['systemPrompt']) {
  if (systemPrompt === undefined) return { subtype: 'initialize', systemPrompt: [''] }
  if (typeof systemPrompt === 'string')
    return { subtype: 'initialize', systemPrompt: [systemPrompt] }
  if (Array.isArray(systemPrompt)) return { subtype: 'initialize', systemPrompt }
  const snapshot =
    systemPrompt.snapshot !== undefined ? { systemPromptSnapshot: systemPrompt.snapshot } : {}
  if (systemPrompt.type === 'custom') {
    const prompt = systemPrompt.prompt
    return {
      subtype: 'initialize',
      systemPrompt: typeof prompt === 'string' ? [prompt] : prompt,
      ...snapshot,
    }
  }
  return {
    subtype: 'initialize',
    ...snapshot,
    ...(systemPrompt.append !== undefined ? { appendSystemPrompt: systemPrompt.append } : {}),
    ...(systemPrompt.excludeDynamicSections !== undefined
      ? { excludeDynamicSections: systemPrompt.excludeDynamicSections }
      : {}),
  }
}

/** The SDK drops both before it starts the CLI; `NODE_OPTIONS` from this host's own runtime would load into it. */
function cliEnvironment(env: Options['env']) {
  const next = { ...(env ?? process.env) }
  delete next.NODE_OPTIONS
  delete next.DEBUG
  return next
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Messages in arrival order, for one reader that may wait for the next. */
class MessageStream implements AsyncIterable<SDKMessage> {
  readonly #values: SDKMessage[] = []
  readonly #waiters: Array<{
    resolve(result: IteratorResult<SDKMessage>): void
    reject(error: Error): void
  }> = []
  #ended = false
  #error: Error | undefined

  push(value: SDKMessage): void {
    if (this.#ended) return
    const waiter = this.#waiters.shift()
    if (waiter) waiter.resolve({ value, done: false })
    else this.#values.push(value)
  }

  end(error?: Error): void {
    if (this.#ended) return
    this.#ended = true
    this.#error = error
    for (const waiter of this.#waiters.splice(0)) {
      if (error) waiter.reject(error)
      else waiter.resolve({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const value = this.#values.shift()
        if (value) return Promise.resolve({ value, done: false })
        if (this.#ended)
          return this.#error
            ? Promise.reject(this.#error)
            : Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }))
      },
      return: () => {
        this.end()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

class ClaudeCliQuery implements ClaudeQueryRuntime, ClaudeUsageQueryRuntime {
  readonly #canUseTool: CanUseTool | undefined
  readonly #abort: AbortController
  /** Stops the process; aborted after the grace a closing CLI gets to exit on its own. */
  readonly #stop = new AbortController()
  readonly #process: SpawnedProcess
  readonly #messages = new MessageStream()
  readonly #pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >()
  /** Requests from the CLI still being answered, so it can cancel one. */
  readonly #answering = new Map<string, AbortController>()
  readonly #initialization: Promise<SDKControlInitializeResponse>
  #commands: SlashCommand[] | undefined
  /** The latest message was an error result; its text explains the exit that follows. */
  #errorResult: string | undefined
  #closed = false
  #exited = false
  readonly #exit: Promise<void>

  constructor(input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) {
    const { options } = input
    this.#canUseTool = options.canUseTool
    this.#abort = options.abortController ?? new AbortController()
    const spawn = options.spawnClaudeCodeProcess ?? claudeSdkSpawner()
    this.#process = spawn({
      command: options.pathToClaudeCodeExecutable ?? 'claude',
      args: claudeCliArgs(options),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: cliEnvironment(options.env),
      signal: this.#stop.signal,
    })
    this.#process.stdin.on('error', () => undefined)
    this.#exit = new Promise((resolve) =>
      this.#process.once('exit', () => {
        this.#exited = true
        resolve()
      }),
    )
    this.#process.on('error', (error) => this.#finish(error))
    if (this.#abort.signal.aborted) this.close()
    else this.#abort.signal.addEventListener('abort', () => this.close(), { once: true })

    this.#initialization = this.#request<SDKControlInitializeResponse>(
      initializeRequest(options.systemPrompt),
    ).then((response) => {
      const parsed = PendingPermissionsSchema.safeParse(response)
      for (const request of parsed.success ? (parsed.data.pending_permission_requests ?? []) : [])
        void this.#answer(request)
      return response
    })
    this.#initialization.catch(() => undefined)
    void this.#read()
    void this.#send(input.prompt)
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    const iterator = this.#messages[Symbol.asyncIterator]()
    return {
      next: () => iterator.next(),
      return: () => {
        this.close()
        return iterator.return!()
      },
    }
  }

  initializationResult(): Promise<SDKControlInitializeResponse> {
    return this.#initialization
  }

  async interrupt(): Promise<SDKControlInterruptResponse | undefined> {
    const response = z
      .object({ still_queued: z.array(z.unknown()), cancelled: z.array(z.unknown()).optional() })
      .safeParse(await this.#request({ subtype: 'interrupt' }))
    if (!response.success) return undefined
    const strings = (values: unknown[]) =>
      values.filter((value): value is string => typeof value === 'string')
    return {
      still_queued: strings(response.data.still_queued),
      ...(response.data.cancelled ? { cancelled: strings(response.data.cancelled) } : {}),
    }
  }

  async setModel(model?: string): Promise<void> {
    await this.#request({ subtype: 'set_model', model })
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.#request({ subtype: 'set_permission_mode', mode })
  }

  async supportedModels(): Promise<ModelInfo[]> {
    return (await this.#initialization).models
  }

  async supportedCommands(): Promise<SlashCommand[]> {
    const { commands } = await this.#initialization
    return this.#commands ?? commands
  }

  async mcpServerStatus(): Promise<McpServerStatus[]> {
    const response = await this.#request<{ mcpServers: McpServerStatus[] }>({
      subtype: 'mcp_status',
    })
    return response.mcpServers
  }

  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult> {
    return this.#request({ subtype: 'mcp_set_servers', servers })
  }

  getSettings(): Promise<unknown> {
    return this.#request({ subtype: 'get_settings' })
  }

  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts?: {
    skipBehaviors?: boolean
  }): Promise<SDKControlGetUsageResponse> {
    return this.#request({
      subtype: 'get_usage',
      ...(opts?.skipBehaviors ? { skip_behaviors: true } : {}),
    })
  }

  /** Closes stdin; a CLI still running after the grace is stopped. */
  close(): void {
    if (this.#closed) return
    this.#finish(undefined)
  }

  #finish(error: Error | undefined): void {
    if (this.#closed) return
    this.#closed = true
    for (const controller of this.#answering.values()) controller.abort()
    this.#answering.clear()
    const reason = error ?? new Error('Query closed before response received')
    for (const pending of this.#pending.values()) pending.reject(reason)
    this.#pending.clear()
    this.#messages.end(error)
    if (!this.#process.stdin.writableEnded) this.#process.stdin.end()
    if (this.#exited) return
    const timer = setTimeout(() => {
      if (!this.#exited) this.#process.kill('SIGTERM')
      this.#stop.abort()
    }, GRACEFUL_EXIT_MS)
    timer.unref?.()
    void this.#exit.then(() => clearTimeout(timer))
  }

  #write(message: unknown): void {
    if (this.#closed || this.#process.stdin.writableEnded) return
    this.#process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #request<T>(request: Record<string, unknown>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('Query closed before response received'))
    const requestId = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(requestId, { resolve: (value) => resolve(value as T), reject })
      this.#write({ type: 'control_request', request_id: requestId, request })
    })
  }

  async #send(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    try {
      for await (const message of prompt) {
        if (this.#closed) return
        this.#write(message)
      }
    } catch {
      // A prompt stream that fails ends the input, as one that finishes does.
    }
    if (!this.#closed && !this.#process.stdin.writableEnded) this.#process.stdin.end()
  }

  async #read(): Promise<void> {
    try {
      for await (const line of createInterface({
        input: this.#process.stdout,
        crlfDelay: Infinity,
      })) {
        if (!line.trim()) continue
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          continue
        }
        this.#onLine(value)
      }
      await this.#exit
      this.#finish(this.#exitError())
    } catch (error) {
      this.#finish(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** Nothing when it exited cleanly or was closed here. */
  #exitError(): Error | undefined {
    if (this.#closed || this.#abort.signal.aborted) return undefined
    const { exitCode, signalCode } = this.#process
    if (this.#errorResult !== undefined && (exitCode !== 0 || signalCode))
      return new Error(`Claude Code returned an error result: ${this.#errorResult}`)
    if (exitCode !== null && exitCode !== 0)
      return new Error(`Claude Code process exited with code ${exitCode}`)
    if (signalCode) return new Error(`Claude Code process terminated by signal ${signalCode}`)
    return undefined
  }

  /**
   * Every streamed delta passes here, so a plain message costs a few field
   * reads; only control traffic, results and command lists are parsed.
   */
  #onLine(value: unknown): void {
    if (typeof value !== 'object' || value === null) return
    const line = value as { type?: unknown; subtype?: unknown; sdk_host_only?: unknown }
    switch (line.type) {
      case 'control_response': {
        const parsed = ControlResponseSchema.safeParse(value)
        if (!parsed.success) return
        const response = parsed.data.response
        const pending = this.#pending.get(response.request_id)
        if (!pending) return
        this.#pending.delete(response.request_id)
        if (response.subtype === 'success') pending.resolve(response.response)
        else pending.reject(new Error(response.error))
        return
      }
      case 'control_request': {
        const parsed = ControlRequestSchema.safeParse(value)
        if (parsed.success) void this.#answer(parsed.data)
        return
      }
      case 'control_cancel_request': {
        const parsed = ControlCancelSchema.safeParse(value)
        if (!parsed.success) return
        this.#answering.get(parsed.data.request_id)?.abort()
        this.#answering.delete(parsed.data.request_id)
        return
      }
      case 'keep_alive':
      case 'transcript_mirror':
        return
    }
    if (typeof line.type !== 'string') return
    if (line.type === 'result') {
      const result = ResultSchema.safeParse(value)
      this.#errorResult =
        result.success && result.data.is_error ? errorText(result.data) : undefined
    } else {
      this.#errorResult = undefined
    }
    if (line.type === 'system') {
      if (line.subtype === 'commands_changed') {
        const commands = CommandsChangedSchema.safeParse(value)
        if (commands.success) this.#commands = commands.data.commands as SlashCommand[]
      }
      // Status pushes meant only for the SDK's own bookkeeping never reach its caller.
      if (line.subtype === 'session_state_changed' && line.sdk_host_only === true) return
    }
    this.#messages.push(value as SDKMessage)
  }

  async #answer(request: ControlRequest): Promise<void> {
    const { request_id: requestId, request: body } = request
    if (UNANSWERED_REQUESTS.has(body.subtype) || this.#answering.has(requestId)) return
    const controller = new AbortController()
    this.#answering.set(requestId, controller)
    const reply = await this.#respond(body, controller.signal, requestId).then(
      (response) =>
        response === undefined
          ? undefined
          : { subtype: 'success' as const, request_id: requestId, response },
      (error: unknown) => ({
        subtype: 'error' as const,
        request_id: requestId,
        error: messageOf(error),
      }),
    )
    if (this.#answering.get(requestId) === controller) this.#answering.delete(requestId)
    if (reply) this.#write({ type: 'control_response', response: reply })
  }

  /** `undefined` leaves the request unanswered, as the SDK does for a callback that returns null. */
  async #respond(
    body: ControlRequest['request'],
    signal: AbortSignal,
    requestId: string,
  ): Promise<unknown> {
    switch (body.subtype) {
      case 'can_use_tool': {
        if (!this.#canUseTool) throw new Error('canUseTool callback is not provided.')
        const request = ToolPermissionRequestSchema.parse(body)
        const result: PermissionResult | null = await this.#canUseTool(
          request.tool_name,
          request.input,
          {
            signal,
            ...(request.permission_suggestions
              ? {
                  suggestions: request.permission_suggestions as NonNullable<
                    Parameters<CanUseTool>[2]['suggestions']
                  >,
                }
              : {}),
            ...(request.blocked_path !== undefined ? { blockedPath: request.blocked_path } : {}),
            ...(request.decision_reason !== undefined
              ? { decisionReason: request.decision_reason }
              : {}),
            ...(request.title !== undefined ? { title: request.title } : {}),
            ...(request.display_name !== undefined ? { displayName: request.display_name } : {}),
            ...(request.description !== undefined ? { description: request.description } : {}),
            toolUseID: request.tool_use_id,
            ...(request.agent_id !== undefined ? { agentID: request.agent_id } : {}),
            requestId,
          },
        )
        if (result === null) return undefined
        return { ...result, toolUseID: request.tool_use_id }
      }
      case 'elicitation':
        return { action: 'decline' }
      case 'hook_callback':
        throw new Error(`No hook callback found for ID: ${String(body['callback_id'])}`)
      case 'mcp_message':
        throw new Error(`SDK MCP server not found: ${String(body['server_name'])}`)
      default:
        throw new Error(`Unsupported control request subtype: ${body.subtype}`)
    }
  }
}

function errorText(result: z.infer<typeof ResultSchema>): string | undefined {
  if (result.subtype === 'success') return result.result || undefined
  const text = (result.errors ?? [])
    .map((error) => error.trim())
    .filter(Boolean)
    .join('; ')
  return text || undefined
}

export const createClaudeCliQuery = (input: {
  prompt: AsyncIterable<SDKUserMessage>
  options: Options
}): ClaudeQueryRuntime & ClaudeUsageQueryRuntime => new ClaudeCliQuery(input)
