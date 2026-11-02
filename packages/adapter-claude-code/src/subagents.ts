import type { DomainEvent, Item, Subagent, SubagentState } from '@harness/contracts'
import { z } from 'zod'

/** Claude Code's subagent launcher; releases before 2.1 named it Task. */
const AGENT_TOOLS = new Set(['Agent', 'Task'])
/** The id suffix the adapter gives a tool_use block's item. */
const CALL_SUFFIX = '-call'
/** Progress repeats the whole item, so a chatty subagent re-renders its row at most once a second. */
const MIN_UPDATE_MS = 1_000
/** A finished agent's report can run to pages; the row needs only its start. */
const SUMMARY_LIMIT = 1_000

const AgentInputSchema = z.object({
  subagent_type: z.string().optional(),
  description: z.string().optional(),
  run_in_background: z.boolean().optional(),
})

const TaskUsageSchema = z.object({
  total_tokens: z.number().int().nonnegative(),
  tool_uses: z.number().int().nonnegative(),
  duration_ms: z.number().nonnegative(),
})

/**
 * The task messages as claude 2.1.296 sends them (fixtures/subagent-claude-2.1.296.jsonl).
 * `task_started` carries `is_backgrounded`, which the SDK type does not declare, and a
 * progress `description` names the current step ("Reading notes.txt"), not the task.
 */
const TaskMessageSchema = z.discriminatedUnion('subtype', [
  z.object({
    subtype: z.literal('task_started'),
    task_id: z.string(),
    tool_use_id: z.string().optional(),
    subagent_type: z.string().optional(),
    is_backgrounded: z.boolean().optional(),
  }),
  z.object({
    subtype: z.literal('task_progress'),
    task_id: z.string(),
    description: z.string().optional(),
    usage: TaskUsageSchema.optional(),
    last_tool_name: z.string().optional(),
    summary: z.string().optional(),
  }),
  z.object({
    subtype: z.literal('task_updated'),
    task_id: z.string(),
    patch: z.object({
      status: z.string().optional(),
      is_backgrounded: z.boolean().optional(),
    }),
  }),
  z.object({
    subtype: z.literal('task_notification'),
    task_id: z.string(),
    status: z.string(),
    summary: z.string().optional(),
    usage: TaskUsageSchema.optional(),
  }),
])
type TaskMessage = z.infer<typeof TaskMessageSchema>

type Run = {
  subagent: Subagent
  /** The newest item sent for the spawning call, without its snapshot. */
  item: Item | undefined
  /** Set once Claude started the agent as a task, whose own messages then settle it. */
  taskId: string | undefined
  /** Nothing more will change the snapshot: Claude sent its final report, or cannot any more. */
  reported: boolean
  sentAt: number
  timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * Follows the subagents a Claude turn starts. Their own conversation stays out of the
 * transcript; Claude's task messages become a snapshot on the spawning Agent call, keyed by
 * its tool_use id, which every send of that item carries (the store replaces items whole).
 */
export class ClaudeSubagents {
  readonly #emit: (event: DomainEvent) => void
  readonly #runs = new Map<string, Run>()
  /** task_id -> tool_use id, for task messages that name only the task. */
  readonly #tasks = new Map<string, string>()

  constructor(emit: (event: DomainEvent) => void) {
    this.#emit = emit
  }

  /** Records a tool_use block when it starts a subagent; later calls fill in the input. */
  spawn(toolUseId: string, tool: string, input: Record<string, unknown>): void {
    if (!AGENT_TOOLS.has(tool)) return
    const run = this.#runs.get(toolUseId) ?? {
      subagent: { id: toolUseId, state: 'running' as const },
      item: undefined,
      taskId: undefined,
      reported: false,
      sentAt: 0,
      timer: undefined,
    }
    const parsed = AgentInputSchema.safeParse(input)
    const fields = parsed.success ? parsed.data : {}
    run.subagent = {
      ...run.subagent,
      ...(fields.subagent_type ? { name: fields.subagent_type } : {}),
      ...(fields.description ? { description: fields.description } : {}),
      ...(fields.run_in_background ? { background: true } : {}),
    }
    this.#runs.set(toolUseId, run)
  }

  /** The item with its subagent's current snapshot, remembered for later updates. */
  withSnapshot(item: Item): Item {
    if (this.#runs.size === 0 || item.type !== 'tool_call' || !item.id.endsWith(CALL_SUFFIX))
      return item
    const toolUseId = item.id.slice(0, -CALL_SUFFIX.length)
    const run = this.#runs.get(toolUseId)
    if (!run) return item
    const { subagent: _previous, ...plain } = item
    run.item = plain
    // A call that ended before Claude started a task for it has no task messages to follow.
    if (item.status !== 'started' && run.taskId === undefined && run.subagent.state === 'running') {
      if (item.status === 'failed') this.#settle(run, 'failed')
      else if (!run.subagent.background) this.#settle(run, 'completed')
    }
    // This send carries the newest snapshot, so a pending progress update has nothing to add.
    this.#cancelTimer(run)
    run.sentAt = Date.now()
    const snapshot = { ...plain, subagent: run.subagent }
    if (this.#finished(run)) this.#forget(toolUseId, run)
    return snapshot
  }

  /** Consumes a task_* system message; false for any other message. */
  onTaskMessage(message: unknown): boolean {
    const parsed = TaskMessageSchema.safeParse(message)
    if (!parsed.success) return false
    const task = parsed.data
    const toolUseId =
      task.subtype === 'task_started' ? task.tool_use_id : this.#tasks.get(task.task_id)
    const run = toolUseId ? this.#runs.get(toolUseId) : undefined
    // Background shell commands and workflows are tasks too, but not subagents.
    if (toolUseId && run) this.#apply(toolUseId, run, task)
    return true
  }

  /** The turn ended: an agent it waited on cannot report any more. */
  endTurn(state: SubagentState): void {
    for (const [toolUseId, run] of this.#runs) {
      if (run.subagent.background || run.subagent.state !== 'running') continue
      this.#settle(run, state)
      this.#flush(run)
      if (this.#finished(run)) this.#forget(toolUseId, run)
    }
  }

  /** The Claude process is gone, and every agent it ran, background ones included, with it. */
  endSession(): void {
    for (const run of this.#runs.values()) {
      if (run.subagent.state === 'running') {
        this.#settle(run, 'interrupted')
        this.#flush(run)
      } else {
        this.#cancelTimer(run)
      }
    }
    this.#runs.clear()
    this.#tasks.clear()
  }

  #apply(toolUseId: string, run: Run, task: TaskMessage): void {
    const before = run.subagent
    switch (task.subtype) {
      case 'task_started':
        run.taskId = task.task_id
        this.#tasks.set(task.task_id, toolUseId)
        run.subagent = {
          ...run.subagent,
          ...(!run.subagent.name && task.subagent_type ? { name: task.subagent_type } : {}),
          ...(task.is_backgrounded ? { background: true } : {}),
        }
        break
      case 'task_progress': {
        const summary = task.summary ?? task.description
        run.subagent = {
          ...run.subagent,
          ...usageFields(task.usage),
          ...(task.last_tool_name ? { lastTool: task.last_tool_name } : {}),
          ...(summary ? { summary: shortSummary(summary) } : {}),
        }
        break
      }
      case 'task_updated': {
        const state = updatedState(task.patch.status)
        run.subagent = {
          ...run.subagent,
          ...(state ? { state } : {}),
          ...(task.patch.is_backgrounded ? { background: true } : {}),
        }
        break
      }
      case 'task_notification':
        run.reported = true
        run.subagent = {
          ...run.subagent,
          state: notifiedState(task.status),
          ...usageFields(task.usage),
          ...(task.summary ? { summary: shortSummary(task.summary) } : {}),
        }
        break
    }
    if (!sameSubagent(before, run.subagent)) {
      // The final report is worth a render at once; everything else waits for the throttle.
      if (run.reported) this.#flush(run)
      else this.#schedule(run)
    }
    if (this.#finished(run)) this.#forget(toolUseId, run)
  }

  #settle(run: Run, state: SubagentState): void {
    run.subagent = { ...run.subagent, state }
    run.reported = true
  }

  #finished(run: Run): boolean {
    return run.reported && run.item !== undefined && run.item.status !== 'started'
  }

  #forget(toolUseId: string, run: Run): void {
    this.#cancelTimer(run)
    this.#runs.delete(toolUseId)
    if (run.taskId) this.#tasks.delete(run.taskId)
  }

  #schedule(run: Run): void {
    if (run.timer) return
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

  #flush(run: Run): void {
    this.#cancelTimer(run)
    this.#send(run)
  }

  #cancelTimer(run: Run): void {
    if (run.timer) clearTimeout(run.timer)
    run.timer = undefined
  }

  #send(run: Run): void {
    // Before its call is on screen, the snapshot rides along with the call's first item.
    if (!run.item) return
    run.sentAt = Date.now()
    this.#emit({ type: 'item.completed', item: { ...run.item, subagent: run.subagent } })
  }
}

function usageFields(usage: z.infer<typeof TaskUsageSchema> | undefined) {
  if (!usage) return {}
  return { tokens: usage.total_tokens, toolUses: usage.tool_uses, durationMs: usage.duration_ms }
}

function updatedState(status: string | undefined): SubagentState | undefined {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'interrupted'
    case 'pending':
    case 'running':
    case 'paused':
      return 'running'
    default:
      return undefined
  }
}

function notifiedState(status: string): SubagentState {
  if (status === 'failed') return 'failed'
  if (status === 'stopped' || status === 'killed') return 'interrupted'
  return 'completed'
}

function sameSubagent(a: Subagent, b: Subagent): boolean {
  if (a === b) return true
  const keys = Object.keys(a) as Array<keyof Subagent>
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => a[key] === b[key])
}

function shortSummary(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= SUMMARY_LIMIT ? trimmed : `${trimmed.slice(0, SUMMARY_LIMIT - 1)}…`
}
