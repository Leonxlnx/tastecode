import path from 'node:path'
import { acpCommandName, acpCommandSkillPath, mapAcpCommands } from '@harness/adapter-acp/commands'
import type {
  McpServer,
  McpStartupStatus,
  ProviderCommand,
  Skill,
  SkillScope,
} from '@harness/contracts'
import {
  spawnCli,
  StdioJsonRpc,
  type JsonRpcRequestOptions,
  type JsonRpcValue,
} from '@harness/proc'
import { grokCommand } from './adapter.js'

/** What Grok loads for a project: its commands and skills, and its MCP servers. */
export type GrokProjectInventory = {
  commands: ProviderCommand[]
  servers: McpServer[]
  skills: Skill[]
}

/** The part of the ACP transport a probe uses; tests replay captured frames through it. */
export type GrokDiscoveryRpc = {
  onNotification(handler: (method: string, params: JsonRpcValue | undefined) => void): void
  request(
    method: string,
    params?: unknown,
    options?: JsonRpcRequestOptions,
  ): Promise<JsonRpcValue | undefined>
  dispose(): void | Promise<void>
}

export type GrokProjectDiscoveryOptions = {
  signal?: AbortSignal | undefined
  /** Grok listed its commands while MCP servers still start; the final answer follows. */
  onUpdate?: ((inventory: GrokProjectInventory) => void) | undefined
  connect?: (projectPath: string) => GrokDiscoveryRpc
  /** initialize and session/new; Grok answered both in 2-3 s on a warm machine. */
  startTimeoutMs?: number
  /** How long MCP servers may keep starting after session/new. */
  settleMs?: number
  /** Without any MCP signal by then, Grok has no servers to start. */
  quietMs?: number
  /** After Grok says MCP is initialized, how long a late status may still arrive. */
  graceMs?: number
  /** After that, how long a ready server's tool names may take (captured: 0.4-0.9 s). */
  toolsGraceMs?: number
}

const START_TIMEOUT_MS = 20_000
const SETTLE_MS = 15_000
const QUIET_MS = 1_500
const GRACE_MS = 1_000
const TOOLS_GRACE_MS = 2_000
const CLOSE_TIMEOUT_MS = 2_000
const MAX_MESSAGE = 300

/**
 * Starts Grok over ACP in the project without a prompt, the way an MCP chat
 * starts, and reads the commands, skills and MCP status it reports. Nothing is
 * sent, so nothing is billed. The session is closed and the process tree
 * stopped before this returns. Written against grok 1.0.62 `agent stdio`
 * (fixtures/acp-session-grok-1.0.62.jsonl). `--no-leader`: the probe must own
 * the process it stops, never a shared leader.
 */
export async function discoverGrokProject(
  projectPath: string,
  options: GrokProjectDiscoveryOptions = {},
): Promise<GrokProjectInventory> {
  options.signal?.throwIfAborted()
  const rpc = (options.connect ?? connectGrok)(projectPath)
  const inventory = new GrokInventory()
  rpc.onNotification((method, params) => inventory.read(method, params))
  let sessionId: string | undefined
  try {
    const timeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS
    await bounded(
      rpc.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
          clientInfo: { name: 'tastecode', version: '0.0.0' },
        },
        { timeoutMs },
      ),
      options.signal,
    )
    const session = await bounded(
      rpc.request('session/new', { cwd: projectPath, mcpServers: [] }, { timeoutMs }),
      options.signal,
    )
    const id = record(session)?.sessionId
    if (typeof id !== 'string' || !id) throw new Error('Grok started no session')
    sessionId = id
    await inventory.settle(options)
    options.signal?.throwIfAborted()
    return inventory.result()
  } finally {
    // Closing takes the empty session out of Grok's session list.
    if (sessionId) {
      await rpc
        .request('session/close', { sessionId }, { timeoutMs: CLOSE_TIMEOUT_MS })
        .catch(() => undefined)
    }
    await rpc.dispose()
  }
}

function connectGrok(projectPath: string): GrokDiscoveryRpc {
  return new StdioJsonRpc(
    spawnCli(grokCommand(), ['agent', '--no-leader', 'stdio'], { cwd: projectPath }),
    'Grok project discovery',
  )
}

type McpStatus = { status?: string; reason?: string; detail?: string; tools?: string[] }

/** Collects the frames a fresh Grok session reports and decides when they are complete. */
class GrokInventory {
  #commands: unknown[] | undefined
  /**
   * Every tool the session offers, from the command update's `_meta.tools`.
   * MCP tools are named `<server>__<tool>` and arrive in a later update than
   * the commands, once the servers have connected.
   */
  #tools: string[] = []
  /** Configured servers in Grok's order; a plugin server may first appear with its status. */
  readonly #servers: string[] = []
  readonly #statuses = new Map<string, McpStatus>()
  #total = 0
  #mcpSignal = false
  #initializedAt: number | undefined
  #onChange: (() => void) | undefined

  read(method: string, params: JsonRpcValue | undefined): void {
    const fields = record(params)
    if (!fields) return
    switch (method) {
      case 'session/update': {
        const update = record(fields.update)
        const kind = update?.sessionUpdate
        if (kind !== 'available_commands_update' && kind !== 'available_commands') return
        this.#commands = Array.isArray(update!.availableCommands) ? update!.availableCommands : []
        const tools = record(update!._meta)?.tools
        if (Array.isArray(tools)) {
          this.#tools = tools.filter((tool): tool is string => typeof tool === 'string')
        }
        break
      }
      case '_x.ai/mcp/servers_updated': {
        const servers = Array.isArray(fields.mcpServers) ? fields.mcpServers : []
        for (const server of servers) this.#addServer(record(server)?.name)
        if (servers.length) this.#mcpSignal = true
        break
      }
      case '_x.ai/mcp/init_progress':
        if (typeof fields.total === 'number') this.#total = Math.max(this.#total, fields.total)
        this.#mcpSignal = true
        break
      case '_x.ai/mcp/server_status': {
        const name = fields.name
        if (typeof name !== 'string' || !name) return
        this.#addServer(name)
        this.#statuses.set(name, {
          ...(typeof fields.status === 'string' ? { status: fields.status } : {}),
          ...(typeof fields.reason === 'string' ? { reason: fields.reason } : {}),
          ...(typeof fields.detail === 'string' ? { detail: fields.detail } : {}),
        })
        this.#mcpSignal = true
        break
      }
      case '_x.ai/mcp_initialized':
        this.#initializedAt ??= Date.now()
        this.#mcpSignal = true
        break
      default:
        return
    }
    this.#onChange?.()
  }

  /**
   * Waits for the command list and for every MCP server to report, bounded:
   * a server that never answers is shown as starting rather than holding the
   * answer back. Reports an early answer while servers still start.
   */
  settle(options: GrokProjectDiscoveryOptions): Promise<void> {
    const started = Date.now()
    const quietMs = options.quietMs ?? QUIET_MS
    const graceMs = options.graceMs ?? GRACE_MS
    const toolsGraceMs = Math.max(graceMs, options.toolsGraceMs ?? TOOLS_GRACE_MS)
    let early = false
    let grace = false
    return new Promise<void>((resolve, reject) => {
      const timers: ReturnType<typeof setTimeout>[] = []
      const finish = (error?: Error) => {
        for (const timer of timers) clearTimeout(timer)
        this.#onChange = undefined
        options.signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve()
      }
      const abort = () => finish(new Error('Grok project discovery was canceled'))
      const check = () => {
        const now = Date.now()
        const initializedAt = this.#initializedAt
        if (initializedAt !== undefined && !grace) {
          grace = true
          timers.push(setTimeout(check, Math.max(1, initializedAt + graceMs - now)))
          timers.push(setTimeout(check, Math.max(1, initializedAt + toolsGraceMs - now)))
        }
        if (this.#commands === undefined) return
        const complete =
          initializedAt !== undefined
            ? (this.#statuses.size >= Math.max(this.#total, this.#servers.length) ||
                now - initializedAt >= graceMs) &&
              (this.#readyToolsKnown() || now - initializedAt >= toolsGraceMs)
            : !this.#mcpSignal && now - started >= quietMs
        if (complete) return finish()
        if (!early && this.#mcpSignal) {
          early = true
          options.onUpdate?.(this.result())
        }
      }
      this.#onChange = check
      timers.push(setTimeout(() => finish(), options.settleMs ?? SETTLE_MS))
      timers.push(setTimeout(check, quietMs))
      if (options.signal?.aborted) return abort()
      options.signal?.addEventListener('abort', abort, { once: true })
      check()
    })
  }

  result(): GrokProjectInventory {
    const commands = this.#commands ?? []
    return {
      commands: mapAcpCommands(commands),
      servers: this.#servers.map((name) =>
        mapGrokMcpServer(name, { ...this.#statuses.get(name), tools: this.#toolsOf(name) }),
      ),
      skills: mapGrokSkills(commands),
    }
  }

  #toolsOf(server: string): string[] {
    const prefix = `${server}__`
    return this.#tools.flatMap((tool) =>
      tool.startsWith(prefix) && tool.length > prefix.length ? [tool.slice(prefix.length)] : [],
    )
  }

  /** A ready server with no tool names yet is waited for, briefly: it may simply have none. */
  #readyToolsKnown(): boolean {
    return this.#servers.every(
      (name) => this.#statuses.get(name)?.status !== 'ready' || this.#toolsOf(name).length > 0,
    )
  }

  #addServer(name: unknown): void {
    if (typeof name === 'string' && name && !this.#servers.includes(name)) this.#servers.push(name)
  }
}

/**
 * One server from `_x.ai/mcp/servers_updated` and `_x.ai/mcp/server_status`.
 * The transport stays out: inherited configs can carry tokens in their URL,
 * and Grok owns them. A server that wants a sign-in is stopped, as Claude's are.
 */
export function mapGrokMcpServer(name: string, status: McpStatus | undefined): McpServer {
  const message = status?.detail?.trim() || status?.reason?.trim() || ''
  const signIn =
    status?.status === 'unavailable' && /auth(?:entication)?[ _-]?required/i.test(message)
  const startup: McpStartupStatus =
    status?.status === 'ready'
      ? { state: 'ready' }
      : status?.status === 'unavailable'
        ? signIn
          ? { state: 'stopped' }
          : { state: 'failed', message: cleanMessage(message) || 'MCP server failed to start' }
        : { state: 'starting' }
  return {
    id: name,
    scope: 'global',
    enabled: true,
    auth: signIn ? { status: 'sign_in_required', method: 'oauth' } : { status: 'not_required' },
    startup,
    // Grok names its tools and nothing more.
    tools: (status?.tools ?? []).map((tool) => ({ name: tool, inputSchema: {} })),
    resources: [],
    resourceTemplates: [],
  }
}

/** Grok's errors name the Rust transport type in brackets; the rest is the useful part. */
function cleanMessage(message: string): string {
  const clean = message
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > MAX_MESSAGE ? `${clean.slice(0, MAX_MESSAGE - 1)}…` : clean
}

const SKILL_SCOPES = new Map<string, SkillScope>([
  ['user', 'user'],
  ['project', 'project'],
  ['local', 'project'],
  ['bundled', 'system'],
  ['builtin', 'system'],
  ['system', 'system'],
  ['managed', 'admin'],
  ['admin', 'admin'],
])

/** The commands Grok loads from a SKILL.md file, as skills under the name Grok runs. */
export function mapGrokSkills(entries: readonly unknown[]): Skill[] {
  const seen = new Set<string>()
  const skills: Skill[] = []
  for (const entry of entries) {
    const name = acpCommandName(entry)
    const file = acpCommandSkillPath(entry)
    if (!name || !file || seen.has(file)) continue
    seen.add(file)
    const fields = record(entry)!
    const meta = record(fields._meta)!
    const shown =
      typeof meta.displayName === 'string' && meta.displayName.trim()
        ? meta.displayName.trim()
        : typeof meta.bareName === 'string' && meta.bareName && meta.bareName !== name
          ? meta.bareName
          : undefined
    skills.push({
      id: file,
      name,
      ...(shown ? { displayName: shown } : {}),
      description: typeof fields.description === 'string' ? fields.description : '',
      // The path is Grok's, in its own platform's style.
      source: {
        type: 'folder',
        path: (file.includes('\\') ? path.win32 : path.posix).dirname(file),
      },
      scope: (typeof meta.scope === 'string' && SKILL_SCOPES.get(meta.scope)) || 'user',
      enabled: true,
      dependencyErrors: [],
    })
  }
  return skills
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

async function bounded<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error('Grok project discovery was canceled'))
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
