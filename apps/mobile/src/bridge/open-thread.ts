import type {
  ApprovalDecision,
  ApprovalMode,
  Model,
  SessionDiff,
  ThreadSettings,
} from '@harness/contracts'
import { catalog, connection, projects, sessions } from '../state/app'
import { effortFor, sourceKey, type Source } from '../state/catalog'
import { findSession } from '../state/projects'
import type { ThreadSession } from '../state/thread-session'
import { resolveModel, setupView } from '../view/catalog'
import { approvalView, buildRows, questionsView, rowView, sameRow, type Row } from '../view/thread'
import type { ChangesView, RowView, ThreadMetaView, ThreadPatch } from '../view/types'

type Setup = Pick<ThreadSettings, 'model' | 'effort' | 'serviceTier'>

/** Where chats this phone just started run, until the computer's list names them. */
export const startedSources = new Map<string, string>()

/** The tier to keep when the model changes: only one the new model offers. */
function tierFor(model: Model | undefined, chosen: string | undefined): string | undefined {
  return chosen && model?.serviceTiers.some((tier) => tier.id === chosen) ? chosen : undefined
}

/**
 * A chat the screens show. Each update carries only the rows that changed, so
 * a streaming reply sends its own text and nothing else.
 */
export class OpenThread {
  readonly session: ThreadSession
  #rows = new Map<string, { row: Row; view: RowView }>()
  #order: string[] = []
  #sent = false
  /** The chat's setup as the computer keeps it, shared with every other client. */
  #settings: ThreadSettings = {}
  #changes: ChangesView | null = null
  #wasRunning = false
  #unsubscribe: Array<() => void>
  #scheduled = false

  constructor(
    readonly threadId: string,
    private readonly push: (patch: ThreadPatch) => void,
  ) {
    this.session = sessions.acquire(threadId)
    this.#unsubscribe = [
      this.session.state.subscribe(() => this.flush()),
      projects.state.subscribe(() => this.schedule()),
      catalog.state.subscribe(() => this.schedule()),
      connection.on('thread.settings', ({ threadId: changed, settings }) => {
        if (changed === this.threadId) this.#adopt(settings)
      }),
      connection.onOpen(() => void this.readSettings()),
    ]
    this.#wasRunning = this.session.state.get().view.running
    this.flush()
    void this.readSettings()
    void this.readChanges()
  }

  async readSettings(): Promise<void> {
    try {
      this.#adopt(await connection.request('thread.settings', { threadId: this.threadId }))
    } catch {
      // The next reconnect reads it again; until then the chat shows its defaults.
    }
  }

  #adopt(settings: ThreadSettings): void {
    if (JSON.stringify(settings) === JSON.stringify(this.#settings)) return
    this.#settings = settings
    this.flush()
  }

  /** Changes the setup here at once and on the computer, which tells every other client. */
  async #write(setup: Setup): Promise<void> {
    const previous = this.#settings
    const next = { ...setup, ...(previous.approval ? { approval: previous.approval } : {}) }
    this.#adopt(next)
    try {
      this.#adopt(
        await connection.request('thread.setSettings', { threadId: this.threadId, ...setup }),
      )
    } catch (error) {
      this.#adopt(previous)
      throw error
    }
  }

  #current(): { model: Model | undefined; setup: Setup } {
    const model = resolveModel(
      this.source(),
      this.#settings.model,
      this.session.state.get().view.model,
    )
    const effort = effortFor(model, this.#settings.effort)
    const serviceTier = tierFor(model, this.#settings.serviceTier)
    return {
      model,
      setup: {
        ...(model ? { model: model.id } : {}),
        ...(effort ? { effort } : {}),
        ...(serviceTier ? { serviceTier } : {}),
      },
    }
  }

  close(): void {
    for (const unsubscribe of this.#unsubscribe) unsubscribe()
    this.#unsubscribe = []
    sessions.release(this.threadId)
  }

  /** Coalesces list and catalog changes, which arrive in bursts, into one update. */
  schedule(): void {
    if (this.#scheduled) return
    this.#scheduled = true
    setTimeout(() => {
      this.#scheduled = false
      this.flush()
    }, 0)
  }

  flush(): void {
    const screen = this.session.state.get()
    const rows = buildRows(screen.view)
    const changed: RowView[] = []
    const order: string[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      order.push(row.key)
      seen.add(row.key)
      const cached = this.#rows.get(row.key)
      if (cached && sameRow(cached.row, row) && !this.#timingChanged(cached.view, row)) continue
      const view = rowView(row, screen.view)
      this.#rows.set(row.key, { row, view })
      changed.push(view)
    }
    for (const key of this.#rows.keys()) if (!seen.has(key)) this.#rows.delete(key)
    const orderChanged =
      order.length !== this.#order.length || order.some((key, index) => key !== this.#order[index])
    this.#order = order

    if (this.#wasRunning && !screen.view.running) void this.readChanges()
    this.#wasRunning = screen.view.running

    const reset = !this.#sent
    this.#sent = true
    this.push({
      meta: this.meta(),
      rows: changed,
      order: orderChanged || reset ? order : null,
      reset,
    })
  }

  /** A turn's duration is known only once it ends, after its steps were last worded. */
  #timingChanged(view: RowView, row: Row): boolean {
    if (view.kind !== 'steps' || row.kind !== 'steps' || view.duration !== null) return false
    const { turnStarted, turnEnded } = this.session.state.get().view
    return turnStarted[row.turnId] !== undefined && turnEnded[row.turnId] !== undefined
  }

  source(): Source | undefined {
    const found = findSession(projects.state.get().projects, this.threadId)
    const sources = catalog.state.get().sources
    if (found) {
      const { session } = found
      const ref = {
        provider: session.provider,
        agent: session.agent,
        connectionId: session.connectionId,
        accountId: session.accountId,
      }
      const key = sourceKey(ref)
      const known = sources.find((entry) => entry.key === key)
      if (known) return known
      return catalog.state.get().status === 'ready' ? catalog.ensure(ref) : undefined
    }
    return sources.find((entry) => entry.key === startedSources.get(this.threadId))
  }

  meta(): ThreadMetaView {
    const screen = this.session.state.get()
    const { view } = screen
    const found = findSession(projects.state.get().projects, this.threadId)
    const source = this.source()
    const { model, setup } = this.#current()
    const rows = this.#order
    const last = rows.length > 0 ? this.#rows.get(rows[rows.length - 1]!)?.view : undefined
    const streaming = last?.kind === 'assistant' && last.streaming
    const approval = view.approvals[0]
    const question = view.userInputs[0]
    const projectPath = found?.project.path ?? null
    return {
      id: this.threadId,
      title: found?.session.title.trim() || 'New chat',
      projectName: found?.project.name ?? null,
      projectPath,
      pinned: found?.session.pinned ?? false,
      archived: found?.session.lifecycle?.state === 'settled',
      status: screen.status,
      error: screen.error ?? null,
      running: view.running,
      waiting: view.running && !streaming && last?.kind !== 'steps' && !approval && !question,
      hasOlder: screen.olderCursor !== undefined,
      loadingOlder: screen.loadingOlder,
      setup: setupView(
        source,
        model,
        setup,
        this.#settings.approval ?? screen.approval,
        !view.running && screen.queue.length === 0,
      ),
      approval: approval ? approvalView(approval, projectPath) : null,
      questions: question ? questionsView(question) : null,
      queue: screen.queue.map((entry) => ({
        id: entry.id,
        text: entry.text.trim() || (entry.attachments.length > 0 ? 'Image' : ''),
      })),
      canSteer: screen.canSteer,
      plan: view.running ? view.plan.map((step) => ({ text: step.text, status: step.status })) : [],
      changes: this.#changes,
    }
  }

  async send(text: string, attachments: string[]): Promise<void> {
    projects.touch(this.threadId)
    await this.session.send(text, attachments, this.#current().setup)
  }

  decide(approvalId: string, decision: ApprovalDecision): Promise<void> {
    return this.session.respondToApproval(approvalId, decision)
  }

  async setAccess(access: ApprovalMode): Promise<void> {
    const previous = this.#settings
    this.#adopt({ ...previous, approval: access })
    try {
      await this.session.setApproval(access)
    } catch (error) {
      this.#adopt(previous)
      throw error
    }
  }

  setEffort(effort: string): Promise<void> {
    return this.#write({ ...this.#current().setup, effort })
  }

  /** A provider's faster routing, such as Codex's Fast tier; absent is the standard one. */
  setTier(tier: string | null): Promise<void> {
    const { serviceTier: _previous, ...rest } = this.#current().setup
    return this.#write(tier ? { ...rest, serviceTier: tier } : rest)
  }

  /** Picks a model; one from another source moves the chat there, once its turn is done. */
  async setModel(key: string, modelId: string): Promise<void> {
    const current = this.source()
    const target = catalog.state.get().sources.find((entry) => entry.key === key)
    const picked = target?.models.find((model) => model.id === modelId)
    if (!target || !picked) throw new Error('That model is no longer offered.')
    if (target.key === current?.key) {
      const { setup } = this.#current()
      const effort = effortFor(picked, setup.effort)
      const serviceTier = tierFor(picked, setup.serviceTier)
      await this.#write({
        model: picked.id,
        ...(effort ? { effort } : {}),
        ...(serviceTier ? { serviceTier } : {}),
      })
      return
    }
    const screen = this.session.state.get()
    if (screen.view.running || screen.queue.length > 0) {
      throw new Error('A chat can move to another provider once its turn has finished.')
    }
    const effort = effortFor(picked, undefined)
    await connection.request('thread.changeProvider', {
      threadId: this.threadId,
      provider: target.provider,
      ...(target.agent ? { agent: target.agent } : {}),
      ...(target.accountId ? { accountId: target.accountId } : {}),
      model: picked.id,
      ...(effort ? { effort } : {}),
      approval: this.#settings.approval ?? screen.approval,
    })
    await Promise.all([projects.refresh(), this.readSettings()])
  }

  async diff(): Promise<SessionDiff> {
    const found = findSession(projects.state.get().projects, this.threadId)
    if (!found) throw new Error('This chat is not on the computer’s list yet.')
    const diff = await connection.request('workspace.diff', {
      projectPath: found.project.path,
      threadId: this.threadId,
    })
    this.#adoptChanges(diff)
    return diff
  }

  /** The chat's uncommitted changes in numbers, for the title bar. */
  async readChanges(): Promise<void> {
    if (!findSession(projects.state.get().projects, this.threadId)) return
    try {
      await this.diff()
    } catch {
      // A folder without git has nothing to review; the button stays away.
    }
  }

  #adoptChanges(diff: SessionDiff): void {
    let added = 0
    let removed = 0
    for (const file of diff.files) {
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.kind === 'addition') added += 1
          else if (line.kind === 'deletion') removed += 1
        }
      }
    }
    const next = diff.files.length > 0 ? { files: diff.files.length, added, removed } : null
    if (JSON.stringify(next) === JSON.stringify(this.#changes)) return
    this.#changes = next
    this.flush()
  }
}
