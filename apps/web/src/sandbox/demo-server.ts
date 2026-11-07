import {
  PROTOCOL_VERSION,
  type ApprovalMode,
  type BackgroundModelPreference,
  type ChannelName,
  type DataOf,
  type DomainEvent,
  type Item,
  type MethodName,
  type ParamsOf,
  type ProviderContextSettingsMap,
  type ProviderId,
  type QueuedTurn,
  type ResultOf,
  type SessionSearchResult,
  type SidebarSettings,
  type SubagentSettings,
  type ThreadLifecycle,
  type ThreadSettings,
  type UsageHistoryRange,
  type UsageHistoryResult,
  type UsageHistoryTotals,
} from '@harness/contracts'
import {
  DEMO_PROJECTS,
  DEMO_ACCOUNTS_MAX,
  DEMO_PROVIDERS,
  demoAccountLimits,
  demoAccounts,
  demoHome,
  demoJoin,
  demoProvider,
  demoReply,
  detectDemoPlatform,
  type DemoFile,
  type DemoItem,
  type DemoPlatform,
  type DemoTurn,
} from './demo-data.js'

/**
 * An in-memory stand-in for the local server, for the design sandbox. It
 * answers the protocol's requests from seeded data and plays live turns as
 * the real server would push them, so the real App renders against it.
 */

export type DemoPush = <C extends ChannelName>(channel: C, data: DataOf<C>) => void

export type DemoTiming = {
  /** The pause before each step of a live turn. */
  stepMs: number
  /** Between two streamed words of an answer. */
  wordMs: number
  /** Between two streamed words of the agent's thinking. */
  thinkingWordMs: number
  /** How long the fake tool call runs. */
  toolMs: number
}

export const DEMO_TIMING: DemoTiming = { stepMs: 260, wordMs: 38, thinkingWordMs: 16, toolMs: 700 }

export type DemoServerOptions = {
  push: DemoPush
  timing?: Partial<DemoTiming>
  platform?: DemoPlatform
  now?: () => number
  /** Opt-in usage-limit scenario for exercising the real recovery UI. */
  usageResetMs?: number
  /** Accounts listed for each provider that holds several; one when absent. */
  accountsPerProvider?: number
}

type Handler<M extends MethodName> = (params: ParamsOf<M>) => ResultOf<M> | Promise<ResultOf<M>>
type Handlers = { [M in MethodName]?: Handler<M> }

type Submission = QueuedTurn

type DemoThread = {
  id: string
  projectPath: string
  title: string
  provider: ProviderId
  createdAt: number
  lastActiveAt: number
  pinned: boolean
  unread: boolean
  lifecycle: ThreadLifecycle
  approval: ApprovalMode
  settings: ThreadSettings
  log: Array<{ seq: number; event: DomainEvent }>
  queue: QueuedTurn[]
  /** A Stop holds the queue until the user writes again, as the real server does. */
  held: boolean
  tokens: number
}

type DemoProjectState = {
  path: string
  name: string
  pinned: boolean
  createdAt: number
  branch: string
  branches: string[]
  files: DemoFile[]
}

type FileEntry = ResultOf<'workspace.listDirectory'>['entries'][number]

type Step = { delay: number; run: () => void }
type Run = {
  turnId: string
  steps: Step[]
  /** Items started and not completed yet, with the text streamed so far. */
  open: Map<string, Item>
  timer: ReturnType<typeof setTimeout> | undefined
}

const DAY = 24 * 60 * 60_000
const ACTIVE: ThreadLifecycle = { state: 'active', keepActive: false }

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random()}`
}

function oneLine(text: string, limit: number): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean
}

export class DemoServer {
  readonly platform: DemoPlatform
  readonly home: string
  #push: DemoPush
  #now: () => number
  #usageResetAt: number | undefined
  #accountsPerProvider: number
  #timing: DemoTiming
  #projects: DemoProjectState[] = []
  #threads = new Map<string, DemoThread>()
  #runs = new Map<string, Run>()
  #timers = new Set<ReturnType<typeof setTimeout>>()
  #sidebar: SidebarSettings = { mode: 'classic', autoSettleDays: 3 }
  #subagents: SubagentSettings = {}
  #hiddenModels: string[] = []
  #roster: string[] | null = null
  #contextSettings: ProviderContextSettingsMap = {}
  #backgroundModel: BackgroundModelPreference = { mode: 'automatic' }
  #skillOverrides = new Map<string, boolean>()
  readonly #handlers: Handlers

  constructor(options: DemoServerOptions) {
    this.#push = options.push
    this.#now = options.now ?? Date.now
    this.#usageResetAt =
      options.usageResetMs === undefined ? undefined : this.#now() + options.usageResetMs
    this.#accountsPerProvider = Math.min(
      DEMO_ACCOUNTS_MAX,
      Math.max(1, Math.floor(options.accountsPerProvider ?? 1)),
    )
    this.#timing = { ...DEMO_TIMING, ...options.timing }
    this.platform = options.platform ?? detectDemoPlatform()
    this.home = demoHome(this.platform)
    this.#seed()
    if (this.#usageResetAt !== undefined) {
      const thread = this.#thread('demo-focus-ring')
      const turnId = 'demo-usage-limited'
      this.#append(thread, {
        type: 'turn.started',
        turn: {
          id: turnId,
          threadId: thread.id,
          status: 'running',
          createdAt: this.#now() - 1000,
        },
      })
      this.#append(thread, {
        type: 'item.completed',
        item: {
          id: 'demo-usage-request',
          turnId,
          type: 'message',
          role: 'user',
          status: 'completed',
          text: 'Finish checking the keyboard focus states and run the tests.',
          createdAt: this.#now() - 1000,
        },
      })
      this.#append(thread, {
        type: 'thread.error',
        threadId: thread.id,
        message: 'You have reached your usage limit.',
      })
      this.#append(thread, {
        type: 'turn.completed',
        turnId,
        status: 'failed',
        completedAt: this.#now(),
      })
    }
    this.#handlers = this.#createHandlers()
  }

  /** The seeded or live answer to one request, or undefined for a method the sandbox ignores. */
  handle<M extends MethodName>(
    method: M,
    params: ParamsOf<M>,
  ): ResultOf<M> | Promise<ResultOf<M>> | undefined {
    const handler: Handler<M> | undefined = this.#handlers[method]
    return handler?.(params)
  }

  /** Stops every timer, so a test or a hot reload leaves nothing running. */
  dispose(): void {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
    for (const run of this.#runs.values()) clearTimeout(run.timer)
    this.#runs.clear()
  }

  isRunning(threadId: string): boolean {
    return this.#runs.has(threadId)
  }

  threadIds(): string[] {
    return [...this.#threads.keys()]
  }

  // -------------------------------------------------------------------------
  // Seed

  #seed(): void {
    const now = this.#now()
    for (const project of DEMO_PROJECTS) {
      const path = demoJoin(this.platform, this.home, 'code', project.name)
      this.#projects.push({
        path,
        name: project.name,
        pinned: project.pinned,
        createdAt: now - project.createdAgoMs,
        branch: project.branch,
        branches: [...project.branches],
        files: project.files,
      })
      for (const chat of project.chats) {
        const createdAt = now - (chat.turns[0]?.agoMs ?? 0) - 1_000
        const thread: DemoThread = {
          id: chat.id,
          projectPath: path,
          title: chat.title,
          provider: chat.provider,
          createdAt,
          lastActiveAt: createdAt,
          pinned: chat.pinned ?? false,
          unread: chat.unread ?? false,
          lifecycle: ACTIVE,
          approval: chat.approval,
          settings: {
            model: chat.model,
            ...(chat.effort ? { effort: chat.effort } : {}),
            approval: chat.approval,
          },
          log: [],
          queue: [],
          held: false,
          tokens: 0,
        }
        chat.turns.forEach((turn, index) => this.#seedTurn(thread, turn, index, now))
        this.#threads.set(thread.id, thread)
      }
    }
  }

  #seedTurn(thread: DemoThread, turn: DemoTurn, index: number, now: number): void {
    const turnId = `${thread.id}-turn-${index + 1}`
    const startedAt = now - turn.agoMs
    const spacing = turn.durationMs / (turn.items.length + 1)
    this.#append(thread, {
      type: 'turn.started',
      turn: { id: turnId, threadId: thread.id, status: 'running', createdAt: startedAt },
    })
    this.#append(thread, {
      type: 'item.completed',
      item: {
        id: `${turnId}-prompt`,
        turnId,
        type: 'message',
        role: 'user',
        status: 'completed',
        text: turn.prompt,
        createdAt: startedAt,
      },
    })
    if (turn.plan) this.#append(thread, { type: 'plan.updated', turnId, steps: turn.plan })
    turn.items.forEach((item: DemoItem, position) => {
      const { status, ...content } = item
      this.#append(thread, {
        type: 'item.completed',
        item: {
          ...content,
          id: `${turnId}-item-${position + 1}`,
          turnId,
          status: status ?? 'completed',
          createdAt: Math.round(startedAt + spacing * (position + 1)),
        },
      })
    })
    if (turn.diff) this.#append(thread, { type: 'diff.updated', turnId, diff: turn.diff })
    if (turn.usage) {
      this.#append(thread, { type: 'usage.updated', usage: turn.usage })
      thread.tokens = turn.usage.totalTokens
    }
    const completedAt = startedAt + turn.durationMs
    this.#append(thread, { type: 'turn.completed', turnId, status: 'completed', completedAt })
    thread.lastActiveAt = completedAt
  }

  // -------------------------------------------------------------------------
  // Event log and pushes

  #append(thread: DemoThread, event: DomainEvent): number {
    const seq = thread.log.length + 1
    thread.log.push({ seq, event })
    return seq
  }

  #record(thread: DemoThread, event: DomainEvent): void {
    const seq = this.#append(thread, event)
    this.#push('thread.event', { threadId: thread.id, event, seq })
  }

  #later(delay: number, run: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      run()
    }, delay)
    this.#timers.add(timer)
    return timer
  }

  #pushQueue(thread: DemoThread): void {
    this.#push('thread.queue', {
      threadId: thread.id,
      items: [...thread.queue],
      canSteer: this.#canSteer(thread),
    })
  }

  #canSteer(thread: DemoThread): boolean {
    return demoProvider(thread.provider)?.status.capabilities?.steer === true
  }

  #pushSettings(thread: DemoThread): void {
    this.#push('thread.settings', { threadId: thread.id, settings: thread.settings })
  }

  // -------------------------------------------------------------------------
  // Live turns

  #startTurn(thread: DemoThread, submission: Submission): string {
    const now = this.#now()
    const turnId = `turn-${randomId()}`
    thread.lastActiveAt = now
    thread.unread = false
    this.#record(thread, {
      type: 'turn.started',
      turn: { id: turnId, threadId: thread.id, status: 'running', createdAt: now },
    })
    this.#record(thread, { type: 'item.completed', item: this.#promptItem(submission, turnId) })
    const run: Run = { turnId, steps: [], open: new Map(), timer: undefined }
    this.#runs.set(thread.id, run)
    run.steps.push(...this.#replySteps(thread, run, submission.text))
    this.#advance(thread, run)
    return turnId
  }

  #promptItem(submission: Submission, turnId: string): Item {
    return {
      id: submission.id,
      turnId,
      type: 'message',
      role: 'user',
      status: 'completed',
      text: submission.text,
      ...(submission.attachments.length > 0 ? { attachments: submission.attachments } : {}),
      createdAt: submission.createdAt,
    }
  }

  #replySteps(thread: DemoThread, run: Run, prompt: string): Step[] {
    const provider = demoProvider(thread.provider)
    const reply = demoReply(prompt, provider?.status.displayName ?? thread.provider)
    const steps: Step[] = []
    if (provider?.status.capabilities?.reasoningItems) {
      steps.push(
        ...this.#streamSteps(thread, run, { type: 'reasoning' }, reply.thinking, {
          wordMs: this.#timing.thinkingWordMs,
        }),
      )
    }
    const call = `${provider?.tool ?? 'search'}\n${JSON.stringify(reply.toolArgs)}`
    const toolId = `item-${randomId()}`
    steps.push({
      delay: this.#timing.stepMs,
      run: () => this.#startItem(thread, run, toolId, { type: 'tool_call', text: call }),
    })
    steps.push({
      delay: this.#timing.toolMs,
      run: () => this.#completeItem(thread, run, toolId, { text: `${call}\n${reply.toolOutput}` }),
    })
    steps.push(...this.#answerSteps(thread, run, reply.answer))
    return steps
  }

  #answerSteps(thread: DemoThread, run: Run, text: string): Step[] {
    return this.#streamSteps(
      thread,
      run,
      { type: 'message', role: 'assistant' },
      text,
      { wordMs: this.#timing.wordMs },
      { phase: 'final_answer' },
    )
  }

  /** Starts an item, streams `text` into it word by word, then completes it. */
  #streamSteps(
    thread: DemoThread,
    run: Run,
    base: Pick<Item, 'type' | 'role'>,
    text: string,
    { wordMs }: { wordMs: number },
    completion: Partial<Item> = {},
  ): Step[] {
    const id = `item-${randomId()}`
    const words = text.match(/\S+\s*/g) ?? []
    return [
      { delay: this.#timing.stepMs, run: () => this.#startItem(thread, run, id, base) },
      ...words.map((word) => ({
        delay: wordMs,
        run: () => this.#delta(thread, run, id, word),
      })),
      {
        delay: Math.round(this.#timing.stepMs / 2),
        run: () => this.#completeItem(thread, run, id, completion),
      },
    ]
  }

  #startItem(thread: DemoThread, run: Run, id: string, base: Partial<Item>): void {
    const item: Item = {
      text: '',
      ...base,
      type: base.type ?? 'message',
      id,
      turnId: run.turnId,
      status: 'started',
      createdAt: this.#now(),
    }
    run.open.set(id, item)
    this.#record(thread, { type: 'item.started', item })
  }

  #delta(thread: DemoThread, run: Run, id: string, textDelta: string): void {
    const item = run.open.get(id)
    if (!item) return
    run.open.set(id, { ...item, text: `${item.text ?? ''}${textDelta}` })
    this.#record(thread, { type: 'item.delta', turnId: run.turnId, itemId: id, textDelta })
  }

  #completeItem(thread: DemoThread, run: Run, id: string, completion: Partial<Item> = {}): void {
    const item = run.open.get(id)
    if (!item) return
    run.open.delete(id)
    this.#record(thread, {
      type: 'item.completed',
      item: { ...item, ...completion, status: 'completed' },
    })
  }

  #advance(thread: DemoThread, run: Run): void {
    if (this.#runs.get(thread.id) !== run) return
    const step = run.steps.shift()
    if (!step) {
      this.#finishTurn(thread, run, 'completed')
      return
    }
    run.timer = setTimeout(() => {
      run.timer = undefined
      if (this.#runs.get(thread.id) !== run) return
      step.run()
      this.#advance(thread, run)
    }, step.delay)
  }

  #finishTurn(thread: DemoThread, run: Run, status: 'completed' | 'interrupted'): void {
    clearTimeout(run.timer)
    run.timer = undefined
    // A stopped turn keeps what streamed so far; a tool cut off mid-call failed.
    for (const item of run.open.values()) {
      this.#record(thread, {
        type: 'item.completed',
        item: { ...item, status: item.type === 'tool_call' ? 'failed' : 'completed' },
      })
    }
    run.open.clear()
    const now = this.#now()
    if (status === 'completed') {
      thread.tokens += 2_600
      const window = demoProvider(thread.provider)?.status.capabilities?.context?.windows[0]
      this.#record(thread, {
        type: 'usage.updated',
        usage: {
          inputTokens: Math.round(thread.tokens * 0.82),
          cachedInputTokens: Math.round(thread.tokens * 0.6),
          outputTokens: Math.round(thread.tokens * 0.14),
          reasoningTokens: Math.round(thread.tokens * 0.04),
          totalTokens: thread.tokens,
          ...(window ? { contextWindow: window } : {}),
          ...(thread.settings.model ? { model: thread.settings.model } : {}),
        },
      })
    }
    this.#record(thread, { type: 'turn.completed', turnId: run.turnId, status, completedAt: now })
    this.#runs.delete(thread.id)
    thread.lastActiveAt = now
    if (status === 'interrupted') thread.held = true
    else this.#later(this.#timing.stepMs, () => this.#drain(thread))
  }

  #drain(thread: DemoThread): void {
    if (this.#runs.has(thread.id) || thread.held || this.#threads.get(thread.id) !== thread) return
    const next = thread.queue.shift()
    if (!next) return
    this.#pushQueue(thread)
    this.#startTurn(thread, next)
  }

  #submit(params: ParamsOf<'thread.sendTurn'>): ResultOf<'thread.sendTurn'> {
    const thread = this.#thread(params.threadId)
    if (params.model) thread.settings = { ...thread.settings, model: params.model }
    if (params.effort) thread.settings = { ...thread.settings, effort: params.effort }
    const submission: Submission = {
      id: params.clientSubmissionId ?? `prompt-${randomId()}`,
      text: params.text,
      attachments: params.attachments ?? [],
      createdAt: this.#now(),
    }
    // Writing again after a Stop lets the prompts it held go, in order.
    thread.held = false
    if (this.#runs.has(thread.id) || thread.queue.length > 0) {
      thread.queue.push(submission)
      this.#pushQueue(thread)
      if (!this.#runs.has(thread.id)) this.#later(this.#timing.stepMs, () => this.#drain(thread))
      return { queued: true, queuedTurn: submission }
    }
    return { queued: false, turnId: this.#startTurn(thread, submission) }
  }

  #steer(params: ParamsOf<'thread.steerQueuedTurn'>): ResultOf<'thread.steerQueuedTurn'> {
    const thread = this.#thread(params.threadId)
    const index = thread.queue.findIndex((item) => item.id === params.queuedTurnId)
    if (index < 0) throw new Error('That queued prompt already started or was removed.')
    const run = this.#runs.get(thread.id)
    if (run && !this.#canSteer(thread)) {
      throw new Error('This agent does not support steering a running turn.')
    }
    const [queued] = thread.queue.splice(index, 1)
    if (!queued) return {}
    this.#pushQueue(thread)
    if (!run) {
      // Nothing runs, as after a Stop: the chosen prompt goes now as a turn of its own.
      thread.held = false
      this.#startTurn(thread, queued)
      return {}
    }
    this.#record(thread, { type: 'item.completed', item: this.#promptItem(queued, run.turnId) })
    run.steps.push(
      ...this.#answerSteps(
        thread,
        run,
        `Steering noted: “${oneLine(queued.text, 80)}”. A real agent would change course here; the sandbox only acknowledges it.`,
      ),
    )
    return {}
  }

  #interrupt(threadId: string): void {
    const thread = this.#thread(threadId)
    const run = this.#runs.get(threadId)
    if (run) this.#finishTurn(thread, run, 'interrupted')
  }

  // -------------------------------------------------------------------------
  // Lookups

  #thread(id: string): DemoThread {
    const thread = this.#threads.get(id)
    if (!thread) throw new Error('This chat does not exist in the design sandbox.')
    return thread
  }

  #project(path: string): DemoProjectState {
    const project = this.#projects.find((candidate) => candidate.path === path)
    if (!project) throw new Error('This project does not exist in the design sandbox.')
    return project
  }

  #projectFor(params: { projectPath: string; threadId?: string | undefined }): DemoProjectState {
    const path = params.threadId
      ? (this.#threads.get(params.threadId)?.projectPath ?? params.projectPath)
      : params.projectPath
    return this.#project(path)
  }

  #sessionStatus(thread: DemoThread) {
    if (this.#runs.has(thread.id)) return 'working' as const
    if (thread.queue.length > 0) return 'queued' as const
    return thread.unread ? ('ready' as const) : ('idle' as const)
  }

  #setLifecycle(threadId: string, lifecycle: ThreadLifecycle): ResultOf<'thread.settle'> {
    const thread = this.#thread(threadId)
    thread.lifecycle = lifecycle
    this.#push('thread.lifecycle', { threadId, lifecycle })
    return { lifecycle }
  }

  #listFiles(project: DemoProjectState, directory: string): ResultOf<'workspace.listDirectory'> {
    const folder = directory.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const prefix = folder ? `${folder}/` : ''
    const entries = new Map<string, FileEntry>()
    for (const file of project.files) {
      if (!file.path.startsWith(prefix)) continue
      const [name, ...rest] = file.path.slice(prefix.length).split('/')
      if (!name || entries.has(name)) continue
      entries.set(name, this.#entry(`${prefix}${name}`, rest.length > 0 ? undefined : file))
    }
    return {
      path: folder,
      entries: [...entries.values()].sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
      ),
    }
  }

  #entry(path: string, file: DemoFile | undefined): FileEntry {
    return {
      name: path.split('/').at(-1) ?? path,
      path,
      kind: file ? 'file' : 'directory',
      size: file ? file.content.length : 0,
      modifiedAt: this.#now() - DAY,
      restricted: false,
    }
  }

  #search(params: ParamsOf<'search.sessions'>): ResultOf<'search.sessions'> {
    const needle = params.query.trim().toLowerCase()
    const results: SessionSearchResult[] = []
    for (const thread of this.#threads.values()) {
      if (params.projectPath && thread.projectPath !== params.projectPath) continue
      if (params.provider && thread.provider !== params.provider) continue
      const project = this.#projects.find((candidate) => candidate.path === thread.projectPath)
      for (const { event } of thread.log) {
        if (event.type !== 'item.completed' || event.item.type !== 'message') continue
        const text = event.item.text ?? ''
        const at = text.toLowerCase().indexOf(needle)
        if (at < 0) continue
        const start = Math.max(0, at - 40)
        const end = Math.min(text.length, at + needle.length + 60)
        results.push({
          resultId: `${thread.id}:${event.item.id}`,
          projectPath: thread.projectPath,
          projectName: project?.name ?? thread.projectPath,
          threadId: thread.id,
          threadTitle: thread.title,
          turnId: event.item.turnId,
          provider: thread.provider,
          createdAt: event.item.createdAt,
          snippet: [
            { text: `${start > 0 ? '…' : ''}${text.slice(start, at)}`, highlighted: false },
            { text: text.slice(at, at + needle.length), highlighted: true },
            {
              text: `${text.slice(at + needle.length, end)}${end < text.length ? '…' : ''}`,
              highlighted: false,
            },
          ],
        })
      }
    }
    return { results: results.slice(0, params.limit ?? 50), nextCursor: null }
  }

  #usageHistory(range: UsageHistoryRange): UsageHistoryResult {
    const days = { '7d': 7, '30d': 30, '90d': 90, '365d': 365, all: 120 }[range]
    const now = this.#now()
    const totals = (tokens: number): UsageHistoryTotals => ({
      uncachedInputTokens: Math.round(tokens * 0.2),
      cachedInputTokens: Math.round(tokens * 0.6),
      cacheWriteInputTokens: Math.round(tokens * 0.04),
      outputTokens: Math.round(tokens * 0.13),
      reasoningTokens: Math.round(tokens * 0.03),
      processedTokens: tokens,
      estimatedCostUsd: Math.round(tokens * 0.0004) / 100,
      cacheSavingsUsd: Math.round(tokens * 0.00025) / 100,
      providerReportedCostUsd: 0,
      providerReportedTokens: 0,
      pricedTokens: tokens,
      unpricedTokens: 0,
    })
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
    const ids = DEMO_PROVIDERS.map((provider) => provider.status.id)
    // A smooth made-up curve: busier midweek, quieter on weekends.
    const tokensOn = (day: number, provider: number) =>
      Math.round((180_000 + 120_000 * Math.sin(day * 0.9 + provider * 2)) / (provider + 1) + 40_000)
    const daily = Array.from({ length: days }, (_, offset) => {
      const day = days - 1 - offset
      const perProvider = ids.map((_, index) => tokensOn(day, index))
      return {
        date: new Date(now - day * DAY).toISOString().slice(0, 10),
        sessionCount: 3 + (day % 5),
        totals: totals(sum(perProvider)),
        providers: ids.map((provider, index) => ({
          provider,
          tokens: perProvider[index] ?? 0,
          estimatedCostUsd: Math.round((perProvider[index] ?? 0) * 0.0004) / 100,
        })),
      }
    })
    const providerTokens = ids.map((_, index) =>
      sum(Array.from({ length: days }, (__, day) => tokensOn(day, index))),
    )
    const all = sum(providerTokens)
    return {
      range,
      startDate: daily[0]?.date ?? new Date(now).toISOString().slice(0, 10),
      endDate: new Date(now).toISOString().slice(0, 10),
      generatedAt: now,
      sessionCount: sum(daily.map((day) => day.sessionCount)),
      activeDays: days,
      totals: totals(all),
      providers: ids.map((provider, index) => ({
        provider,
        sessionCount: Math.round(days * (3 - index)),
        totals: totals(providerTokens[index] ?? 0),
      })),
      models: DEMO_PROVIDERS.map((provider, index) => ({
        provider: provider.status.id,
        model: provider.models.find((entry) => entry.isDefault)?.id ?? 'default',
        sessionCount: Math.round(days * (3 - index)),
        pricing: 'exact' as const,
        totals: totals(providerTokens[index] ?? 0),
      })),
      daily,
      sources: ids.map((provider) => ({ provider, available: true, sessionCount: days })),
      scan: { status: 'idle', filesProcessed: 0, filesTotal: 0 },
      warnings: [],
    }
  }

  #backgroundSettings(): ResultOf<'backgroundModel.settings'> {
    const fallback = DEMO_PROVIDERS[0]
    return {
      preference: this.#backgroundModel,
      sources: DEMO_PROVIDERS.map((provider) => ({
        id: provider.status.id,
        displayName: provider.status.displayName,
        provider: provider.status.id,
        models: provider.models,
      })),
      ...(this.#backgroundModel.mode === 'manual'
        ? {
            resolved: {
              ...this.#backgroundModel.target,
              sourceName:
                demoProvider(this.#backgroundModel.target.provider)?.status.displayName ??
                this.#backgroundModel.target.provider,
              automatic: false,
            },
          }
        : fallback
          ? {
              resolved: {
                provider: fallback.status.id,
                model: fallback.models.at(-1)?.id ?? 'default',
                sourceName: fallback.status.displayName,
                automatic: true,
              },
            }
          : {}),
    }
  }

  // -------------------------------------------------------------------------
  // Requests

  #createHandlers(): Handlers {
    const now = () => this.#now()
    const provider = (id: ProviderId) => {
      const found = demoProvider(id)
      if (!found) throw new Error('This provider is not part of the design sandbox.')
      return found
    }
    return {
      'system.info': () => ({
        serverVersion: '0.5.0-sandbox',
        protocolVersion: PROTOCOL_VERSION,
        platform: this.platform,
      }),
      'system.updateCheck': () => ({ upToDate: true }),
      'system.panicStop': () => {
        const sessions = [...this.#runs.keys()].map((threadId) => {
          this.#interrupt(threadId)
          return { threadId, status: 'interrupted' as const }
        })
        return { sessions }
      },
      'feedback.status': () => ({ enabled: false, reason: 'not_configured' }),

      'providers.list': () => ({ providers: DEMO_PROVIDERS.map((entry) => entry.status) }),
      'providers.updates': () => ({ updates: [] }),
      'providers.contextSettings': () => this.#contextSettings,
      'providers.updateContextSettings': ({ provider: id, settings }) => {
        this.#contextSettings = { ...this.#contextSettings, [id]: settings }
        return this.#contextSettings
      },
      'providers.runtimeSettings': () => ({}),
      'providers.accountContextSettings': () => ({ accounts: [] }),
      'providers.roster': () => ({ keys: this.#roster }),
      'providers.setRoster': ({ keys }) => {
        this.#roster = [...keys]
        this.#push('providers.roster', { keys })
        return {}
      },
      'providers.watch': () => ({ expiresInMs: 60_000 }),
      'harnesses.list': () => ({ harnesses: [] }),
      'acp.agents': () => ({ agents: [] }),
      'connections.list': () => ({ connections: [] }),

      'auth.status': ({ provider: id }) => {
        const found = demoProvider(id)
        return found
          ? { signedIn: true, email: found.email, plan: found.plan }
          : { signedIn: false }
      },
      'accounts.list': (params) => ({
        accounts: DEMO_PROVIDERS.filter(
          (entry) =>
            entry.status.capabilities?.multipleAccounts &&
            (params.provider === undefined || params.provider === entry.status.id),
        ).flatMap((entry) =>
          this.#accountsPerProvider > 1
            ? demoAccounts(this.platform, this.home, entry, this.#accountsPerProvider)
            : [
                {
                  id: 'default',
                  provider: entry.status.id,
                  label: 'Default',
                  managed: false,
                  email: entry.email,
                  plan: entry.plan,
                },
              ],
        ),
        active: {},
      }),
      'accounts.detect': () => ({ found: [] }),

      'models.list': (params) => {
        if (params.agent) throw new Error('Custom agents are not part of the design sandbox.')
        return { models: provider(params.provider).models }
      },
      'models.hidden': () => ({ keys: this.#hiddenModels }),
      'models.setHidden': ({ keys }) => {
        this.#hiddenModels = [...keys]
        this.#push('models.hidden', { keys })
        return {}
      },
      'backgroundModel.settings': () => this.#backgroundSettings(),
      'backgroundModel.updateSettings': (preference) => {
        this.#backgroundModel = preference
        return this.#backgroundSettings()
      },
      'backgroundModel.generateTitle': ({ threadId, prompt, expectedTitle }) => {
        const thread = this.#thread(threadId)
        const words = prompt.trim().replace(/\s+/g, ' ').split(' ').slice(0, 7).join(' ')
        const title = oneLine(words.replace(/[.?!,;:]+$/, ''), 60) || 'New chat'
        const applied = thread.title === expectedTitle
        if (applied) thread.title = title
        return { title, applied }
      },
      'backgroundModel.generateCommitMessage': () => ({
        message: 'Polish the prompt bar focus ring',
      }),
      'voice.status': () => ({ available: false, reason: 'provider_unsupported' }),

      'commands.list': (params) => ({
        commands: provider(params.provider).commands,
        loading: false,
      }),
      'skills.list': (params) => ({
        capabilities: { inventory: true, configure: true, install: false },
        skills: provider(params.provider)
          .skills(this.home, this.platform)
          .map((skill) => ({
            ...skill,
            enabled: this.#skillOverrides.get(skill.id) ?? skill.enabled,
          })),
        errors: [],
      }),
      'skills.setEnabled': ({ provider: id, projectPath, skillId, enabled }) => {
        this.#skillOverrides.set(skillId, enabled)
        this.#push('skills.changed', { provider: id, projectPath })
        return { enabled }
      },
      'mcp.list': (params) => ({
        capabilities: {
          inventory: true,
          add: false,
          update: false,
          remove: false,
          reload: true,
          startOAuth: false,
          cancelOAuth: false,
        },
        servers: provider(params.provider).mcp,
      }),

      'usage.summary': (params) => {
        const id = 'threadId' in params ? this.#thread(params.threadId).provider : params.provider
        const accountId = 'accountId' in params ? params.accountId : undefined
        const listed = demoProvider(id)
        const accountLimits =
          accountId !== undefined && listed && this.#accountsPerProvider > 1
            ? demoAccountLimits(listed, accountId, now())
            : undefined
        const limits = accountLimits
          ? accountLimits
          : this.#usageResetAt !== undefined && id === 'claude-code'
            ? [
                {
                  label: 'Session',
                  usedPercent: now() < this.#usageResetAt ? 100 : 0,
                  resetsAt: this.#usageResetAt,
                },
              ]
            : (demoProvider(id)?.limits(now()) ?? [])
        const tokens = {
          inputTokens: 184_000,
          cachedInputTokens: 131_000,
          outputTokens: 22_400,
          reasoningTokens: 6_100,
          totalTokens: 212_500,
        }
        return {
          session: tokens,
          today: { ...tokens, totalTokens: 1_284_000, inputTokens: 1_102_000 },
          limits,
          limitSource: listed
            ? {
                provider: id,
                ...(accountLimits && accountId !== undefined ? { accountId } : {}),
                status: 'ready',
                limits,
                checkedAt: now(),
                origin: 'read',
              }
            : { provider: id, status: 'unavailable', reason: 'unsupported' },
        }
      },
      'usage.history': ({ range }) => this.#usageHistory(range),
      'usage.consumeReset': () => ({ outcome: 'nothingToReset' }),

      'sidebar.settings': () => this.#sidebar,
      'sidebar.updateSettings': ({ mode, autoSettleDays }) => {
        this.#sidebar = {
          mode: mode ?? this.#sidebar.mode,
          autoSettleDays:
            autoSettleDays === undefined ? this.#sidebar.autoSettleDays : autoSettleDays,
        }
        this.#push('sidebar.settings', this.#sidebar)
        return this.#sidebar
      },
      'subagents.settings': () => this.#subagents,
      'subagents.updateSettings': ({ otherProviders }) => {
        this.#subagents = { otherProviders }
        return this.#subagents
      },
      'phone.status': () => ({
        available: false,
        enabled: false,
        listening: false,
        port: 4320,
        serverName: 'Design sandbox',
        addresses: [],
        devices: [],
      }),

      'projects.list': () => ({
        projects: this.#projects.map((project) => ({
          path: project.path,
          name: project.name,
          pinned: project.pinned,
          createdAt: project.createdAt,
          sessions: [...this.#threads.values()]
            .filter((thread) => thread.projectPath === project.path)
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((thread) => ({
              id: thread.id,
              title: thread.title,
              provider: thread.provider,
              createdAt: thread.createdAt,
              running: this.#runs.has(thread.id),
              pinned: thread.pinned,
              status: this.#sessionStatus(thread),
              unread: thread.unread,
              lifecycle: thread.lifecycle,
              ...(thread.settings.model ? { model: thread.settings.model } : {}),
              lastActiveAt: thread.lastActiveAt,
            })),
        })),
      }),
      'projects.pin': ({ path, pinned }) => {
        this.#project(path).pinned = pinned
        return {}
      },
      'projects.rename': ({ path, name }) => {
        this.#project(path).name = name
        return {}
      },
      'projects.remove': ({ path }) => {
        this.#projects = this.#projects.filter((project) => project.path !== path)
        for (const thread of this.#threads.values()) {
          if (thread.projectPath === path) this.#threads.delete(thread.id)
        }
        return {}
      },

      'workspace.info': ({ path }) => {
        const project = this.#project(path)
        const dirty = project.files.length > 4
        return {
          branch: project.branch,
          added: dirty ? 6 : 0,
          removed: dirty ? 5 : 0,
          dirtyFiles: dirty ? 2 : 0,
        }
      },
      'workspace.branches': ({ path }) => ({ branches: this.#project(path).branches }),
      'workspace.switchBranch': ({ path, branch }) => {
        const project = this.#project(path)
        project.branch = branch
        if (!project.branches.includes(branch)) project.branches.push(branch)
        return { branch, added: 0, removed: 0, dirtyFiles: 0 }
      },
      'workspace.diff': (params) => ({
        threadId: params.threadId ?? '',
        version: 'sandbox',
        files: [],
      }),
      'workspace.listDirectory': (params) =>
        this.#listFiles(this.#projectFor(params), params.directory ?? ''),
      'workspace.searchFiles': (params) => {
        const needle = params.query.toLowerCase()
        const project = this.#projectFor(params)
        const paths = new Set<string>()
        for (const file of project.files) {
          const parts = file.path.split('/')
          parts.forEach((_, index) => paths.add(parts.slice(0, index + 1).join('/')))
        }
        const entries = [...paths]
          .filter((path) => path.toLowerCase().includes(needle))
          .map((path) =>
            this.#entry(
              path,
              project.files.find((file) => file.path === path),
            ),
          )
        return { entries: entries.slice(0, params.limit ?? 200), truncated: false }
      },
      'workspace.readFile': (params) => {
        const path = params.path.replace(/\\/g, '/')
        const file = this.#projectFor(params).files.find((entry) => entry.path === path)
        if (!file) throw new Error('That file is not part of the design sandbox.')
        return {
          name: path.split('/').at(-1) ?? path,
          path,
          size: file.content.length,
          binary: false,
          truncated: false,
          content: file.content,
        }
      },
      'pullRequests.list': () => ({
        account: {
          available: false,
          authenticated: false,
          error: 'GitHub is not connected in the design sandbox.',
        },
        items: [],
        fetchedAt: now(),
        truncated: false,
      }),
      'pullRequests.forCheckout': (params) => ({
        available: true,
        branch: this.#projectFor(params).branch,
        defaultBranch: 'main',
        fetchedAt: now(),
      }),

      'thread.start': (params) => {
        const project = this.#project(params.workspacePath)
        provider(params.provider)
        const id = `chat-${randomId()}`
        const approval = params.approval ?? 'auto'
        this.#threads.set(id, {
          id,
          projectPath: project.path,
          title: 'New session',
          provider: params.provider,
          createdAt: now(),
          lastActiveAt: now(),
          pinned: false,
          unread: false,
          lifecycle: ACTIVE,
          approval,
          settings: {
            ...(params.model ? { model: params.model } : {}),
            ...(params.effort ? { effort: params.effort } : {}),
            ...(params.serviceTier ? { serviceTier: params.serviceTier } : {}),
            approval,
          },
          log: [],
          queue: [],
          held: false,
          tokens: 0,
        })
        return { threadId: id }
      },
      'thread.history': (params) => {
        const thread = this.#thread(params.threadId)
        thread.unread = false
        const after = params.afterSeq
        return {
          events:
            after === undefined ? thread.log : thread.log.filter((entry) => entry.seq > after),
          running: this.#runs.has(thread.id),
          approval: thread.approval,
        }
      },
      'thread.sendTurn': (params) => this.#submit(params),
      'thread.interrupt': ({ threadId }) => {
        this.#interrupt(threadId)
        return {}
      },
      'thread.queue': ({ threadId }) => {
        const thread = this.#thread(threadId)
        return { items: [...thread.queue], canSteer: this.#canSteer(thread) }
      },
      'thread.steerQueuedTurn': (params) => this.#steer(params),
      'thread.deleteQueuedTurn': ({ threadId, queuedTurnId }) => {
        const thread = this.#thread(threadId)
        const before = thread.queue.length
        thread.queue = thread.queue.filter((item) => item.id !== queuedTurnId)
        if (thread.queue.length === before) {
          throw new Error('That queued prompt already started or was removed.')
        }
        this.#pushQueue(thread)
        return {}
      },
      'thread.moveQueuedTurn': ({ threadId, queuedTurnId, direction }) => {
        const thread = this.#thread(threadId)
        const from = thread.queue.findIndex((item) => item.id === queuedTurnId)
        const to = from + (direction === 'up' ? -1 : 1)
        const moving = thread.queue[from]
        const other = thread.queue[to]
        if (from < 0 || !moving || !other) return {}
        thread.queue[from] = other
        thread.queue[to] = moving
        this.#pushQueue(thread)
        return {}
      },
      'thread.settings': ({ threadId }) => this.#thread(threadId).settings,
      'thread.setSettings': ({ threadId, model, effort, serviceTier }) => {
        const thread = this.#thread(threadId)
        thread.settings = {
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(serviceTier ? { serviceTier } : {}),
          approval: thread.approval,
        }
        this.#pushSettings(thread)
        return thread.settings
      },
      'thread.setApproval': ({ threadId, approval }) => {
        const thread = this.#thread(threadId)
        thread.approval = approval
        thread.settings = { ...thread.settings, approval }
        return {}
      },
      'thread.changeProvider': (params) => {
        const thread = this.#thread(params.threadId)
        if (this.#runs.has(thread.id) || thread.queue.length > 0) {
          throw new Error('Wait for the current turn to finish before switching providers.')
        }
        provider(params.provider)
        thread.provider = params.provider
        thread.settings = {
          ...(params.model ? { model: params.model } : {}),
          ...(params.effort ? { effort: params.effort } : {}),
          approval: params.approval ?? thread.approval,
        }
        this.#record(thread, {
          type: 'item.completed',
          item: {
            id: `notice-${randomId()}`,
            turnId: '',
            type: 'notice',
            status: 'completed',
            notice: {
              kind: 'provider',
              provider: params.provider,
              ...(params.model ? { model: params.model } : {}),
            },
            createdAt: now(),
          },
        })
        this.#pushSettings(thread)
        return {}
      },
      'thread.rename': ({ threadId, title }) => {
        this.#thread(threadId).title = title
        return {}
      },
      'thread.pin': ({ threadId, pinned }) => {
        this.#thread(threadId).pinned = pinned
        return {}
      },
      'thread.delete': ({ threadId }) => {
        if (this.#runs.has(threadId)) this.#interrupt(threadId)
        this.#threads.delete(threadId)
        return {}
      },
      'thread.settle': ({ threadId }) =>
        this.#setLifecycle(threadId, { state: 'settled', settledAt: now(), reason: 'manual' }),
      'thread.unsettle': ({ threadId }) => this.#setLifecycle(threadId, ACTIVE),
      'thread.snooze': ({ threadId, wakeAt }) =>
        this.#setLifecycle(threadId, { state: 'snoozed', snoozedAt: now(), wakeAt }),
      'thread.unsnooze': ({ threadId }) => this.#setLifecycle(threadId, ACTIVE),
      'thread.setKeepActive': ({ threadId, keepActive }) =>
        this.#setLifecycle(threadId, { state: 'active', keepActive }),
      'thread.diff': ({ threadId }) => ({ threadId, version: 'sandbox', files: [] }),
      'thread.checkpoints': () => ({ checkpoints: [] }),
      'thread.subagents': () => ({ subagents: [] }),
      'thread.unsavedWork': () => ({ isolated: false, uncommitted: false }),
      'search.sessions': (params) => this.#search(params),

      'terminal.open': () => {
        const terminalId = `terminal-${randomId()}`
        this.#later(this.#timing.stepMs, () =>
          this.#push('terminal.output', {
            terminalId,
            data: 'Design sandbox: there is no shell here, so nothing you type runs.\r\n$ ',
          }),
        )
        return { terminalId }
      },
      'terminal.input': ({ terminalId, data }) => {
        this.#push('terminal.output', { terminalId, data: data.replace(/\r/g, '\r\n$ ') })
        return {}
      },
      'terminal.close': ({ terminalId }) => {
        this.#push('terminal.exit', { terminalId, exitCode: 0 })
        return {}
      },
      'terminal.status': () => ({ status: 'running', output: '', outputOffset: 0, exitCode: null }),
    }
  }
}
