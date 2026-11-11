import { ProviderIdSchema, type ProviderLimit, type ResultOf } from '@harness/contracts'
import { z } from 'zod'
import { sameAccount } from './usage-summary-state.js'
import type { Transport } from './transport.js'

/** All exhausted windows must reset, including a longer weekly window. */
export function usageResetAt(limits: readonly ProviderLimit[], now: number): number | undefined {
  const exhausted = limits.filter(
    (limit) =>
      limit.valueLabel === undefined &&
      limit.usedPercent >= 100 &&
      (limit.resetsAt === undefined || limit.resetsAt > now),
  )
  if (!exhausted.length || exhausted.some((limit) => limit.resetsAt === undefined)) return undefined
  return Math.max(...exhausted.map((limit) => limit.resetsAt!))
}

const ResumeSchema = z.object({
  threadId: z.string().min(1),
  provider: ProviderIdSchema,
  accountId: z.string().optional(),
  agent: z.string().optional(),
  connectionId: z.string().optional(),
  model: z.string().optional(),
  userItemId: z.string().min(1),
  resetsAt: z.number().int().nonnegative(),
})
export type UsageResume = z.infer<typeof ResumeSchema>
type Session = ResultOf<'projects.list'>['projects'][number]['sessions'][number]
type Storage = { read: () => string | null; write: (value: string) => void }

/** Renderer-owned, opt-in continuations. No prompts or credentials are stored. */
export class UsageResetController {
  #entries: UsageResume[]
  #listeners = new Set<() => void>()
  #checking = false
  #running = false

  constructor(
    private readonly transport: Transport,
    private readonly storage: Storage,
    private readonly report: (message: string) => void,
  ) {
    this.#entries = this.#stored() ?? []
  }

  snapshot = (): readonly UsageResume[] => this.#entries
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async schedule(
    session: Pick<Session, 'id' | 'provider' | 'accountId' | 'agent' | 'connectionId'>,
    userItemId: string,
    resetsAt: number,
  ): Promise<void> {
    const settings = await this.transport.request('thread.settings', { threadId: session.id })
    await this.transport.request('thread.snooze', { threadId: session.id, wakeAt: resetsAt })
    const entry = ResumeSchema.parse({
      ...session,
      threadId: session.id,
      userItemId,
      resetsAt,
      model: settings.model,
    })
    try {
      this.#update((entries) => [
        ...entries.filter((each) => each.threadId !== entry.threadId),
        entry,
      ])
    } catch (error) {
      await this.transport
        .request('thread.unsnooze', { threadId: session.id })
        .catch(() => undefined)
      throw error
    }
  }

  cancel = (threadId: string): void => {
    this.#update((entries) =>
      entries.some((entry) => entry.threadId === threadId)
        ? entries.filter((entry) => entry.threadId !== threadId)
        : entries,
    )
  }

  start(): () => void {
    this.#running = true
    const timer = setInterval(() => void this.check(), 15_000)
    const offState = this.transport.onState((state) => {
      if (state === 'open') void this.check()
    })
    const offEvent = this.transport.on('thread.event', ({ threadId, event }) => {
      if (
        event.type === 'turn.started' ||
        (event.type === 'item.completed' && event.item.notice?.kind === 'provider')
      )
        this.cancel(threadId)
    })
    const offSettings = this.transport.on('thread.settings', ({ threadId, settings }) => {
      const entry = this.#entries.find((each) => each.threadId === threadId)
      if (entry && entry.model !== settings.model) this.cancel(threadId)
    })
    const offLifecycle = this.transport.on('thread.lifecycle', ({ threadId, lifecycle }) => {
      const entry = this.#entries.find((each) => each.threadId === threadId)
      if (
        entry &&
        (lifecycle.state === 'settled' ||
          (lifecycle.state === 'snoozed' && lifecycle.wakeAt !== entry.resetsAt) ||
          (lifecycle.state === 'active' && Date.now() < entry.resetsAt))
      )
        this.cancel(threadId)
    })
    void this.check()
    return () => {
      this.#running = false
      clearInterval(timer)
      offState()
      offEvent()
      offSettings()
      offLifecycle()
    }
  }

  /** Revalidate after sleep, reconnect or a reload before consuming the one-shot request. */
  async check(): Promise<void> {
    if (!this.#running || this.#checking || this.transport.state !== 'open') return
    // Another window may have scheduled a chat since this one last read the list.
    this.#show(this.#stored() ?? this.#entries)
    if (!this.#entries.some((entry) => entry.resetsAt <= Date.now())) return
    this.#checking = true
    try {
      const run = async () => {
        for (const entry of this.#entries) {
          if (entry.resetsAt > Date.now()) continue
          try {
            await this.#resume(entry)
          } catch {
            // Reads may fail during reconnect. Keep the scheduled request for the next check.
          }
        }
      }
      if (typeof navigator !== 'undefined' && navigator.locks) {
        await navigator.locks.request('tastecode-usage-resume', run)
      } else await run()
    } finally {
      this.#checking = false
    }
  }

  async #resume(entry: UsageResume): Promise<void> {
    const { projects } = await this.transport.request('projects.list', {})
    const session = projects
      .flatMap((project) => project.sessions)
      .find((each) => each.id === entry.threadId)
    if (
      !session ||
      session.closedAt !== undefined ||
      session.running ||
      session.lifecycle?.state === 'settled' ||
      session.provider !== entry.provider ||
      !sameAccount(session.accountId, entry.accountId) ||
      session.agent !== entry.agent ||
      session.connectionId !== entry.connectionId ||
      (session.lifecycle?.state === 'snoozed' && session.lifecycle.wakeAt !== entry.resetsAt)
    ) {
      this.cancel(entry.threadId)
      return
    }
    const [settings, history, summary] = await Promise.all([
      this.transport.request('thread.settings', { threadId: entry.threadId }),
      this.transport.request('thread.history', {
        threadId: entry.threadId,
        page: { turnLimit: 1 },
      }),
      this.transport.request('usage.summary', {
        provider: entry.provider,
        accountId: entry.accountId,
        threadId: entry.threadId,
        intent: 'refresh',
      }),
    ])
    const user = history.events.findLast(
      ({ event }) =>
        event.type === 'item.completed' &&
        event.item.type === 'message' &&
        event.item.role === 'user',
    )?.event
    if (
      history.running ||
      settings.model !== entry.model ||
      user?.type !== 'item.completed' ||
      user.item.id !== entry.userItemId ||
      !history.events.some(
        ({ event }) => event.type === 'turn.completed' && event.status === 'failed',
      )
    ) {
      this.cancel(entry.threadId)
      return
    }
    const limits = summary.limitSource
      ? summary.limitSource.status === 'ready'
        ? summary.limitSource.limits
        : []
      : summary.limits
    const later = usageResetAt(limits, Date.now())
    if (later !== undefined) {
      this.#update((entries) =>
        entries.map((each) => (sameRequest(each, entry) ? { ...each, resetsAt: later } : each)),
      )
      await this.transport.request('thread.snooze', { threadId: entry.threadId, wakeAt: later })
      return
    }
    if (
      limits.some(
        (limit) =>
          limit.valueLabel === undefined &&
          limit.usedPercent >= 100 &&
          limit.resetsAt === undefined,
      )
    )
      return
    if (!this.#running) return
    // The shared storage check and lock stop a second window from sending the same request.
    const saved = this.#stored()
    if (!saved) return
    if (!saved.some((each) => sameRequest(each, entry))) {
      this.#show(saved)
      return
    }
    this.cancel(entry.threadId)
    try {
      await this.transport.request('thread.sendTurn', {
        threadId: entry.threadId,
        text: 'Continue from where you stopped and finish my previous request.',
        clientSubmissionId: crypto.randomUUID(),
        model: entry.model,
      })
    } catch (error) {
      this.report(
        `Could not resume the snoozed chat. Open it before trying again: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Every window keeps its own copy of the shared list. A change starts from
   * what is stored now, so one window never writes back a list that is
   * missing what another window scheduled.
   */
  #update(change: (entries: UsageResume[]) => UsageResume[]): void {
    const current = this.#stored() ?? this.#entries
    const next = change(current)
    if (next !== current) this.storage.write(JSON.stringify(next))
    this.#show(next)
  }

  /** Undefined when the stored list cannot be read at all. */
  #stored(): UsageResume[] | undefined {
    try {
      return z
        .array(ResumeSchema)
        .max(100)
        .parse(JSON.parse(this.storage.read() ?? '[]'))
    } catch {
      return undefined
    }
  }

  #show(entries: UsageResume[]): void {
    if (JSON.stringify(entries) === JSON.stringify(this.#entries)) return
    this.#entries = entries
    for (const listener of this.#listeners) listener()
  }
}

function sameRequest(left: UsageResume, right: UsageResume): boolean {
  return left.threadId === right.threadId && left.userItemId === right.userItemId
}
