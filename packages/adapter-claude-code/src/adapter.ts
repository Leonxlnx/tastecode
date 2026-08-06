import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
 * Nothing multi-line may ever go on argv: on Windows `spawnCli` runs through a
 * cmd.exe shim, and cmd.exe cuts the assembled command line at the first
 * newline inside any argument — silently dropping the rest of that argument
 * and every argument after it (#372). The prompt therefore travels over stdin
 * as stream-json input, and the session instructions travel as a file path via
 * `--append-system-prompt-file`.
 *
 * Verified against claude-code 2.1.220; stdin stream-json prompt delivery,
 * `--resume` alongside it, and `--append-system-prompt-file` captured against
 * 2.1.222 on Windows through the real cmd.exe spawn path.
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

/** One stream-json stdin line: how the prompt reaches the CLI, never argv. */
export function claudeUserMessage(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`
}

/**
 * The per-turn argv. Exported for the test that holds the #372 invariant:
 * no element may ever contain a newline, because cmd.exe would truncate the
 * command line there and silently drop every argument after it.
 */
export function claudeTurnArgs(
  options: ClaudeStartOptions,
  sessionId: string | undefined,
  instructionsFile: string | undefined,
): string[] {
  const permissionMode = options.approval ? PERMISSION_MODE[options.approval] : undefined
  return [
    '-p',
    '--output-format',
    'stream-json',
    // Required alongside stream-json, and it is what surfaces tool calls at
    // all rather than only the final answer.
    '--verbose',
    '--input-format',
    'stream-json',
    ...(options.model ? ['--model', options.model] : []),
    ...(permissionMode ? ['--permission-mode', permissionMode] : []),
    ...(instructionsFile ? ['--append-system-prompt-file', instructionsFile] : []),
    // Continuity: without this every turn starts a fresh context and the
    // agent forgets the conversation it is in the middle of.
    ...(sessionId ? ['--resume', sessionId] : []),
  ]
}

export class ClaudeCodeAdapter extends EventEmitter<ClaudeAdapterEvents> {
  #workspacePath = ''
  #options: ClaudeStartOptions = {}
  /** Claude Code's own session id, so follow-up turns resume rather than restart. */
  #sessionId: string | undefined
  #child: ChildProcessWithoutNullStreams | undefined
  /** Children we killed on purpose — their non-zero exits are not failures. */
  #intentionalKills = new WeakSet<ChildProcessWithoutNullStreams>()
  #turnCounter = 0
  /** Where the multi-line session instructions live, since argv cannot carry them. */
  #instructionsDir: string | undefined
  #instructionsFile: string | undefined

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
    this.#clearInstructionsFile()
    if (options.instructions) {
      try {
        this.#instructionsDir = mkdtempSync(path.join(tmpdir(), 'harness-claude-'))
        this.#instructionsFile = path.join(this.#instructionsDir, 'system-prompt.md')
        writeFileSync(this.#instructionsFile, options.instructions, 'utf8')
      } catch (error) {
        // Style guidance is not worth failing the thread over; run without it.
        this.#clearInstructionsFile()
        this.emit('log', `session instructions dropped: ${String(error)}`)
      }
    }
    return {
      id: `claude-${crypto.randomUUID()}`,
      provider: 'claude-code',
      workspacePath,
      createdAt: Date.now(),
    }
  }

  async sendTurn(threadId: string, text: string): Promise<string> {
    const turnId = `${threadId}-turn-${++this.#turnCounter}`
    const args = claudeTurnArgs(this.#options, this.#sessionId, this.#instructionsFile)

    // A turn already in flight would be orphaned by the reassignment below —
    // its exit handler must also not clobber the new child's reference.
    if (this.#child) this.#stop(this.#child)
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
      // it could report anything, and silence would look like a hang. But an
      // exit WE caused is not a failure: taskkill reports code 1, and the old
      // check wrote a phantom "claude exited with code 1" into the transcript
      // on every Stop, close, and turn replacement.
      if (this.#intentionalKills.has(child)) return
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

    // A child that dies before reading stdin surfaces EPIPE here; the exit
    // handler already reports that failure, so the write error is only noise.
    child.stdin.on('error', () => undefined)
    child.stdin.write(claudeUserMessage(text))
    child.stdin.end()

    return turnId
  }

  async interrupt(): Promise<void> {
    if (this.#child) this.#stop(this.#child)
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
    if (this.#child) this.#stop(this.#child)
    this.#child = undefined
    this.#clearInstructionsFile()
  }

  #clearInstructionsFile(): void {
    if (this.#instructionsDir) {
      try {
        rmSync(this.#instructionsDir, { recursive: true, force: true })
      } catch {
        // A leftover temp directory is not worth surfacing; the OS sweeps it.
      }
    }
    this.#instructionsDir = undefined
    this.#instructionsFile = undefined
  }

  /** Kill a child we own on purpose, and remember that its exit is ours. */
  #stop(child: ChildProcessWithoutNullStreams): void {
    this.#intentionalKills.add(child)
    killTree(child)
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
