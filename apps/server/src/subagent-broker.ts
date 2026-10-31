import { randomUUID } from 'node:crypto'
import type {
  ApprovalDecision,
  ApprovalMode,
  DomainEvent,
  Item,
  ProviderId,
  Subagent,
  SubagentState,
  ThreadSubagent,
} from '@harness/contracts'
import {
  AgentToolError,
  type AgentToolsBroker,
  type AgentToolsCaller,
  type StartAgentArgs,
  type StopAgentArgs,
  type WaitForAgentsArgs,
} from './agent-tools-mcp.js'
import { SUBAGENT_LIMITS } from './subagent-limits.js'
import {
  FINISHED_SUBAGENT_STATES,
  shorten,
  subagentRunItem,
  type StoredSubagentRun,
  type SubagentRunState,
  type SubagentRunTable,
} from './subagent-runs.js'

export { shorten }

/** A provider a sub-agent can run on, and the models its list offers. */
export type AgentModelChoice = {
  provider: ProviderId
  models: Array<{ id: string; name: string; default?: true; efforts?: string[] }>
}

/** The calling chat, as a parent that may start sub-agents now. */
export type SubagentParent = {
  provider: ProviderId
  /** The turn that calls the tools; sub-agents count against it. */
  turnId: string
  approval: ApprovalMode
}

export type SubagentChildSpec = {
  parentThreadId: string
  provider: ProviderId
  model?: string | undefined
  effort?: string | undefined
  name?: string | undefined
  task: string
}

/** What a finished child turn left: its last answer and the files it changed. */
export type SubagentOutcome = { answer?: string | undefined; changedPaths: string[] }

/** What the broker needs of the orchestrator. Nothing here names a provider. */
export interface SubagentHost {
  /** Throws an `AgentToolError` when the chat cannot start sub-agents now. */
  parent(threadId: string): SubagentParent
  /** Providers and models from lists already read; never starts a vendor process. */
  choices(): AgentModelChoice[]
  /** Starts the hidden child chat and returns its id. */
  createChild(spec: SubagentChildSpec): Promise<string>
  /** Sends the child its task as its first prompt. */
  sendToChild(
    threadId: string,
    task: string,
    options: { model?: string | undefined; effort?: string | undefined },
  ): Promise<void>
  /** Stops the child's running turn; its chat stays readable. */
  stopChild(threadId: string): Promise<void>
  /** The child's answer and changed files once a turn ended, from its recorded transcript. */
  outcome(threadId: string, turnId: string): SubagentOutcome
  /** Records an event on the parent's transcript and sends it to clients. */
  recordOnParent(parentThreadId: string, event: DomainEvent): void
  /** Stops the parent's running turn, as "Stop the turn" on its approval asks. */
  interruptParent(parentThreadId: string): Promise<void>
}

/** What a sub-agent's chat is told before its task. */
export const SUBAGENT_INSTRUCTIONS = [
  'You are a sub-agent: another agent started you in TasteCode for one task, in the same checkout it works in.',
  'Your final message is returned to the agent that started you, so make it a complete report: what you did, what you found, the files you changed, and anything left open.',
  'Do not start other agents. Work only on the files your task names or needs; another agent may be editing the rest.',
].join('\n')

/** Updates of a running sub-agent's row; a state change goes out at once. */
const UPDATE_INTERVAL_MS = 1_000
/** The row's summary of a result; the whole result is in the sub-agent's own chat. */
const SUMMARY_CHARACTERS = 4_000
/** The task as the user's approval quotes it. */
const APPROVAL_TASK_CHARACTERS = 1_000
const START_APPROVAL_PREFIX = 'subagent-start-'
const TOOL_ITEM_TYPES = new Set<Item['type']>(['tool_call', 'command', 'file_change'])

/** What a wait reports per sub-agent, as the calling agent reads it. */
export type AgentReport = {
  agent_id: string
  status:
    | 'waiting_for_approval'
    | 'running'
    | 'needs_user'
    | 'completed'
    | 'failed'
    | 'stopped'
    | 'declined'
  provider: ProviderId
  model?: string
  name?: string
  result?: string
  error?: string
  changed_paths?: string[]
  duration_seconds?: number
  tokens?: number
}

type LiveRun = {
  run: StoredSubagentRun
  tools: number
  tokens: number
  lastTool?: string | undefined
  /** Why it failed, for the row and the waiting agent. */
  error?: string | undefined
  changedPaths: string[]
  approvals: Set<string>
  inputs: Set<string>
  /** The parent's turn ended while it ran. */
  background: boolean
  sentAt: number
  timer?: ReturnType<typeof setTimeout> | undefined
  /** Stop was asked before the child chat existed. */
  stopRequested: boolean
  /** The start the user is asked about; set while the run waits for that answer. */
  pendingStart?: { approvalId: string; spec: SubagentChildSpec } | undefined
}

export class SubagentBroker implements AgentToolsBroker {
  #runs: SubagentRunTable
  #host: SubagentHost
  #now: () => number
  /** Runs this process started and has not let go of, by parent item id. */
  #live = new Map<string, LiveRun>()
  #byChild = new Map<string, LiveRun>()
  /** Waits to wake when one of a parent's runs changes state. */
  #waiters = new Map<string, Set<() => void>>()
  /** Starts waiting for the user's answer, by the approval id the parent shows. */
  #startApprovals = new Map<string, LiveRun>()
  /** Chats whose user allowed sub-agents for the rest of this session. */
  #allowed = new Set<string>()
  #disposed = false

  constructor(runs: SubagentRunTable, host: SubagentHost, options: { now?: () => number } = {}) {
    this.#runs = runs
    this.#host = host
    this.#now = options.now ?? (() => Date.now())
  }

  /** The hidden chats sub-agents run in, for routing their events. */
  isChild(threadId: string): boolean {
    return this.#byChild.has(threadId)
  }

  async listModels(caller: AgentToolsCaller): Promise<unknown> {
    this.#host.parent(caller.threadId)
    const providers = this.#host.choices()
    return {
      providers,
      ...(providers.length === 0
        ? {
            note: 'No provider has listed its models in TasteCode yet. Open the model picker once, then try again.',
          }
        : {}),
    }
  }

  async start(caller: AgentToolsCaller, args: StartAgentArgs): Promise<unknown> {
    if (this.#disposed) throw new AgentToolError('TasteCode is shutting down.')
    const parent = this.#host.parent(caller.threadId)
    const choice = this.#host.choices().find((entry) => entry.provider === args.provider)
    if (!choice) {
      const known = this.#host
        .choices()
        .map((entry) => entry.provider)
        .join(', ')
      throw new AgentToolError(
        `"${args.provider}" is not available for sub-agents. Available: ${known || 'none'}. Call list_agent_models.`,
      )
    }
    if (args.model !== undefined && !choice.models.some((model) => model.id === args.model)) {
      throw new AgentToolError(
        `"${args.model}" is not a model of ${args.provider}. Call list_agent_models for its models.`,
      )
    }
    this.#checkLimits(caller.threadId, parent.turnId)
    // A chat that asks before it acts asks before a sub-agent starts, once per start
    // unless its user allowed them for the session.
    const ask = parent.approval === 'ask' && !this.#allowed.has(caller.threadId)
    const runs = this.#runs.ofParent(caller.threadId)
    const at = this.#now()
    const run: StoredSubagentRun = {
      itemId: `subagent-${randomUUID()}`,
      parentThreadId: caller.threadId,
      shortId: `a${runs.length + 1}`,
      turnId: parent.turnId,
      provider: choice.provider,
      ...(args.model ? { model: args.model } : {}),
      ...(args.name ? { name: args.name } : {}),
      task: args.task,
      state: ask ? 'waiting_for_approval' : 'running',
      snapshot: { id: '', state: 'running' },
      createdAt: at,
    }
    const spec: SubagentChildSpec = {
      parentThreadId: caller.threadId,
      provider: choice.provider,
      model: args.model,
      effort: args.effort,
      name: args.name,
      task: args.task,
    }
    const live = this.#track(run)
    if (ask) live.pendingStart = { approvalId: `${START_APPROVAL_PREFIX}${randomUUID()}`, spec }
    run.snapshot = this.#snapshot(live)
    this.#runs.add(run)
    this.#send(live)
    if (live.pendingStart) this.#ask(live, live.pendingStart.approvalId)
    else void this.#launch(live, spec)
    return {
      agent_id: run.shortId,
      status: run.state,
      provider: run.provider,
      ...(run.model ? { model: run.model } : {}),
      ...(ask
        ? { note: 'The user is asked before it starts. Call wait_for_agents to hear the answer.' }
        : {}),
    }
  }

  /**
   * The user's answer to a sub-agent start. Returns false for an approval that
   * is not one, so the orchestrator hands it to the chat's agent instead.
   */
  answer(parentThreadId: string, approvalId: string, decision: ApprovalDecision): boolean {
    const live = this.#startApprovals.get(approvalId)
    // A late answer to a start that already ended stays here; no agent knows its id.
    if (!live) return approvalId.startsWith(START_APPROVAL_PREFIX)
    if (live.run.parentThreadId !== parentThreadId) return false
    const spec = this.#settleAsk(live)
    if (!spec) return true
    if (decision === 'approve' || decision === 'approve-session') {
      if (decision === 'approve-session') this.#allowed.add(parentThreadId)
      live.run.state = 'running'
      this.#runs.update(live.run.itemId, { state: 'running' })
      this.#changed(live)
      void this.#launch(live, spec)
      return true
    }
    live.error = 'The user declined to start it.'
    this.#finish(live, 'declined')
    if (decision === 'abort') {
      void this.#host.interruptParent(parentThreadId).catch(() => undefined)
    }
    return true
  }

  async wait(caller: AgentToolsCaller, args: WaitForAgentsArgs, signal: AbortSignal) {
    this.#host.parent(caller.threadId)
    const select = () => this.#select(caller.threadId, args.agent_ids)
    if (select().length === 0) {
      return { agents: [], note: 'This chat has not started any sub-agents.' }
    }
    const settled = (run: StoredSubagentRun) =>
      FINISHED_SUBAGENT_STATES.has(run.state) || this.#needsUser(run)
    const ready = () => {
      const runs = select()
      return args.return_when === 'any' ? runs.some(settled) : runs.every(settled)
    }
    if (!ready()) {
      await new Promise<void>((resolve) => {
        const waiters = this.#waiters.get(caller.threadId) ?? new Set<() => void>()
        this.#waiters.set(caller.threadId, waiters)
        const done = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', done)
          waiters.delete(check)
          if (waiters.size === 0 && this.#waiters.get(caller.threadId) === waiters)
            this.#waiters.delete(caller.threadId)
          resolve()
        }
        const check = () => {
          if (ready() || this.#disposed) done()
        }
        const timer = setTimeout(done, args.timeout_seconds * 1_000)
        signal.addEventListener('abort', done, { once: true })
        waiters.add(check)
      })
    }
    const runs = select()
    const at = this.#now()
    const agents = runs.map((run) => this.#report(run))
    for (const run of runs) {
      if (FINISHED_SUBAGENT_STATES.has(run.state) && run.deliveredAt === undefined) {
        // The agent has read the result; it need not hear it again later.
        run.deliveredAt = at
        this.#runs.update(run.itemId, { deliveredAt: at })
      }
    }
    const pending = agents.some(
      (agent) => agent.status === 'running' || agent.status === 'waiting_for_approval',
    )
    return {
      agents,
      ...(pending
        ? { note: 'Some sub-agents are still running. Call wait_for_agents again.' }
        : {}),
    }
  }

  async stop(caller: AgentToolsCaller, args: StopAgentArgs): Promise<unknown> {
    this.#host.parent(caller.threadId)
    const run = this.#select(caller.threadId, [args.agent_id])[0]!
    const live = this.#live.get(run.itemId)
    if (!live || FINISHED_SUBAGENT_STATES.has(run.state)) return this.#report(run)
    await this.#stop(live)
    return this.#report(live.run)
  }

  /** A child chat's event; the orchestrator passes no `item.delta`. */
  childEvent(threadId: string, event: DomainEvent): void {
    const live = this.#byChild.get(threadId)
    if (!live || FINISHED_SUBAGENT_STATES.has(live.run.state)) return
    switch (event.type) {
      case 'item.started':
        if (TOOL_ITEM_TYPES.has(event.item.type)) {
          live.lastTool = toolLabel(event.item)
          this.#schedule(live)
        }
        return
      case 'item.completed':
        if (TOOL_ITEM_TYPES.has(event.item.type)) {
          live.tools += 1
          live.lastTool = toolLabel(event.item)
          this.#schedule(live)
        }
        return
      case 'usage.updated':
        live.tokens = event.usage.cumulative
          ? event.usage.totalTokens
          : live.tokens + event.usage.totalTokens
        this.#schedule(live)
        return
      case 'approval.requested':
        live.approvals.add(event.request.id)
        this.#changed(live)
        return
      case 'approval.resolved':
        if (live.approvals.delete(event.id)) this.#changed(live)
        return
      case 'user_input.requested':
        live.inputs.add(event.request.id)
        this.#changed(live)
        return
      case 'user_input.resolved':
        if (live.inputs.delete(event.id)) this.#changed(live)
        return
      case 'turn.completed': {
        const outcome = this.#host.outcome(threadId, event.turnId)
        live.changedPaths = outcome.changedPaths
        this.#finish(
          live,
          event.status === 'completed'
            ? 'completed'
            : event.status === 'interrupted'
              ? 'stopped'
              : 'failed',
          outcome.answer,
        )
        return
      }
      case 'thread.error':
        live.error = event.message
        this.#finish(live, 'failed')
        return
      default:
        return
    }
  }

  /** The parent's turn ended: what still runs carries on in the background. */
  parentTurnEnded(parentThreadId: string): void {
    for (const live of this.#live.values()) {
      if (live.run.parentThreadId !== parentThreadId) continue
      if (FINISHED_SUBAGENT_STATES.has(live.run.state)) continue
      if (live.pendingStart) {
        // An unanswered start ends with its turn, as the turn's own approvals do.
        live.error = 'The turn ended before the user answered.'
        this.#finish(live, 'declined')
        continue
      }
      if (live.background) continue
      live.background = true
      this.#flush(live)
    }
  }

  /** Stops a chat's unfinished sub-agents, as stopping the chat does. */
  async stopFor(parentThreadId: string): Promise<void> {
    const stopping = [...this.#live.values()].filter(
      (live) =>
        live.run.parentThreadId === parentThreadId && !FINISHED_SUBAGENT_STATES.has(live.run.state),
    )
    await Promise.all(stopping.map((live) => this.#stop(live)))
  }

  /**
   * Settles unfinished runs as stopped without stopping their chats: the caller
   * ends those itself, as closing the parent and Stop all do. Without an id,
   * every chat's runs.
   */
  release(parentThreadId?: string): void {
    for (const live of this.#live.values()) {
      if (parentThreadId !== undefined && live.run.parentThreadId !== parentThreadId) continue
      if (FINISHED_SUBAGENT_STATES.has(live.run.state)) continue
      live.stopRequested = true
      this.#finish(live, 'stopped')
    }
  }

  /** Lets go of a deleted chat's runs. */
  forget(parentThreadId: string): void {
    for (const [itemId, live] of this.#live) {
      if (live.run.parentThreadId !== parentThreadId) continue
      clearTimeout(live.timer)
      this.#live.delete(itemId)
      if (live.run.threadId) this.#byChild.delete(live.run.threadId)
    }
    this.#allowed.delete(parentThreadId)
  }

  /** The sub-agents TasteCode started for a chat, newest first, as `thread.subagents` lists them. */
  list(parentThreadId: string): ThreadSubagent[] {
    return this.#runs.ofParent(parentThreadId).map((run) => {
      const live = this.#live.get(run.itemId)
      return {
        itemId: run.itemId,
        createdAt: run.createdAt,
        subagent: live ? this.#snapshot(live) : run.snapshot,
      }
    })
  }

  dispose(): void {
    this.#disposed = true
    for (const live of this.#live.values()) clearTimeout(live.timer)
    for (const waiters of this.#waiters.values()) for (const wake of waiters) wake()
  }

  #checkLimits(parentThreadId: string, turnId: string): void {
    let runningInChat = 0
    let runningInApp = 0
    for (const live of this.#live.values()) {
      if (FINISHED_SUBAGENT_STATES.has(live.run.state)) continue
      runningInApp += 1
      if (live.run.parentThreadId === parentThreadId) runningInChat += 1
    }
    if (runningInChat >= SUBAGENT_LIMITS.runningPerChat) {
      throw new AgentToolError(
        `At most ${SUBAGENT_LIMITS.runningPerChat} sub-agents of one chat run at once. Wait for one to finish.`,
      )
    }
    if (runningInApp >= SUBAGENT_LIMITS.runningInApp) {
      throw new AgentToolError(
        `TasteCode runs at most ${SUBAGENT_LIMITS.runningInApp} sub-agents at once. Wait for one to finish.`,
      )
    }
    const startedThisTurn = this.#runs
      .ofParent(parentThreadId)
      .filter((run) => run.turnId === turnId).length
    if (startedThisTurn >= SUBAGENT_LIMITS.startedPerTurn) {
      throw new AgentToolError(
        `One turn starts at most ${SUBAGENT_LIMITS.startedPerTurn} sub-agents. Finish with the ones you have.`,
      )
    }
  }

  #track(run: StoredSubagentRun): LiveRun {
    const live: LiveRun = {
      run,
      tools: 0,
      tokens: 0,
      changedPaths: [],
      approvals: new Set(),
      inputs: new Set(),
      background: false,
      sentAt: 0,
      stopRequested: false,
    }
    this.#live.set(run.itemId, live)
    return live
  }

  async #launch(live: LiveRun, spec: SubagentChildSpec): Promise<void> {
    let threadId: string
    try {
      threadId = await this.#host.createChild(spec)
    } catch (error) {
      live.error = errorText(error)
      this.#finish(live, 'failed')
      return
    }
    live.run.threadId = threadId
    this.#runs.update(live.run.itemId, { threadId })
    // Stopped while its chat was starting: the chat stays, without a task.
    if (live.stopRequested || FINISHED_SUBAGENT_STATES.has(live.run.state)) return
    this.#byChild.set(threadId, live)
    this.#flush(live)
    try {
      await this.#host.sendToChild(threadId, spec.task, {
        model: spec.model,
        effort: spec.effort,
      })
    } catch (error) {
      live.error = errorText(error)
      this.#finish(live, 'failed')
    }
  }

  async #stop(live: LiveRun): Promise<void> {
    live.stopRequested = true
    const threadId = live.run.threadId
    this.#finish(live, 'stopped')
    if (threadId) await this.#host.stopChild(threadId).catch(() => undefined)
  }

  /** Puts the start question on the parent's transcript. */
  #ask(live: LiveRun, approvalId: string): void {
    this.#startApprovals.set(approvalId, live)
    const { run } = live
    const target = `${run.provider}${run.model ? ` (${run.model})` : ''}`
    this.#host.recordOnParent(run.parentThreadId, {
      type: 'approval.requested',
      request: {
        id: approvalId,
        kind: 'permissions',
        reason: `Start a subagent on ${target}${run.name ? `, "${run.name}"` : ''}: ${shorten(run.task, APPROVAL_TASK_CHARACTERS)}`,
        createdAt: this.#now(),
      },
    })
  }

  /** Takes a run's start question off the parent; returns the start it asked about. */
  #settleAsk(live: LiveRun): SubagentChildSpec | undefined {
    const pending = live.pendingStart
    if (!pending) return undefined
    live.pendingStart = undefined
    this.#startApprovals.delete(pending.approvalId)
    this.#host.recordOnParent(live.run.parentThreadId, {
      type: 'approval.resolved',
      id: pending.approvalId,
    })
    return pending.spec
  }

  #finish(live: LiveRun, state: SubagentRunState, answer?: string): void {
    if (FINISHED_SUBAGENT_STATES.has(live.run.state)) return
    this.#settleAsk(live)
    const at = this.#now()
    live.run.state = state
    live.run.finishedAt = at
    live.approvals.clear()
    live.inputs.clear()
    const result = answer?.trim() ? shorten(answer.trim(), SUBAGENT_LIMITS.resultCharacters) : ''
    if (result) live.run.result = result
    this.#runs.update(live.run.itemId, {
      state,
      finishedAt: at,
      ...(result ? { result } : {}),
    })
    this.#flush(live)
    this.#wake(live.run.parentThreadId)
  }

  /** An approval or a question came or went: the row and any wait hear at once. */
  #changed(live: LiveRun): void {
    this.#flush(live)
    this.#wake(live.run.parentThreadId)
  }

  #wake(parentThreadId: string): void {
    // A check that ends its wait removes itself; a Set iterates safely past that.
    for (const check of this.#waiters.get(parentThreadId) ?? []) check()
  }

  #schedule(live: LiveRun): void {
    if (live.timer) return
    const wait = live.sentAt + UPDATE_INTERVAL_MS - this.#now()
    if (wait <= 0) {
      this.#send(live)
      return
    }
    live.timer = setTimeout(() => {
      live.timer = undefined
      this.#send(live)
    }, wait)
    live.timer.unref?.()
  }

  #flush(live: LiveRun): void {
    clearTimeout(live.timer)
    live.timer = undefined
    this.#send(live)
  }

  #send(live: LiveRun): void {
    if (this.#disposed) return
    live.sentAt = this.#now()
    const snapshot = this.#snapshot(live)
    live.run.snapshot = snapshot
    this.#runs.update(live.run.itemId, { snapshot })
    this.#host.recordOnParent(live.run.parentThreadId, {
      type: 'item.completed',
      item: subagentRunItem(live.run),
    })
    // A finished run's chat may still report; nothing it says changes the run.
    if (FINISHED_SUBAGENT_STATES.has(live.run.state) && live.run.threadId)
      this.#byChild.delete(live.run.threadId)
  }

  #snapshot(live: LiveRun): Subagent {
    const { run } = live
    const finished = FINISHED_SUBAGENT_STATES.has(run.state)
    const attention =
      live.pendingStart || live.approvals.size > 0
        ? 'approval'
        : live.inputs.size > 0
          ? 'input'
          : undefined
    const summary = run.result ?? live.error
    return {
      id: run.shortId,
      ...(run.name ? { name: run.name } : {}),
      description: oneLine(run.task, 200),
      state: subagentState(run.state),
      ...(live.background ? { background: true } : {}),
      ...(live.tools > 0 ? { toolUses: live.tools } : {}),
      ...(live.tokens > 0 ? { tokens: live.tokens } : {}),
      ...(finished && run.finishedAt !== undefined
        ? { durationMs: Math.max(0, run.finishedAt - run.createdAt) }
        : {}),
      ...(!finished && live.lastTool ? { lastTool: live.lastTool } : {}),
      ...(finished && summary ? { summary: shorten(summary, SUMMARY_CHARACTERS) } : {}),
      ...(run.threadId ? { threadId: run.threadId } : {}),
      provider: run.provider,
      ...(run.agent ? { agent: run.agent } : {}),
      ...(run.model ? { model: run.model } : {}),
      ...(!finished && attention ? { attention } : {}),
    }
  }

  #select(parentThreadId: string, agentIds: readonly string[] | undefined): StoredSubagentRun[] {
    const runs = this.#runs
      .ofParent(parentThreadId)
      .map((run) => this.#live.get(run.itemId)?.run ?? run)
    if (agentIds === undefined) {
      // Without ids, the ones the agent may still want: unfinished, or not read yet.
      return runs.filter(
        (run) => !FINISHED_SUBAGENT_STATES.has(run.state) || run.deliveredAt === undefined,
      )
    }
    const byId = new Map(runs.map((run) => [run.shortId, run]))
    const unknown = agentIds.filter((id) => !byId.has(id))
    if (unknown.length > 0) {
      throw new AgentToolError(`Unknown agent_id: ${unknown.join(', ')}.`)
    }
    return agentIds.map((id) => byId.get(id)!)
  }

  #needsUser(run: StoredSubagentRun): boolean {
    const live = this.#live.get(run.itemId)
    return live !== undefined && (live.approvals.size > 0 || live.inputs.size > 0)
  }

  #report(run: StoredSubagentRun): AgentReport {
    const live = this.#live.get(run.itemId)
    const finished = FINISHED_SUBAGENT_STATES.has(run.state)
    const status: AgentReport['status'] =
      run.state === 'interrupted'
        ? 'stopped'
        : run.state === 'running' && this.#needsUser(run)
          ? 'needs_user'
          : run.state
    const error = live?.error ?? (run.state === 'failed' ? run.snapshot.summary : undefined)
    const tokens = live?.tokens ?? run.snapshot.tokens
    return {
      agent_id: run.shortId,
      status,
      provider: run.provider,
      ...(run.model ? { model: run.model } : {}),
      ...(run.name ? { name: run.name } : {}),
      ...(finished && run.result ? { result: run.result } : {}),
      ...(finished && !run.result && error ? { error } : {}),
      ...(finished && live && live.changedPaths.length > 0
        ? { changed_paths: live.changedPaths }
        : {}),
      ...(finished && run.finishedAt !== undefined
        ? { duration_seconds: Math.round((run.finishedAt - run.createdAt) / 1_000) }
        : {}),
      ...(tokens ? { tokens } : {}),
    }
  }
}

/** The contract's snapshot states are fewer; the run keeps the exact one. */
function subagentState(state: SubagentRunState): SubagentState {
  switch (state) {
    case 'waiting_for_approval':
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    // Declined never ran: the row says "Stopped" with the reason, not a red failure.
    case 'declined':
    case 'stopped':
    case 'interrupted':
      return 'interrupted'
  }
}

function toolLabel(item: Item): string {
  if (item.type === 'command') return 'Shell'
  if (item.type === 'file_change') return 'Edit'
  const name = (item.text ?? '').split('\n', 1)[0]!.trim()
  return oneLine(name || 'Tool', 80)
}

function oneLine(text: string, limit: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() || 'The sub-agent could not start.'
}
