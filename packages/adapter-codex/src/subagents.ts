import type { DomainEvent, Item, Subagent, SubagentState } from '@harness/contracts'
import type { JsonRpcValue } from '@harness/proc'
import { z } from 'zod'
import type { CodexThreadItem } from './map-item.js'

/** Progress repeats the whole item, so a busy subagent re-renders its row at most once a second. */
const MIN_UPDATE_MS = 1_000
/** A subagent's final answer can run to pages; the row needs only its start. */
const SUMMARY_LIMIT = 1_000

/** The tool behind a subagent's item, named as Codex names it to the model. */
const TOOL_NAMES = new Map([
  ['commandExecution', 'shell'],
  ['fileChange', 'apply_patch'],
  ['webSearch', 'web_search'],
  ['imageView', 'view_image'],
  ['imageGeneration', 'image_generation'],
])
const COLLAB_TOOL_NAMES = new Map([
  ['spawnAgent', 'spawn_agent'],
  ['sendInput', 'send_input'],
  ['resumeAgent', 'resume_agent'],
  ['wait', 'wait'],
  ['closeAgent', 'close_agent'],
])

// A subagent's frames are read only for the counters; nothing else of them is kept.
const ChildItemSchema = z.object({
  type: z.string(),
  tool: z.string().optional(),
  server: z.string().optional(),
  text: z.string().optional(),
  phase: z.string().nullish(),
})
const ChildItemNotificationSchema = z.object({ item: ChildItemSchema })
const ChildUsageSchema = z.object({
  tokenUsage: z.object({ total: z.object({ totalTokens: z.number().int().nonnegative() }) }),
})
const ChildTurnSchema = z.object({
  turn: z.object({
    status: z.string(),
    durationMs: z.number().nonnegative().nullish(),
    items: z.array(z.unknown()).optional(),
  }),
})

type Run = {
  subagent: Subagent
  /** The spawning item, as last sent without its snapshot. */
  item: Item | undefined
  /** Time the subagent's finished turns took; a subagent given more input runs again. */
  finishedMs: number
  sentAt: number
  timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * Follows the subagents a Codex chat spawns. Each runs in a thread of its own on the same
 * app-server connection; its frames never reach the chat, and become the snapshot on the
 * item that spawned it, keyed by the subagent's thread id, which every send of that item
 * carries (the store replaces items whole).
 */
export class CodexSubagents {
  readonly #emit: (event: DomainEvent) => void
  readonly #runs = new Map<string, Run>()

  constructor(emit: (event: DomainEvent) => void) {
    this.#emit = emit
  }

  /**
   * A chat item on its way out: the spawning item gets its subagent's snapshot. Undefined
   * drops the item, for the notice of a finished subagent that its row already shows.
   */
  onItem(raw: CodexThreadItem, item: Item): Item | undefined {
    if (raw.type === 'subAgentActivity') {
      const threadId = raw.agentThreadId
      if (!threadId) return item
      switch (raw.kind) {
        case 'started': {
          const run = this.#run(threadId)
          const name = raw.agentPath ? pathName(raw.agentPath) : undefined
          if (name && !run.subagent.name) run.subagent = { ...run.subagent, name }
          return this.#attach(run, item)
        }
        case 'completed':
          this.#settle(threadId, 'completed')
          return undefined
        case 'interrupted':
          this.#settle(threadId, 'interrupted')
          return item
        default:
          return item
      }
    }
    if (raw.type !== 'collabAgentToolCall') return item
    for (const [threadId, state] of Object.entries(raw.agentsStates)) {
      if (state) this.#reportState(threadId, state.status, state.message)
    }
    if (raw.tool !== 'spawnAgent') return item
    const spawned = new Set([...raw.receiverThreadIds, ...Object.keys(raw.agentsStates)])
    // One snapshot per item: a call that started several agents stays a plain row.
    if (spawned.size !== 1) return item
    const run = this.#run([...spawned][0]!)
    if (raw.prompt && !run.subagent.description) {
      run.subagent = { ...run.subagent, description: raw.prompt }
    }
    return this.#attach(run, item)
  }

  /** The thread/started of a subagent's thread names it. */
  onThreadStarted(thread: {
    id: string
    agentNickname?: string | null | undefined
    agentRole?: string | null | undefined
  }): void {
    const name = thread.agentNickname || thread.agentRole
    if (!name) return
    const run = this.#run(thread.id)
    if (run.subagent.name === name) return
    run.subagent = { ...run.subagent, name }
    this.#schedule(run)
  }

  /** A frame from a subagent's thread. */
  onThreadNotification(threadId: string, method: string, params: JsonRpcValue | undefined): void {
    switch (method) {
      case 'turn/started': {
        // Input sent to a finished subagent starts it again.
        const run = this.#run(threadId)
        if (run.subagent.state === 'running') return
        run.subagent = { ...run.subagent, state: 'running' }
        this.#flush(run)
        return
      }
      case 'item/started': {
        const parsed = ChildItemNotificationSchema.safeParse(params)
        const tool = parsed.success ? toolName(parsed.data.item) : undefined
        if (!tool) return
        const run = this.#run(threadId)
        run.subagent = {
          ...run.subagent,
          toolUses: (run.subagent.toolUses ?? 0) + 1,
          lastTool: tool,
        }
        this.#schedule(run)
        return
      }
      case 'item/completed': {
        const parsed = ChildItemNotificationSchema.safeParse(params)
        const answer = parsed.success ? finalAnswer(parsed.data.item) : undefined
        if (!answer) return
        const run = this.#run(threadId)
        run.subagent = { ...run.subagent, summary: answer }
        this.#schedule(run)
        return
      }
      case 'thread/tokenUsage/updated': {
        const parsed = ChildUsageSchema.safeParse(params)
        if (!parsed.success) return
        const run = this.#run(threadId)
        run.subagent = { ...run.subagent, tokens: parsed.data.tokenUsage.total.totalTokens }
        this.#schedule(run)
        return
      }
      case 'turn/completed': {
        const parsed = ChildTurnSchema.safeParse(params)
        if (!parsed.success) return
        const { turn } = parsed.data
        const run = this.#run(threadId)
        run.finishedMs += turn.durationMs ?? 0
        const answer = (turn.items ?? [])
          .map((entry) => {
            const item = ChildItemSchema.safeParse(entry)
            return item.success ? finalAnswer(item.data) : undefined
          })
          .findLast(Boolean)
        run.subagent = {
          ...run.subagent,
          state: turnState(turn.status, run.subagent.state),
          ...(run.finishedMs > 0 ? { durationMs: run.finishedMs } : {}),
          ...(answer ? { summary: answer } : {}),
        }
        this.#flush(run)
        return
      }
      default:
        return
    }
  }

  /** The app-server is gone, and every subagent thread it ran with it. */
  endSession(): void {
    for (const run of this.#runs.values()) {
      if (run.subagent.state === 'running') {
        run.subagent = { ...run.subagent, state: 'interrupted' }
        this.#flush(run)
      } else {
        this.#cancelTimer(run)
      }
    }
    this.#runs.clear()
  }

  #run(threadId: string): Run {
    let run = this.#runs.get(threadId)
    if (!run) {
      run = {
        subagent: { id: threadId, state: 'running' },
        item: undefined,
        finishedMs: 0,
        sentAt: 0,
        timer: undefined,
      }
      this.#runs.set(threadId, run)
    }
    return run
  }

  #attach(run: Run, item: Item): Item {
    // The first spawning item keeps the subagent; another item naming it stays plain.
    if (run.item && run.item.id !== item.id) return item
    const { subagent: _previous, ...plain } = item
    run.item = plain
    // This send carries the newest snapshot, so a pending progress update has nothing to add.
    this.#cancelTimer(run)
    run.sentAt = Date.now()
    return { ...plain, subagent: run.subagent }
  }

  #settle(threadId: string, state: SubagentState): void {
    const run = this.#runs.get(threadId)
    if (!run || run.subagent.state === state) return
    run.subagent = { ...run.subagent, state }
    this.#flush(run)
  }

  /** A collab call's view of a subagent; it only ever ends one that is still running. */
  #reportState(threadId: string, status: string, message: string | null | undefined): void {
    const run = this.#runs.get(threadId)
    const state = agentState(status)
    if (!run || run.subagent.state !== 'running' || state === 'running') return
    run.subagent = {
      ...run.subagent,
      state,
      ...(message ? { summary: shortSummary(message) } : {}),
    }
    this.#flush(run)
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
    // Before its spawning item is on screen, the snapshot rides along with that item.
    if (!run.item) return
    run.sentAt = Date.now()
    this.#emit({ type: 'item.completed', item: { ...run.item, subagent: run.subagent } })
  }
}

/** "/root/read_first_line" -> "read_first_line": the name the main agent gave it. */
function pathName(agentPath: string): string | undefined {
  return agentPath.split('/').findLast(Boolean)
}

function toolName(item: z.infer<typeof ChildItemSchema>): string | undefined {
  switch (item.type) {
    case 'mcpToolCall':
      return item.server && item.tool ? `${item.server}.${item.tool}` : item.tool
    case 'dynamicToolCall':
      return item.tool || undefined
    case 'collabAgentToolCall':
      return item.tool ? (COLLAB_TOOL_NAMES.get(item.tool) ?? item.tool) : undefined
    default:
      return TOOL_NAMES.get(item.type)
  }
}

function finalAnswer(item: z.infer<typeof ChildItemSchema>): string | undefined {
  if (item.type !== 'agentMessage' || item.phase !== 'final_answer' || !item.text?.trim()) {
    return undefined
  }
  return shortSummary(item.text)
}

function turnState(status: string, current: SubagentState): SubagentState {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'interrupted':
      return 'interrupted'
    default:
      return current
  }
}

function agentState(status: string): SubagentState {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'errored':
    case 'notFound':
      return 'failed'
    case 'interrupted':
    case 'shutdown':
      return 'interrupted'
    default:
      return 'running'
  }
}

function shortSummary(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= SUMMARY_LIMIT ? trimmed : `${trimmed.slice(0, SUMMARY_LIMIT - 1)}…`
}
