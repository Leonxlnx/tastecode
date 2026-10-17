import type { DomainEvent, Item, Subagent, SubagentState } from '@harness/contracts'
import { z } from 'zod'

/**
 * Grok Build's subagents as grok 1.0.62 prints them in streaming-json
 * (fixtures/stream-subagent.jsonl, fixtures/stream-subagent-cancelled.jsonl):
 *
 *   tool_call         toolName spawn_subagent, rawInput { description, prompt,
 *                     subagent_type?, background? }          background defaults to true
 *   tool_call_update  completed, rawOutput { type: 'SubagentCompleted', output,
 *                     subagent_id, subagent_type, tool_calls, duration_ms }  foreground result
 *   tool_call_update  completed, rawOutput { type: 'Text', text: 'Subagent started in
 *                     background.\nsubagent_id: <id>\n…' }   background start
 *   tool_call_update  failed, 'User cancelled the execution for tool `spawn_subagent`'
 *                     a headless run that may not ask for the permission
 *   tool_call         toolName get_command_or_subagent_output, rawInput { task_ids }
 *   tool_call_update  completed, rawOutput { type: 'TaskOutput', Result: { task_id,
 *                     status, duration_secs, output } }     a background result
 *
 * Every subagent's own thoughts, text and tool calls arrive on the same stdout, and no
 * field names the agent that sent them. While the main agent waits on one of its own tool
 * calls it cannot send anything itself, so a frame that arrives then, while a subagent
 * runs, is a subagent's. Grok names a call `call-<response id>-<index>`; a call from the
 * response the main agent is waiting on is its own parallel call, not a subagent's.
 */

/** Progress repeats the whole item, so a chatty subagent re-renders its row at most once a second. */
const MIN_UPDATE_MS = 1_000
/** A finished agent's report can run to pages; the row needs only its start. */
const SUMMARY_LIMIT = 1_000
const SPAWN_TOOL = 'spawn_subagent'
const OUTPUT_TOOL = 'get_command_or_subagent_output'

const SpawnInputSchema = z.object({
  description: z.string().optional(),
  subagent_type: z.string().optional(),
  background: z.boolean().optional(),
})

const CompletedSchema = z.object({
  type: z.literal('SubagentCompleted'),
  output: z.string().optional(),
  subagent_id: z.string().optional(),
  subagent_type: z.string().optional(),
  tool_calls: z.number().int().nonnegative().optional(),
  duration_ms: z.number().nonnegative().optional(),
})

const StartedSchema = z.object({ type: z.literal('Text'), text: z.string() })

const TaskResultSchema = z.object({
  task_id: z.string(),
  /** [subagent:<type>] <description> for a subagent. */
  command: z.string().optional(),
  status: z.string().optional(),
  duration_secs: z.number().nonnegative().optional(),
  output: z.string().optional(),
})

const TaskOutputSchema = z.object({
  type: z.literal('TaskOutput'),
  Result: z.union([TaskResultSchema, z.array(TaskResultSchema)]),
})

export type GrokToolFrame = {
  type?: string | undefined
  toolCallId?: string | undefined
  toolName?: string | undefined
  title?: string | undefined
  status?: string | null | undefined
  rawInput?: Record<string, unknown> | undefined
  rawOutput?: unknown
  content?: unknown
}

type Run = {
  subagent: Subagent
  /** Grok's own id, known once the spawn call answers; background results name it. */
  agentId: string | undefined
  /** The newest item sent for the spawning call, without its snapshot. */
  item: Item | undefined
  sentAt: number
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Follows the subagents of one Grok turn and keeps their own frames out of the transcript. */
export class GrokSubagents {
  readonly #emit: (event: DomainEvent) => void
  /** Spawning toolCallId -> run. */
  readonly #runs = new Map<string, Run>()
  /** Calls a subagent made, so their updates stay out of the transcript too. */
  readonly #childCalls = new Set<string>()

  constructor(emit: (event: DomainEvent) => void) {
    this.#emit = emit
  }

  /**
   * Whether a frame came from a subagent. `openCalls` are the main agent's own tool
   * calls that have not answered yet.
   */
  isChildFrame(frame: GrokToolFrame, openCalls: Iterable<string>): boolean {
    // Most turns start no subagent; every streamed delta passes through here.
    if (this.#runs.size === 0) return false
    if (frame.type === 'tool_call_update') {
      if (!frame.toolCallId || !this.#childCalls.has(frame.toolCallId)) return false
      if (frame.status === 'completed' || frame.status === 'failed')
        this.#childCalls.delete(frame.toolCallId)
      return true
    }
    if (frame.type !== 'thought' && frame.type !== 'text' && frame.type !== 'tool_call')
      return false
    const running = this.#running()
    if (running.length === 0) return false
    const waitingOn = new Set<string>()
    for (const id of openCalls) waitingOn.add(responseOf(id) ?? id)
    if (waitingOn.size === 0) return false
    if (frame.type !== 'tool_call') return true
    if (!frame.toolCallId) return false
    const response = responseOf(frame.toolCallId)
    // An id this adapter cannot read stays visible: a leak beats a hidden step.
    if (!response || waitingOn.has(response)) return false
    this.#childCalls.add(frame.toolCallId)
    // With one subagent running, its step is known; with several it is not.
    if (running.length === 1) {
      const run = running[0]!
      run.subagent = {
        ...run.subagent,
        toolUses: (run.subagent.toolUses ?? 0) + 1,
        ...(frame.toolName ? { lastTool: frame.toolName } : {}),
      }
      this.#schedule(run)
    }
    return true
  }

  /** The snapshot for a spawn call that has just started, or undefined for any other call. */
  spawn(toolCallId: string, toolName: string, input: unknown): Subagent | undefined {
    if (toolName !== SPAWN_TOOL) return undefined
    const parsed = SpawnInputSchema.safeParse(input)
    const fields = parsed.success ? parsed.data : {}
    const subagent: Subagent = {
      id: toolCallId,
      ...(fields.subagent_type ? { name: fields.subagent_type } : {}),
      ...(fields.description ? { description: fields.description } : {}),
      state: 'running',
      // Grok's own default: a call without the flag runs in the background.
      ...(fields.background !== false ? { background: true } : {}),
    }
    this.#runs.set(toolCallId, {
      subagent,
      agentId: undefined,
      item: undefined,
      sentAt: Date.now(),
      timer: undefined,
    })
    return subagent
  }

  /** Records the item just sent for a spawn call and returns its current snapshot. */
  sent(item: Item, toolCallId: string): Subagent | undefined {
    const run = this.#runs.get(toolCallId)
    if (!run) return undefined
    const { subagent: _previous, ...plain } = item
    run.item = plain
    run.sentAt = Date.now()
    this.#cancelTimer(run)
    return run.subagent
  }

  /** Reads a finished call of the main agent; call before its item is sent. */
  answered(toolCallId: string, toolName: string, frame: GrokToolFrame): void {
    const run = this.#runs.get(toolCallId)
    if (run) {
      this.#spawnAnswered(run, frame)
      return
    }
    if (toolName === OUTPUT_TOOL) this.#outputAnswered(frame.rawOutput)
  }

  /**
   * The turn is over, and the process with it: streaming-json cannot report a subagent
   * that still runs. Call before the turn's open calls complete, which carry the result.
   */
  endTurn(): void {
    for (const run of this.#runs.values()) {
      this.#cancelTimer(run)
      if (run.subagent.state !== 'running') continue
      run.subagent = { ...run.subagent, state: 'interrupted' }
      if (run.item && run.item.status !== 'started') this.#send(run)
    }
    this.#childCalls.clear()
  }

  #spawnAnswered(run: Run, frame: GrokToolFrame): void {
    if (frame.status === 'failed') {
      const reason = textContent(frame.content)
      run.subagent = {
        ...run.subagent,
        state: 'failed',
        ...(reason ? { summary: shortSummary(reason) } : {}),
      }
      return
    }
    const completed = CompletedSchema.safeParse(frame.rawOutput)
    if (completed.success) {
      const result = completed.data
      run.agentId = result.subagent_id ?? run.agentId
      run.subagent = {
        ...run.subagent,
        ...(!run.subagent.name && result.subagent_type ? { name: result.subagent_type } : {}),
        state: 'completed',
        ...(result.tool_calls !== undefined ? { toolUses: result.tool_calls } : {}),
        ...(result.duration_ms !== undefined ? { durationMs: result.duration_ms } : {}),
        ...(result.output?.trim() ? { summary: shortSummary(result.output) } : {}),
      }
      return
    }
    const started = StartedSchema.safeParse(frame.rawOutput)
    const agentId = started.success ? /^subagent_id:\s*(\S+)\s*$/m.exec(started.data.text) : null
    if (agentId) {
      run.agentId = agentId[1]
      run.subagent = { ...run.subagent, background: true }
    }
  }

  #outputAnswered(rawOutput: unknown): void {
    const parsed = TaskOutputSchema.safeParse(rawOutput)
    if (!parsed.success) return
    const results = Array.isArray(parsed.data.Result) ? parsed.data.Result : [parsed.data.Result]
    for (const result of results) {
      const run = [...this.#runs.values()].find((entry) => entry.agentId === result.task_id)
      const state = taskState(result.status)
      if (!run || !state) continue
      const report = splitReport(result.output)
      const type = /^\[subagent:([^\]]+)\]/.exec(result.command ?? '')?.[1]
      run.subagent = {
        ...run.subagent,
        ...(!run.subagent.name && type ? { name: type } : {}),
        state,
        ...(report.toolUses !== undefined ? { toolUses: report.toolUses } : {}),
        ...(result.duration_secs !== undefined
          ? { durationMs: Math.round(result.duration_secs * 1000) }
          : {}),
        ...(report.text ? { summary: shortSummary(report.text) } : {}),
      }
      this.#cancelTimer(run)
      this.#send(run)
    }
  }

  #running(): Run[] {
    const running: Run[] = []
    for (const run of this.#runs.values()) if (run.subagent.state === 'running') running.push(run)
    return running
  }

  #schedule(run: Run): void {
    if (run.timer || !run.item) return
    const wait = run.sentAt + MIN_UPDATE_MS - Date.now()
    if (wait <= 0) {
      this.#send(run)
      return
    }
    run.timer = setTimeout(() => {
      run.timer = undefined
      this.#send(run)
    }, wait)
    run.timer.unref?.()
  }

  #cancelTimer(run: Run): void {
    if (run.timer) clearTimeout(run.timer)
    run.timer = undefined
  }

  #send(run: Run): void {
    if (!run.item) return
    run.sentAt = Date.now()
    // A call still open stays started: a repeated start replaces it in place.
    this.#emit({
      type: run.item.status === 'started' ? 'item.started' : 'item.completed',
      item: { ...run.item, subagent: run.subagent },
    })
  }
}

/** `call-<uuid>-<index>`: the uuid names the model response the call came from. */
function responseOf(toolCallId: string): string | undefined {
  return /^(call-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-\d+$/i.exec(
    toolCallId,
  )?.[1]
}

function taskState(status: string | undefined): SubagentState | undefined {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'killed':
    case 'cancelled':
      return 'interrupted'
    default:
      return undefined
  }
}

/** A subagent's answer without Grok's notes, and the tool count those notes carried. */
type SubagentReport = { text: string; toolUses?: number }

/** A background result's text ends in Grok's `<subagent_meta>` and `<subagent_result>` notes. */
function splitReport(output: string | undefined): SubagentReport {
  if (!output) return { text: '' }
  const meta = /<subagent_meta>([\s\S]*?)<\/subagent_meta>/.exec(output)?.[1]
  const toolUses = meta ? /\btool_calls=(\d+)/.exec(meta)?.[1] : undefined
  const text = output
    .replace(/<subagent_meta>[\s\S]*?<\/subagent_meta>/g, '')
    .replace(/<subagent_result>[\s\S]*?<\/subagent_result>/g, '')
    .trim()
  return { text, ...(toolUses ? { toolUses: Number(toolUses) } : {}) }
}

function textContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const part of content) {
    const inner = (part as { content?: { type?: unknown; text?: unknown } } | null)?.content
    if (inner?.type === 'text' && typeof inner.text === 'string') parts.push(inner.text)
  }
  return parts.join('\n').trim() || undefined
}

function shortSummary(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= SUMMARY_LIMIT ? trimmed : `${trimmed.slice(0, SUMMARY_LIMIT - 1)}…`
}
