import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk'
import type { McpServer, ProviderCommand } from '@harness/contracts'
import { killTree, spawnCli } from '@harness/proc'
import { withClaudeAccount } from './account-home.js'
import type { ClaudeRuntime } from './capabilities.js'
import { createClaudeCliQuery } from './cli-runtime.js'
import { mapClaudeCommands, mapClaudeMcpServers } from './inventory.js'
import {
  claudeSdkSpawner,
  createClaudeQuery,
  waitForAbort,
  type ClaudeQueryFactory,
  type ClaudeQueryRuntime,
  type ClaudeSpawn,
} from './sdk-runtime.js'

/** What Claude Code loads for a project: its commands and skills, and its MCP servers. */
export type ClaudeProjectInventory = {
  commands: ProviderCommand[]
  servers: McpServer[]
}

export type ClaudeProjectDiscoveryOptions = {
  signal?: AbortSignal | undefined
  /** Claude answered init while servers still start; the final answer follows. */
  onUpdate?: ((inventory: ClaudeProjectInventory) => void) | undefined
  createQuery?: ClaudeQueryFactory
  /** The runtime the user's sessions run through; the probe uses it too. */
  runtime?: ClaudeRuntime | undefined
  spawn?: ClaudeSpawn
  environment?: NodeJS.ProcessEnv
  /** Load what the account in this config folder loads. Absent: the default account. */
  accountHome?: string | undefined
  /** Claude needs 9-15 s to answer init on a warm machine, longer under load. */
  initTimeoutMs?: number
  /** How long servers may keep starting after init before the answer is final. */
  settleMs?: number
  pollMs?: number
}

const INIT_TIMEOUT_MS = 30_000
const SETTLE_MS = 15_000
const POLL_MS = 500

/**
 * Starts Claude Code in the project without a prompt, the way a chat would
 * load its settings, and reads its command list and MCP status. Nothing is
 * sent, so nothing is billed; the process tree is stopped before this returns.
 * `reloadSkills()` is not used: it took 16 s and answered a different set.
 */
export async function discoverClaudeProject(
  projectPath: string,
  options: ClaudeProjectDiscoveryOptions = {},
): Promise<ClaudeProjectInventory> {
  const abort = new AbortController()
  const cancel = () => abort.abort()
  if (options.signal?.aborted) cancel()
  else options.signal?.addEventListener('abort', cancel, { once: true })
  const children = new Set<ReturnType<ClaudeSpawn>>()
  let query: ClaudeQueryRuntime | undefined
  try {
    abort.signal.throwIfAborted()
    const createQuery =
      options.createQuery ?? (options.runtime === 'cli' ? createClaudeCliQuery : createClaudeQuery)
    query = createQuery({
      prompt: waitForAbort(abort.signal),
      options: {
        cwd: projectPath,
        abortController: abort,
        pathToClaudeCodeExecutable: 'claude',
        env: { ...withClaudeAccount(options.environment ?? process.env, options.accountHome) },
        // The SDK ends the CLI on abort; this keeps the whole tree, MCP servers
        // included, owned until it is gone.
        spawnClaudeCodeProcess: claudeSdkSpawner(
          options.spawn ?? spawnCli,
          undefined,
          undefined,
          (child) => children.add(child),
        ),
        // The same settings a chat in this project loads, so the same servers.
        settingSources: ['user', 'project', 'local'],
        persistSession: false,
        permissionMode: 'default',
      },
    })
    return await readClaudeProjectInventory(query, abort.signal, options)
  } finally {
    abort.abort()
    options.signal?.removeEventListener('abort', cancel)
    // The spawner started stopping each tree on abort; wait until they are gone
    // before closing, so no MCP server outlives its parent.
    await Promise.all([...children].map((child) => killTree(child).catch(() => undefined)))
    try {
      query?.close()
    } catch {
      // Already closed by the abort.
    }
  }
}

/** Commands arrive with init; servers are read until none is starting or the cap passes. */
export async function readClaudeProjectInventory(
  query: Pick<ClaudeQueryRuntime, 'initializationResult' | 'mcpServerStatus' | 'supportedCommands'>,
  signal: AbortSignal,
  options: Pick<
    ClaudeProjectDiscoveryOptions,
    'onUpdate' | 'initTimeoutMs' | 'settleMs' | 'pollMs'
  > = {},
): Promise<ClaudeProjectInventory> {
  const init = await bounded(
    query.initializationResult(),
    options.initTimeoutMs ?? INIT_TIMEOUT_MS,
    'Claude Code did not start in time',
    signal,
  )
  const settleBy = Date.now() + (options.settleMs ?? SETTLE_MS)
  const pollMs = options.pollMs ?? POLL_MS
  let commands = mapClaudeCommands(init.commands ?? [])
  let statuses = await bounded(
    query.mcpServerStatus(),
    Math.max(1, settleBy - Date.now()),
    'Claude Code did not report its MCP servers in time',
    signal,
  )
  if (starting(statuses)) {
    options.onUpdate?.({ commands, servers: mapClaudeMcpServers(statuses) })
    while (starting(statuses) && Date.now() + pollMs < settleBy) {
      await pause(pollMs, signal)
      statuses = await bounded(
        query.mcpServerStatus(),
        Math.max(1, settleBy - Date.now()),
        'Claude Code did not report its MCP servers in time',
        signal,
      ).catch(() => statuses)
    }
  }
  // Plugins can add skills after init; the SDK keeps this list current.
  commands = await query.supportedCommands().then(
    (current) => mapClaudeCommands(current),
    () => commands,
  )
  signal.throwIfAborted()
  return { commands, servers: mapClaudeMcpServers(statuses) }
}

function starting(statuses: readonly McpServerStatus[]): boolean {
  return statuses.some((status) => status.status === 'pending')
}

async function bounded<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        onAbort = () => reject(new Error('Claude project discovery was canceled'))
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      signal.removeEventListener('abort', stop)
      resolve()
    }
    const stop = () => {
      clearTimeout(timer)
      reject(new Error('Claude project discovery was canceled'))
    }
    const timer = setTimeout(done, ms)
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
}
