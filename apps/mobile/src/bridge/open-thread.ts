import type { ApprovalDecision, ApprovalMode, SessionDiff } from '@harness/contracts'
import { catalog, connection, projects, sessions } from '../state/app'
import { effortFor, preferences, sourceKey, type Choice, type Source } from '../state/catalog'
import { findSession } from '../state/projects'
import type { ThreadSession } from '../state/thread-session'
import { resolveModel, setupView } from '../view/catalog'
import { approvalView, buildRows, questionsView, rowView, sameRow, type Row } from '../view/thread'
import type { ChangesView, RowView, ThreadMetaView, ThreadPatch } from '../view/types'

type Saved = Choice & { source?: string | undefined }

/**
 * A chat the screens show. Each update carries only the rows that changed, so
 * a streaming reply sends its own text and nothing else.
 */
export class OpenThread {
  readonly session: ThreadSession
  #rows = new Map<string, { row: Row; view: RowView }>()
  #order: string[] = []
  #sent = false
  #choice: Saved
  #changes: ChangesView | null = null
  #wasRunning = false
  #unsubscribe: Array<() => void>
  #scheduled = false

  constructor(
    readonly threadId: string,
    private readonly push: (patch: ThreadPatch) => void,
  ) {
    this.session = sessions.acquire(threadId)
    this.#choice = preferences.read<Saved>(`thread:${threadId}`) ?? {}
    this.#unsubscribe = [
      this.session.state.subscribe(() => this.flush()),
      projects.state.subscribe(() => this.schedule()),
      catalog.state.subscribe(() => this.schedule()),
    ]
    this.#wasRunning = this.session.state.get().view.running
    this.flush()
    void this.readChanges()
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
    return sources.find((entry) => entry.key === this.#choice.source)
  }

  meta(): ThreadMetaView {
    const screen = this.session.state.get()
    const { view } = screen
    const found = findSession(projects.state.get().projects, this.threadId)
    const source = this.source()
    const model = resolveModel(source, this.#choice.model, view.model)
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
        this.#choice,
        screen.approval,
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
    const meta = this.meta()
    await this.session.send(text, attachments, {
      ...(meta.setup.model ? { model: meta.setup.model } : {}),
      ...(meta.setup.effort ? { effort: meta.setup.effort } : {}),
    })
  }

  decide(approvalId: string, decision: ApprovalDecision): Promise<void> {
    return this.session.respondToApproval(approvalId, decision)
  }

  async setAccess(access: ApprovalMode): Promise<void> {
    await this.session.setApproval(access)
  }

  setEffort(effort: string): void {
    this.#remember({ ...this.#choice, effort })
  }

  /** Picks a model; one from another source moves the chat there, once its turn is done. */
  async setModel(key: string, modelId: string): Promise<void> {
    const current = this.source()
    const target = catalog.state.get().sources.find((entry) => entry.key === key)
    const picked = target?.models.find((model) => model.id === modelId)
    if (!target || !picked) throw new Error('That model is no longer offered.')
    if (target.key === current?.key) {
      this.#remember({
        ...this.#choice,
        model: picked.id,
        effort: effortFor(picked, this.#choice.effort),
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
      approval: screen.approval,
    })
    this.#remember({ source: target.key, model: picked.id, effort })
    await projects.refresh()
  }

  #remember(choice: Saved): void {
    this.#choice = choice
    preferences.write(`thread:${this.threadId}`, choice)
    this.flush()
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
