import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import type { ApprovalMode, Capabilities, DomainEvent, Model, Thread } from '@harness/contracts'
import {
  argumentPromptLimit,
  holdsProcessGroup,
  killTree,
  ProtocolFrameError,
  readNdjson,
} from '@harness/proc'
import { z } from 'zod'
import { ANTIGRAVITY_ENVIRONMENT, antigravityCommand, spawnAgy, type AgySpawn } from './command.js'
import { agyCommandName, isAgyAnsweredCommand } from './commands.js'
import { lastJsonObject } from './limits.js'
import {
  ANTIGRAVITY_SIGN_IN_REQUIRED,
  antigravitySignIn,
  readAgyModels,
  sharedAgyModels,
} from './sign-in.js'
import {
  collapseAntigravityModels,
  getAntigravityIndex,
  rememberAntigravityIndex,
  resolveAntigravityModel,
  type AntigravityListedModel,
} from './models.js'
import { ANTIGRAVITY_CAPABILITIES } from './capabilities.js'

/**
 * Tier 3 adapter: drives Google's Antigravity CLI (`agy`) in headless
 * stream-json mode. Antigravity replaced the Gemini CLI for individual
 * accounts in June 2026; unlike gemini-cli it has no ACP mode, so this is a
 * per-turn print invocation like the Claude Code adapter.
 *
 * Frames captured against agy 1.1.10 on Windows through real non-TTY pipes:
 *
 *   {"event":"init","conversation_id":"...","init":{"model":"...","cwd":"..."}}
 *   {"event":"step_update","step_update":{"state":"ACTIVE","step_type":"agent_response","text_delta":"..."}}
 *   {"event":"result","result":{"conversation_id":"...","status":"SUCCESS","response":"...","usage":{...}}}
 *
 * `agy.exe` is a real executable, not a .cmd shim, so it is spawned directly
 * rather than through `spawnCli`'s cmd.exe route — cmd.exe truncates argv at
 * the first newline (#372), and a direct spawn carries multi-line prompts
 * intact (verified by capture).
 *
 * This never reads a credential. The binary authenticates itself with the
 * user's Google account on first interactive run. See rules/security.md.
 */

const SUPPORTED = '1.1'

export { ANTIGRAVITY_CAPABILITIES } from './capabilities.js'

export type AntigravityStartOptions = {
  instructions?: string | undefined
  model?: string | undefined
  effort?: string | undefined
  approval?: ApprovalMode | undefined
}

export type AntigravityTurnOptions = Pick<AntigravityStartOptions, 'model' | 'effort'>

function applyAntigravityTurnOptions(
  current: AntigravityStartOptions,
  next: AntigravityTurnOptions,
): AntigravityStartOptions {
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

/**
 * Names attached images in the prompt so the agent opens them with its own
 * file viewer. Print mode has no image input of its own: `--input-format
 * stream-json` accepts a single content block type (agy 1.1.x strings:
 * "stream input content block type %q is not supported (only %q)"), and the
 * CLI's paste-an-image path exists only in its interactive prompt.
 */
export function antigravityImagePrompt(text: string, attachments: readonly string[]): string {
  if (attachments.length === 0) return text
  const subject = attachments.length === 1 ? 'this image' : 'these images'
  const block = [
    '<attached-images>',
    `The user attached ${subject}. Open each file with your file viewer to see it before you answer.`,
    ...attachments.map((file) => `- ${file}`),
    '</attached-images>',
  ].join('\n')
  return text.trim() ? `${text}\n\n${block}` : block
}

/**
 * The per-turn argv. The prompt may be multi-line because the binary is
 * spawned directly (never through cmd.exe).
 */
export function antigravityTurnArgs(
  prompt: string,
  options: AntigravityStartOptions,
  conversationId: string | undefined,
  readableDirectories: readonly string[] = [],
): string[] {
  // The picker holds a collapsed base id; the wire wants the concrete
  // per-effort slug from the listing.
  const model = options.model
    ? resolveAntigravityModel(getAntigravityIndex(), options.model, options.effort)
    : undefined
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    ...(model ? ['--model', model] : []),
    // ask -> the CLI's default permission behavior; auto -> accept edits but
    // not commands; full -> the CLI's own skip-everything switch.
    ...(options.approval === 'auto' ? ['--mode', 'accept-edits'] : []),
    ...(options.approval === 'full' ? ['--dangerously-skip-permissions'] : []),
    ...(conversationId ? ['--conversation', conversationId] : []),
    // Attached images are saved outside the workspace, where agy's
    // non-workspace file policy would stop its file viewer; --add-dir is its
    // own switch for reading one more directory (agy 1.x usage string
    // "--add-dir <path>").
    ...readableDirectories.flatMap((directory) => ['--add-dir', directory]),
  ]
}

const AgyUsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  thinking_tokens: z.number().optional(),
  cache_read_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
})

const AgyFrameSchema = z.object({
  event: z.string().optional(),
  conversation_id: z.string().optional(),
  step_update: z
    .object({
      state: z.string().optional(),
      step_type: z.string().optional(),
      text_delta: z.string().optional(),
      usage: AgyUsageSchema.optional(),
    })
    .optional(),
  result: z
    .object({
      conversation_id: z.string().optional(),
      status: z.string().optional(),
      response: z.string().optional(),
      // agy 1.4.7 steps.JSONOutput: `Error string json:"error,omitempty"`.
      error: z.string().optional(),
      usage: AgyUsageSchema.optional(),
    })
    .optional(),
})

/**
 * How long a turn whose result frame did not say SUCCESS waits for agy to
 * exit. agy closes its store and exits within a second of the result; one
 * that is still running after this is judged on the frame alone.
 */
export const ANTIGRAVITY_RESULT_EXIT_GRACE_MS = 10_000

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
}

type SpawnFn = AgySpawn

export class AntigravityAdapter extends EventEmitter<AntigravityAdapterEvents> {
  #processStop: Promise<void> = Promise.resolve()
  readonly #spawn: SpawnFn
  #workspacePath = ''
  #options: AntigravityStartOptions = {}
  /** agy's own conversation id, so follow-up turns resume rather than restart. */
  #conversationId: string | undefined
  #child: ChildProcessWithoutNullStreams | undefined
  /**
   * Turns whose agy exited cleanly and whose POSIX process group still has
   * members, such as a server the turn started. Dispose stops them.
   */
  #finishedTurns = new Set<ChildProcessWithoutNullStreams>()
  /** Turns whose agy reported a successful result and is only closing. */
  #answered = new WeakSet<ChildProcessWithoutNullStreams>()
  /** Why we killed a child: only an explicit Stop completes the turn. */
  #killReasons = new WeakMap<ChildProcessWithoutNullStreams, 'interrupt' | 'silent'>()
  #turnCounter = 0
  /** Session instructions ride in front of the first prompt: the CLI has no
   *  system-prompt flag, and the same pattern is what the Cursor adapter uses. */
  #instructionsPending = false

  constructor(options: { spawn?: SpawnFn } = {}) {
    super()
    this.#spawn = options.spawn ?? spawnAgy
  }

  /** The prompt is an argument of every turn's command line. */
  get promptLimit(): number {
    return argumentPromptLimit()
  }

  get capabilities(): Capabilities {
    return ANTIGRAVITY_CAPABILITIES
  }

  async startThread(workspacePath: string, options: AntigravityStartOptions = {}): Promise<Thread> {
    if (options.approval === 'auto-review') {
      throw new Error('Antigravity does not support automatic approval review')
    }
    this.#workspacePath = workspacePath
    this.#options = options
    this.#conversationId = undefined
    // The background-process note goes out even without session instructions.
    this.#instructionsPending = true
    return {
      id: `antigravity-${crypto.randomUUID()}`,
      provider: 'antigravity',
      workspacePath,
      createdAt: Date.now(),
    }
  }

  async sendTurn(
    threadId: string,
    text: string,
    attachments: string[] = [],
    options: AntigravityTurnOptions = {},
  ): Promise<string> {
    this.#options = applyAntigravityTurnOptions(this.#options, options)
    if (attachments.length === 0 && isAgyAnsweredCommand(text)) {
      return this.#answerCommand(threadId, `${threadId}-turn-${++this.#turnCounter}`, text)
    }
    // The picker normally warms this process-wide index. A server restart can
    // resume straight into a turn, though, and passing the collapsed anchor
    // id in that case silently loses a non-default effort selection.
    if (this.#options.model && this.#options.effort && !getAntigravityIndex()) {
      try {
        await this.listModels()
      } catch (error) {
        this.emit('log', `Antigravity effort discovery failed: ${String(error)}`)
      }
    }
    const turnId = `${threadId}-turn-${++this.#turnCounter}`
    const request = antigravityImagePrompt(text, attachments)
    // agy expands a slash command or skill only at the start of the prompt, so
    // a command goes alone and the instructions wait for the next prompt.
    const carriesInstructions = this.#instructionsPending && !agyCommandName(text)
    const instructions = [
      this.#options.instructions,
      antigravityBackgroundNote(this.#workspacePath),
    ]
      .filter(Boolean)
      .join('\n\n')
    const prompt = carriesInstructions
      ? `<system-instructions>\n${instructions}\n</system-instructions>\n\n${request}`
      : request
    if (carriesInstructions) this.#instructionsPending = false
    const args = antigravityTurnArgs(prompt, this.#options, this.#conversationId, [
      ...new Set(attachments.map((file) => path.dirname(file))),
    ])

    // A turn already in flight would be orphaned by the reassignment below —
    // its exit handler must also not clobber the new child's reference.
    if (this.#child) await this.#retire(this.#child)
    const child = this.#spawn(antigravityCommand(), args, {
      cwd: this.#workspacePath,
      env: ANTIGRAVITY_ENVIRONMENT,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      keepGroupAfterExit: true,
    })
    this.#child = child
    child.once('exit', (code) => {
      // Only a turn agy finished keeps what it started; a failed or stopped
      // one takes its leftovers with it, as before.
      if (code !== 0) {
        void killTree(child).catch(() => undefined)
        return
      }
      for (const old of this.#finishedTurns) {
        if (!holdsProcessGroup(old)) this.#finishedTurns.delete(old)
      }
      if (holdsProcessGroup(child)) this.#finishedTurns.add(child)
    })

    this.emit('event', {
      type: 'turn.started',
      turn: { id: turnId, threadId, status: 'running', createdAt: Date.now() },
    })

    let terminal = false
    let messageStarted = false
    let messageText = ''
    const messageId = `${turnId}-message`
    /** A result frame that did not say SUCCESS, waiting for agy's exit code. */
    let reported: { status: string; error?: string; timer: NodeJS.Timeout } | undefined

    readNdjson(
      child.stdout,
      (value) => {
        if (terminal) return
        const frame = AgyFrameSchema.parse(value)
        if (frame.event === 'init' && frame.conversation_id) {
          this.#conversationId = frame.conversation_id
          return
        }
        if (frame.event === 'step_update' && frame.step_update?.step_type === 'agent_response') {
          const delta = frame.step_update.text_delta ?? ''
          if (!delta) return
          if (!messageStarted) {
            messageStarted = true
            this.emit('event', {
              type: 'item.started',
              item: {
                id: messageId,
                turnId,
                type: 'message',
                role: 'assistant',
                status: 'started',
                text: '',
                createdAt: Date.now(),
              },
            })
          }
          messageText += delta
          this.emit('event', { type: 'item.delta', turnId, itemId: messageId, textDelta: delta })
          return
        }
        if (frame.event === 'result' && frame.result) {
          terminal = true
          const usage = frame.result.usage
          const text = frame.result.response ?? messageText
          if (messageStarted || text.trim()) {
            this.emit('event', {
              type: 'item.completed',
              item: {
                id: messageId,
                turnId,
                type: 'message',
                role: 'assistant',
                status: 'completed',
                text: text.trimEnd(),
                createdAt: Date.now(),
              },
            })
          }
          if (usage) {
            const reasoningTokens = usage.thinking_tokens ?? 0
            this.emit('event', {
              type: 'usage.updated',
              usage: {
                ...(this.#options.model
                  ? {
                      model: this.#options.model,
                    }
                  : {}),
                inputTokens: usage.input_tokens ?? 0,
                cachedInputTokens: usage.cache_read_tokens ?? 0,
                outputTokens: (usage.output_tokens ?? 0) + reasoningTokens,
                reasoningTokens,
                totalTokens: usage.total_tokens ?? 0,
              },
            })
          }
          if (frame.result.status === 'SUCCESS') {
            this.#answered.add(child)
            this.emit('event', { type: 'turn.completed', turnId, status: 'completed' })
            return
          }
          // The status covers the whole conversation, not this turn. agy
          // 1.4.7's steps.BuildJSONOutput sets ERROR, and the step's message
          // in `error`, whenever the conversation's latest error step (an
          // error message, or a failed step that is not a tool call) exists,
          // even in an earlier turn; the SUCCESS a finished turn asks for is
          // dropped once `error` is set. agy judges the turn itself only from
          // this turn's steps, and that verdict is the exit code
          // (printmode.ExitCode: 0 when the turn finished, 3 for an agent or
          // model failure, 1 otherwise). So the turn waits for it.
          const timer = setTimeout(
            () => settleReported(undefined),
            ANTIGRAVITY_RESULT_EXIT_GRACE_MS,
          )
          timer.unref()
          reported = {
            status: frame.result.status ?? 'unknown',
            ...(frame.result.error ? { error: frame.result.error } : {}),
            timer,
          }
        }
      },
      (line) => this.emit('log', `unparsable stdout: ${line.slice(0, 200)}`),
      {
        onError: (error) => {
          // A frame that does not match the schema, or a throwing event
          // listener, leaves the stream intact; keep reading it.
          if (!(error instanceof ProtocolFrameError)) {
            this.emit('log', `Antigravity event handling failed: ${error.message}`)
            return
          }
          finishProcess(error.message)
          void killTree(child)
        },
      },
    )

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.emit('log', chunk.trimEnd()))

    // Settles a turn whose result frame did not say SUCCESS. `code` is agy's
    // exit code, or undefined when the process failed or outlived the grace.
    const settleReported = (code: number | null | undefined) => {
      const result = reported
      if (!result) return
      reported = undefined
      clearTimeout(result.timer)
      const killReason = this.#killReasons.get(child)
      if (killReason === 'silent') return
      if (killReason === 'interrupt') {
        this.emit('event', { type: 'turn.completed', turnId, status: 'interrupted' })
        return
      }
      if (code === 0) {
        // A finished turn: the answer is delivered and the error belongs to
        // an earlier step, so it stays out of the chat and goes to the log.
        this.emit(
          'log',
          `Antigravity finished the turn; its result said ${result.status}${result.error ? `: ${result.error}` : ''}`,
        )
        this.emit('event', { type: 'turn.completed', turnId, status: 'completed' })
        return
      }
      this.emit('event', {
        type: 'thread.error',
        threadId,
        message: `Antigravity finished with status ${result.status}`,
      })
      this.emit('event', { type: 'turn.completed', turnId, status: 'failed' })
    }

    // A spawn failure reports 'error' and then 'close', and a stream failure
    // kills the child, so every exit path funnels through one terminal guard.
    const finishProcess = (errorMessage: string, code?: number | null) => {
      if (this.#child === child) this.#child = undefined
      if (reported) {
        settleReported(code)
        return
      }
      if (terminal) return
      terminal = true
      const killReason = this.#killReasons.get(child)
      if (!killReason) {
        this.emit('event', { type: 'thread.error', threadId, message: errorMessage })
      }
      if (messageStarted) {
        this.emit('event', {
          type: 'item.completed',
          item: {
            id: messageId,
            turnId,
            type: 'message',
            role: 'assistant',
            status: 'failed',
            text: messageText.trimEnd(),
            createdAt: Date.now(),
          },
        })
      }
      if (killReason !== 'silent') {
        this.emit('event', {
          type: 'turn.completed',
          turnId,
          status: killReason === 'interrupt' ? 'interrupted' : 'failed',
        })
      }
    }

    // An exit without a result frame would otherwise look like a hang.
    child.on('close', (code) =>
      finishProcess(`agy exited with code ${code ?? 'unknown'} before reporting a result`, code),
    )
    // 'close' also waits for every holder of agy's pipes; the exit code a
    // reported result waits for is known at 'exit'.
    child.on('exit', (code) => settleReported(code))

    // A spawn failure emits 'error' on the child; without a listener that
    // throws out of the event loop and takes the whole server down.
    child.on('error', (error) => finishProcess(String(error)))

    child.stdin.end()
    return turnId
  }

  /**
   * One of the commands agy answers itself, run as limits.ts runs `/usage`:
   * `--output-format json`, whose single object (fixtures/agy-usage-1.4.7.json)
   * carries the answer in `response`, one tab-separated record per line. No
   * model, mode or conversation switch: the answer starts no agent turn and
   * leaves no conversation, so the chat's next prompt resumes as before.
   */
  async #answerCommand(threadId: string, turnId: string, text: string): Promise<string> {
    if (this.#child) await this.#retire(this.#child)
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
    this.#child = child
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
      if (this.#child === child) this.#child = undefined
      const killReason = this.#killReasons.get(child)
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

  async interrupt(): Promise<void> {
    if (this.#child) await this.#stop(this.#child, 'interrupt')
  }

  /**
   * `agy models` prints one model slug per line with efforts baked into the
   * slugs, since 1.1.11 each with agy's own name; the listing is collapsed
   * into base models so effort lives on the slider (see models.ts). Verified
   * against agy 1.1.10, 1.3.4 and 1.4.0.
   *
   * The CLI blocks forever on a piped stdin that never closes — captured: an
   * open-stdin `agy models` never exits, a closed one answers in under two
   * seconds — so stdin closes immediately and the discovery must not go
   * through helpers that keep it open.
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

  dispose(): Promise<void> {
    // Servers earlier turns left running end with the chat's runtime.
    const finished = [...this.#finishedTurns].map((child) => killTree(child).catch(() => undefined))
    this.#finishedTurns.clear()
    const stopped = this.#child ? this.#stop(this.#child) : this.#processStop
    this.#child = undefined
    this.#processStop = stopped
    return Promise.all([stopped, ...finished]).then(() => undefined)
  }

  /**
   * Makes way for a new turn. An agy that already answered is only closing:
   * it gets a moment to exit, and then only agy itself is stopped, so its
   * process group, with a server the turn started, stays.
   */
  async #retire(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (!this.#answered.has(child)) return this.#stop(child)
    if (await exitsWithin(child, ANSWERED_EXIT_WAIT_MS)) return
    this.#killReasons.set(child, 'silent')
    child.kill()
  }

  #stop(
    child: ChildProcessWithoutNullStreams,
    reason: 'interrupt' | 'silent' = 'silent',
  ): Promise<void> {
    if (reason === 'interrupt' || !this.#killReasons.has(child))
      this.#killReasons.set(child, reason)
    this.#processStop = killTree(child)
    return this.#processStop
  }
}

/**
 * How long a new turn waits for the previous agy, which has answered and is
 * only closing, to exit by itself. Stopping its tree instead would end a
 * server that turn started; a queued prompt starts a turn at once.
 */
const ANSWERED_EXIT_WAIT_MS = 5_000

function exitsWithin(child: ChildProcessWithoutNullStreams, ms: number): Promise<boolean> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off('exit', done)
      resolve(false)
    }, ms)
    timer.unref()
    child.once('exit', done)
  })
}

/**
 * agy runs the commands of a turn in a Windows job object (agy.exe imports
 * CreateJobObject and AssignProcessToJobObject), and its process ends with the
 * turn, so a dev server it started stopped as soon as the answer was in. A
 * process created through WMI is not in that job; it also outlives TasteCode,
 * like a server the user starts in a terminal. On POSIX the turn's process
 * group is kept after agy exits (keepGroupAfterExit), and a `nohup … &`
 * command outlives agy's own shell. Logs go to the temp folder, not the project.
 */
export function antigravityBackgroundNote(
  workspacePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const folder = workspacePath.replaceAll("'", "''")
  const start =
    platform === 'win32'
      ? `powershell -NoProfile -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd /c npm run dev > %TEMP%\\dev-server.log 2>&1'; CurrentDirectory = '${folder}'; ProcessStartupInformation = (New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }) }"`
      : 'nohup npm run dev > "${TMPDIR:-/tmp}/dev-server.log" 2>&1 < /dev/null &'
  return [
    'Every process you start ends when your answer ends. To leave a dev server or another long-running process running for the user after you answer, start it detached and write its output to a log file, for example:',
    start,
    'Then check that it responds before you tell the user its address.',
  ].join('\n')
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
