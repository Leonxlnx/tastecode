import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { AcpAdapter, prepareAcpMcpServers } from '@harness/adapter-acp'
import type {
  ApprovalDecision,
  ApprovalMode,
  Capabilities,
  DomainEvent,
  McpServerConfig,
  Model,
  ProviderCommand,
  Thread,
} from '@harness/contracts'
import { killTree, type spawnCli } from '@harness/proc'
import { z } from 'zod'
import { ANTIGRAVITY_CAPABILITIES } from './capabilities.js'
import { ANTIGRAVITY_ENVIRONMENT, antigravityCommand, spawnAgy, type AgySpawn } from './command.js'
import { AGY_ANSWERED_COMMANDS, isAgyAnsweredCommand } from './commands.js'
import { lastJsonObject } from './limits.js'
import {
  collapseAntigravityModels,
  getAntigravityIndex,
  rememberAntigravityIndex,
  resolveAntigravityModel,
  type AntigravityListedModel,
} from './models.js'
import {
  ANTIGRAVITY_SIGN_IN_REQUIRED,
  antigravitySignIn,
  readAgyModels,
  sharedAgyModels,
} from './sign-in.js'

/**
 * Drives Google's Antigravity CLI (`agy`) over its Agent Client Protocol
 * (`agy acp`) stdio server.
 *
 * Captured against `agy acp` 1.5.14:
 *   - `initialize` advertises `loadSession: true`, `promptCapabilities.image: true`,
 *     and omits `mcpCapabilities.http` even though `session/new` and `session/load`
 *     connect directly to HTTP MCP servers (`assumeHttpMcp: true`).
 *   - `session/new` returns `configOptions` for `model`, `thought_level`, and `mode`
 *     (`default`, `accept-edits`, `auto`, `plan`).
 *   - `session/set_config_option` accepts both collapsed per-effort slugs
 *     (`gemini-3.8-flash-high`) and base model ids plus `thought_level`.
 *   - `agy` read-only slash commands (`/usage`, `/credits`, `/changelog`, ...)
 *     are still answered via `agy -p <cmd> --output-format json` without touching
 *     the active ACP session.
 *
 * This never reads a credential. The binary authenticates itself with the
 * user's Google account. See rules/security.md.
 */

const SUPPORTED = '1.5'

export { ANTIGRAVITY_CAPABILITIES } from './capabilities.js'

export type AntigravityAdapterOptions = {
  spawn?: AgySpawn | undefined
  mcpServers?: McpServerConfig[] | undefined
  mcpCredentials?: Record<string, string> | undefined
}

export type AntigravityStartOptions = {
  instructions?: string | undefined
  model?: string | undefined
  effort?: string | undefined
  approval?: ApprovalMode | undefined
  mcpServers?: McpServerConfig[] | undefined
  mcpCredentials?: Record<string, string> | undefined
}

export type AntigravityTurnOptions = Pick<AntigravityStartOptions, 'model' | 'effort'>

/** Maps TasteCode's approval mode onto `agy acp`'s `mode` config select. */
export function antigravityModeForApproval(
  approval: ApprovalMode,
  available: readonly string[],
): string | undefined {
  const wanted = approval === 'auto' ? 'accept-edits' : approval === 'full' ? 'auto' : 'default'
  return available.includes(wanted) ? wanted : undefined
}

/** The fields of agy's `--output-format json` object an answered command needs. */
const AgyAnswerSchema = z.object({
  status: z.string().optional(),
  response: z.string().optional(),
})
/** A command's answer is a few KB; /changelog is the longest. */
const ANSWER_LIMIT_CHARS = 1024 * 1024

export type AntigravityAdapterEvents = {
  event: [DomainEvent]
  log: [string]
  commandsChanged: []
  disconnected: []
}

type SpawnFn = AgySpawn

function adaptSpawn(spawn: SpawnFn): typeof spawnCli {
  return (command, args, options = {}) =>
    spawn(command, args, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: { ...ANTIGRAVITY_ENVIRONMENT, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
}

export class AntigravityAdapter extends EventEmitter<AntigravityAdapterEvents> {
  readonly #spawn: SpawnFn
  readonly #defaultMcpServers: McpServerConfig[]
  readonly #defaultMcpCredentials: Record<string, string>
  #acp: AcpAdapter | undefined
  #workspacePath = ''
  #model: string | undefined
  #effort: string | undefined
  #commandChild: ChildProcessWithoutNullStreams | undefined
  #commandKillReasons = new WeakMap<ChildProcessWithoutNullStreams, 'interrupt' | 'silent'>()
  #commandCounter = 0

  constructor(options: AntigravityAdapterOptions = {}) {
    super()
    this.#spawn = options.spawn ?? spawnAgy
    this.#defaultMcpServers = options.mcpServers ?? []
    this.#defaultMcpCredentials = options.mcpCredentials ?? {}
  }

  get capabilities(): Capabilities {
    return this.#acp ? this.#acp.capabilities : ANTIGRAVITY_CAPABILITIES
  }

  get resumable(): boolean {
    return this.#acp ? this.#acp.resumable : true
  }

  async startThread(workspacePath: string, options: AntigravityStartOptions = {}): Promise<Thread> {
    if (options.approval === 'auto-review') {
      throw new Error('Antigravity does not support automatic approval review')
    }
    this.#workspacePath = workspacePath
    this.#model = options.model
    this.#effort = options.effort
    const resolved = await this.#resolveSelection(options.model, options.effort)
    const acp = this.#createAcp(options)
    return acp.startThread(workspacePath, {
      instructions: options.instructions,
      approval: options.approval,
      model: resolved.model,
      effort: resolved.effort,
    })
  }

  async resumeThread(
    threadId: string,
    workspacePath: string,
    options: AntigravityStartOptions = {},
  ): Promise<Thread> {
    if (options.approval === 'auto-review') {
      throw new Error('Antigravity does not support automatic approval review')
    }
    if (!threadId.startsWith('acp-antigravity-')) {
      const error = new Error(
        'This Antigravity chat started before ACP mode and has no ACP session to resume.',
      ) as Error & { code?: string }
      error.code = 'provider_session_missing'
      throw error
    }
    this.#workspacePath = workspacePath
    this.#model = options.model
    this.#effort = options.effort
    const resolved = await this.#resolveSelection(options.model, options.effort)
    const acp = this.#createAcp(options)
    return acp.resumeThread(threadId, workspacePath, {
      instructions: options.instructions,
      approval: options.approval,
      model: resolved.model,
      effort: resolved.effort,
    })
  }

  async sendTurn(
    threadId: string,
    text: string,
    attachments: string[] = [],
    options: AntigravityTurnOptions = {},
  ): Promise<string> {
    if ('model' in options) this.#model = options.model
    if ('effort' in options) this.#effort = options.effort
    if (attachments.length === 0 && isAgyAnsweredCommand(text)) {
      return this.#answerCommand(threadId, `${threadId}-cmd-${++this.#commandCounter}`, text)
    }
    if (!this.#acp) throw new Error('Antigravity session has not started')
    const resolved = await this.#resolveSelection(this.#model, this.#effort)
    return this.#acp.sendTurn(threadId, text, attachments, resolved)
  }

  async interrupt(): Promise<void> {
    if (this.#commandChild) await this.#stopCommand(this.#commandChild, 'interrupt')
    await this.#acp?.interrupt()
  }

  respondToApproval(approvalId: string, decision: ApprovalDecision): void {
    this.#acp?.respondToApproval(approvalId, decision)
  }

  setApproval(approval: ApprovalMode | undefined): void | Promise<void> {
    return this.#acp?.setApproval(approval)
  }

  async listCommands(): Promise<ProviderCommand[]> {
    const advertised = (await this.#acp?.listCommands()) ?? []
    const seen = new Set(advertised.map((command) => command.name.toLowerCase()))
    const extras = AGY_ANSWERED_COMMANDS.filter((command) => !seen.has(command.name.toLowerCase()))
    return [...advertised, ...extras]
  }

  onCommandsChanged(listener: () => void): () => void {
    this.on('commandsChanged', listener)
    return () => this.off('commandsChanged', listener)
  }

  onDisconnected(listener: () => void): () => void {
    this.on('disconnected', listener)
    return () => this.off('disconnected', listener)
  }

  /**
   * `agy models` prints one model slug per line with efforts baked into the
   * slugs, since 1.1.11 each with agy's own name; the listing is collapsed
   * into base models so effort lives on the slider (see models.ts).
   *
   * The built-in CLI shares this read with the sign-in check (sign-in.ts); a
   * custom harness launches its own binary and never borrows that answer.
   */
  async listModels(): Promise<Model[]> {
    const result =
      this.#spawn === spawnAgy ? await sharedAgyModels() : await readAgyModels(this.#spawn)
    if (antigravitySignIn(result) === false) throw new Error(ANTIGRAVITY_SIGN_IN_REQUIRED)
    if (result.code !== 0) throw new Error('Antigravity model discovery failed')
    return parseAntigravityModels(result.stdout)
  }

  async dispose(): Promise<void> {
    const commandStop = this.#commandChild
      ? this.#stopCommand(this.#commandChild, 'silent')
      : Promise.resolve()
    this.#commandChild = undefined
    const acp = this.#acp
    this.#acp = undefined
    await Promise.all([commandStop, acp?.dispose()])
  }

  #createAcp(options: AntigravityStartOptions): AcpAdapter {
    const servers = options.mcpServers ?? this.#defaultMcpServers
    const credentials = options.mcpCredentials ?? this.#defaultMcpCredentials
    const acp = new AcpAdapter('antigravity', {
      name: 'Antigravity',
      command: antigravityCommand(),
      args: ['acp'],
      provider: 'antigravity',
      assumeHttpMcp: true,
      modeForApproval: antigravityModeForApproval,
      mcpServers: prepareAcpMcpServers(servers, credentials),
      env: ANTIGRAVITY_ENVIRONMENT,
      spawn: adaptSpawn(this.#spawn),
    })
    acp.on('event', (event) => this.emit('event', event))
    acp.on('log', (line) => this.emit('log', line))
    acp.on('commandsChanged', () => this.emit('commandsChanged'))
    acp.on('disconnected', () => this.emit('disconnected'))
    this.#acp = acp
    return acp
  }

  async #resolveSelection(
    model: string | undefined,
    effort: string | undefined,
  ): Promise<{ model?: string | undefined; effort?: string | undefined }> {
    if (!model) return { effort }
    if (effort && !getAntigravityIndex()) {
      try {
        await this.listModels()
      } catch (error) {
        this.emit('log', `Antigravity effort discovery failed: ${String(error)}`)
      }
    }
    return {
      model: resolveAntigravityModel(getAntigravityIndex(), model, effort),
      effort,
    }
  }

  /**
   * One of the commands agy answers itself, run as limits.ts runs `/usage`:
   * `--output-format json`, whose single object carries the answer in `response`.
   * Runs outside the ACP session so the conversation stays untouched.
   */
  async #answerCommand(threadId: string, turnId: string, text: string): Promise<string> {
    if (this.#commandChild) await this.#stopCommand(this.#commandChild, 'silent')
    const child = this.#spawn(
      antigravityCommand(),
      ['-p', text.trim(), '--output-format', 'json'],
      {
        cwd: this.#workspacePath,
        env: ANTIGRAVITY_ENVIRONMENT,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    this.#commandChild = child
    this.emit('event', {
      type: 'turn.started',
      turn: { id: turnId, threadId, status: 'running', createdAt: Date.now() },
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < ANSWER_LIMIT_CHARS) stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.emit('log', chunk.trimEnd()))
    let finished = false
    const finish = (error?: string) => {
      if (finished) return
      finished = true
      if (this.#commandChild === child) this.#commandChild = undefined
      const killReason = this.#commandKillReasons.get(child)
      if (killReason) {
        if (killReason === 'interrupt') {
          this.emit('event', { type: 'turn.completed', turnId, status: 'interrupted' })
        }
        return
      }
      const answer = AgyAnswerSchema.safeParse(lastJsonObject(stdout))
      const response = answer.success ? answer.data.response?.trimEnd() : undefined
      if (!error && answer.success && answer.data.status === 'SUCCESS' && response) {
        this.emit('event', {
          type: 'item.completed',
          item: {
            id: `${turnId}-message`,
            turnId,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            text: response,
            createdAt: Date.now(),
          },
        })
        this.emit('event', { type: 'turn.completed', turnId, status: 'completed' })
        return
      }
      // agy's own error text can name the account, so only the command leaves.
      this.emit('event', {
        type: 'thread.error',
        threadId,
        message: error ?? `Antigravity did not answer ${text.trim().split(/\s/)[0]}.`,
      })
      this.emit('event', { type: 'turn.completed', turnId, status: 'failed' })
    }
    child.on('close', () => finish())
    child.on('error', (error) => finish(String(error)))
    // agy waits forever on a piped stdin that stays open.
    child.stdin.end()
    return turnId
  }

  #stopCommand(
    child: ChildProcessWithoutNullStreams,
    reason: 'interrupt' | 'silent',
  ): Promise<void> {
    if (reason === 'interrupt' || !this.#commandKillReasons.has(child)) {
      this.#commandKillReasons.set(child, reason)
    }
    return killTree(child)
  }
}

export function parseAntigravityModels(output: string): Model[] {
  const listing: AntigravityListedModel[] = []
  const seen = new Set<string>()
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    // agy 1.1.10 printed one slug per line. Starting in 1.1.11 it prints a
    // table (`slug<TAB>Display Name`): the slug goes on the wire and the name
    // is agy's own for it. A status sentence uses ordinary single spaces; a
    // table column uses a tab or padding, while a legacy id has no remainder.
    const slug = line.split(/\s+/, 1)[0] ?? ''
    const remainder = line.slice(slug.length)
    if (remainder && !/^(?:\t| {2,})/.test(remainder)) continue
    if (!/^[\w./:-]+$/i.test(slug) || /^(?:id|model|model-id)$/i.test(slug)) continue
    if (seen.has(slug)) continue
    seen.add(slug)
    const displayName = remainder.trim()
    listing.push(displayName ? { slug, displayName } : { slug })
  }
  const { models, index } = collapseAntigravityModels(listing)
  rememberAntigravityIndex(index)
  return models
}

export { SUPPORTED as ANTIGRAVITY_SUPPORTED_VERSION }
