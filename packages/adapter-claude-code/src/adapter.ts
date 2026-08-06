import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ApprovalMode, Capabilities, DomainEvent, Model, Thread } from '@harness/contracts'
import { killTree, readNdjson, spawnCli } from '@harness/proc'
import { toDomainEvents, type ClaudeEvent } from './events.js'

/**
 * Tier 3 adapter: drives the `claude` CLI in headless streaming mode.
 *
 * Unlike Codex there is no protocol server and no generated types — this reads
 * NDJSON off stdout and is coupled to an output shape we do not control. Every
 * field is treated as optional and anything unrecognised is ignored rather
 * than fatal, because the shape will change and a session dying on an unknown
 * event is a worse failure than a missing row.
 *
 * Verified against claude-code 2.1.220.
 *
 * As with Codex, this never reads a credential. The binary authenticates
 * itself. See rules/security.md.
 */

const SUPPORTED = '2.1'

export const CLAUDE_CAPABILITIES: Capabilities = {
  // No steer or fork over the CLI surface: those are protocol features Codex
  // has and this does not. The UI reads capabilities and hides what is absent
  // rather than offering a button that fails.
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: true,
  approvals: false,
  images: false,
}

/**
 * The aliases `claude --model` documents, not concrete model ids: each alias
 * tracks the newest model of its family, so the ids survive releases. The
 * display names DO name the current version — users pick "Fable 5", not a
 * vague family word — which makes them the one thing to touch when Anthropic
 * ships a new generation. Current as of claude-code 2.1.222.
 */
export const CLAUDE_MODELS: Model[] = [
  claudeAlias('fable', 'Fable 5', 'Most capable — flagship tier', true),
  claudeAlias('opus', 'Opus 5', 'Deep reasoning'),
  claudeAlias('sonnet', 'Sonnet 5', 'Balanced speed and capability'),
  claudeAlias('haiku', 'Haiku 4.5', 'Fastest and cheapest'),
]

function claudeAlias(
  id: string,
  displayName: string,
  description: string,
  isDefault = false,
): Model {
  return { id, displayName, description, isDefault, reasoningEfforts: [], serviceTiers: [] }
}

/** Claude Code names its permission modes differently; ours map on cleanly. */
const PERMISSION_MODE: Partial<Record<ApprovalMode, string>> = {
  ask: 'default',
  auto: 'acceptEdits',
  full: 'bypassPermissions',
}

export type ClaudeAdapterEvents = {
  event: [DomainEvent]
  log: [string]
}

export type ClaudeStartOptions = {
  instructions?: string | undefined
  model?: string | undefined
  approval?: ApprovalMode | undefined
}

export class ClaudeCodeAdapter extends EventEmitter<ClaudeAdapterEvents> {
  #workspacePath = ''
  #options: ClaudeStartOptions = {}
  /** Claude Code's own session id, so follow-up turns resume rather than restart. */
  #sessionId: string | undefined
  #child: ChildProcessWithoutNullStreams | undefined
  #turnCounter = 0

  get capabilities(): Capabilities {
    return CLAUDE_CAPABILITIES
  }

  /**
   * There is no long-lived process to start. A turn is one invocation, and
   * continuity comes from `--resume` with the session id the CLI hands back.
   */
  async startThread(workspacePath: string, options: ClaudeStartOptions = {}): Promise<Thread> {
    if (options.approval === 'auto-review') {
      throw new Error('Claude Code does not support automatic approval review')
    }
    this.#workspacePath = workspacePath
    this.#options = options
    this.#sessionId = undefined
    return {
      id: `claude-${crypto.randomUUID()}`,
      provider: 'claude-code',
      workspacePath,
      createdAt: Date.now(),
    }
  }

  async sendTurn(threadId: string, text: string): Promise<string> {
    const turnId = `${threadId}-turn-${++this.#turnCounter}`
    const permissionMode = this.#options.approval
      ? PERMISSION_MODE[this.#options.approval]
      : undefined

    const args = [
      '-p',
      text,
      '--output-format',
      'stream-json',
      // Required alongside stream-json, and it is what surfaces tool calls at
      // all rather than only the final answer.
      '--verbose',
      ...(this.#options.model ? ['--model', this.#options.model] : []),
      ...(permissionMode ? ['--permission-mode', permissionMode] : []),
      ...(this.#options.instructions ? ['--append-system-prompt', this.#options.instructions] : []),
      // Continuity: without this every turn starts a fresh context and the
      // agent forgets the conversation it is in the middle of.
      ...(this.#sessionId ? ['--resume', this.#sessionId] : []),
    ]

    // A turn already in flight would be orphaned by the reassignment below —
    // its exit handler must also not clobber the new child's reference.
    if (this.#child) killTree(this.#child)
    const child = spawnCli('claude', args, { cwd: this.#workspacePath })
    this.#child = child

    this.emit('event', {
      type: 'turn.started',
      turn: { id: turnId, threadId, status: 'running', createdAt: Date.now() },
    })

    readNdjson(
      child.stdout,
      (value) => this.#onEvent(value as ClaudeEvent, turnId),
      (line) => this.emit('log', `unparsable stdout: ${line.slice(0, 200)}`),
    )

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.emit('log', chunk.trimEnd()))

    child.on('exit', (code) => {
      if (this.#child === child) this.#child = undefined
      // A non-zero exit without a `result` event means the CLI failed before
      // it could report anything, and silence would look like a hang.
      if (code !== 0 && code !== null) {
        this.emit('event', {
          type: 'thread.error',
          threadId,
          message: `claude exited with code ${code}`,
        })
        this.emit('event', { type: 'turn.completed', turnId, status: 'failed' })
      }
    })

    // A spawn failure emits 'error' on the child; without a listener that
    // throws out of the event loop and takes the whole server down.
    child.on('error', (error) => {
      if (this.#child === child) this.#child = undefined
      this.emit('event', { type: 'thread.error', threadId, message: String(error) })
      this.emit('event', { type: 'turn.completed', turnId, status: 'failed' })
    })

    return turnId
  }

  async interrupt(): Promise<void> {
    if (this.#child) killTree(this.#child)
  }

  /**
   * Models are not enumerable over this surface — there is no equivalent of
   * Codex's model/list — but `--model` documents stable aliases that always
   * point at the newest model of each family. Offering those instead of full
   * model ids keeps the list from going stale when a new version ships.
   * Verified against claude-code 2.1.222.
   */
  async listModels(): Promise<Model[]> {
    return CLAUDE_MODELS
  }

  dispose(): void {
    if (this.#child) killTree(this.#child)
    this.#child = undefined
  }

  #onEvent(event: ClaudeEvent, turnId: string): void {
    // The init event carries the session id we need for the next turn.
    if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
      this.#sessionId = event.session_id
      const version = String((event as { claude_code_version?: string }).claude_code_version ?? '')
      if (version && !version.startsWith(SUPPORTED)) {
        this.emit(
          'log',
          `claude-code ${version} is newer than the ${SUPPORTED}.x this adapter was written against`,
        )
      }
      return
    }

    if (event.type === 'rate_limit_event') {
      const info = (event as { rate_limit_info?: { utilization?: number } }).rate_limit_info
      if (info?.utilization && info.utilization > 0.9) {
        this.emit('log', `rate limit at ${Math.round(info.utilization * 100)}%`)
      }
      return
    }

    for (const domainEvent of toDomainEvents(event, turnId)) {
      this.emit('event', domainEvent)
    }
  }
}
