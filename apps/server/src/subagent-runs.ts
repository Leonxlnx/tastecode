import { ProviderIdSchema, SubagentSchema } from '@harness/contracts'
import type { Item, ProviderId, Subagent } from '@harness/contracts'
import type { DatabaseSync, StatementSync } from './sqlite.js'

/** The task as the row's tool call shows it, sent with every update. */
const ROW_TASK_CHARACTERS = 2_000

/**
 * Where one sub-agent run stands, as its parent agent sees it. A run waits for
 * the user's approval before it has a chat of its own.
 */
export type SubagentRunState =
  | 'waiting_for_approval'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'declined'
  | 'interrupted'

export const FINISHED_SUBAGENT_STATES: ReadonlySet<SubagentRunState> = new Set([
  'completed',
  'failed',
  'stopped',
  'declined',
  'interrupted',
])

export type StoredSubagentRun = {
  /** The parent's `tool_call` item that shows the run. */
  itemId: string
  parentThreadId: string
  /** What the parent agent calls it, such as "a1"; unique within the parent. */
  shortId: string
  /** The parent turn that started it. */
  turnId: string
  /** The sub-agent's own chat, once it started. */
  threadId?: string
  provider: ProviderId
  agent?: string
  model?: string
  name?: string
  task: string
  state: SubagentRunState
  snapshot: Subagent
  /** Its final message, shortened. */
  result?: string
  createdAt: number
  finishedAt?: number
  /** When its result went to the parent in front of a later prompt. */
  deliveredAt?: number
}

type RunRow = {
  item_id: string
  parent_thread_id: string
  short_id: string
  turn_id: string
  thread_id: string | null
  provider: string
  agent: string | null
  model: string | null
  name: string | null
  task: string
  state: string
  snapshot_json: string
  result_text: string | null
  created_at: number | bigint
  finished_at: number | bigint | null
  delivered_at: number | bigint | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subagent_runs (
  item_id          TEXT PRIMARY KEY,
  parent_thread_id TEXT NOT NULL,
  short_id         TEXT NOT NULL,
  turn_id          TEXT NOT NULL,
  thread_id        TEXT,
  provider         TEXT NOT NULL,
  agent            TEXT,
  model            TEXT,
  name             TEXT,
  task             TEXT NOT NULL,
  state            TEXT NOT NULL,
  snapshot_json    TEXT NOT NULL,
  result_text      TEXT,
  created_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  delivered_at     INTEGER,
  UNIQUE (parent_thread_id, short_id)
);
CREATE INDEX IF NOT EXISTS subagent_runs_by_parent
  ON subagent_runs (parent_thread_id, created_at);
CREATE INDEX IF NOT EXISTS subagent_runs_by_thread
  ON subagent_runs (thread_id) WHERE thread_id IS NOT NULL;
`

const STATES = new Set<string>([
  'waiting_for_approval',
  'running',
  'completed',
  'failed',
  'stopped',
  'declined',
  'interrupted',
])

/** The `subagent_runs` table. Writes are rare: start, state changes, a throttled snapshot. */
export class SubagentRunTable {
  #db: DatabaseSync
  #insert: StatementSync
  #byParent: StatementSync
  #byItem: StatementSync
  #byThread: StatementSync

  constructor(db: DatabaseSync) {
    this.#db = db
    db.exec(SCHEMA)
    this.#insert = db.prepare(
      `INSERT INTO subagent_runs
        (item_id, parent_thread_id, short_id, turn_id, thread_id, provider, agent, model, name,
         task, state, snapshot_json, result_text, created_at, finished_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.#byParent = db.prepare(
      `SELECT * FROM subagent_runs WHERE parent_thread_id = ? ORDER BY created_at DESC, rowid DESC`,
    )
    this.#byItem = db.prepare(`SELECT * FROM subagent_runs WHERE item_id = ?`)
    this.#byThread = db.prepare(`SELECT * FROM subagent_runs WHERE thread_id = ?`)
  }

  add(run: StoredSubagentRun): void {
    this.#insert.run(
      run.itemId,
      run.parentThreadId,
      run.shortId,
      run.turnId,
      run.threadId ?? null,
      run.provider,
      run.agent ?? null,
      run.model ?? null,
      run.name ?? null,
      run.task,
      run.state,
      JSON.stringify(run.snapshot),
      run.result ?? null,
      run.createdAt,
      run.finishedAt ?? null,
      run.deliveredAt ?? null,
    )
  }

  /** Changes the fields given; the others keep their values. */
  update(
    itemId: string,
    change: Partial<
      Pick<
        StoredSubagentRun,
        'threadId' | 'model' | 'state' | 'snapshot' | 'result' | 'finishedAt' | 'deliveredAt'
      >
    >,
  ): void {
    const columns: string[] = []
    const values: Array<string | number | null> = []
    const set = (column: string, value: string | number | null) => {
      columns.push(`${column} = ?`)
      values.push(value)
    }
    if (change.threadId !== undefined) set('thread_id', change.threadId)
    if (change.model !== undefined) set('model', change.model)
    if (change.state !== undefined) set('state', change.state)
    if (change.snapshot !== undefined) set('snapshot_json', JSON.stringify(change.snapshot))
    if (change.result !== undefined) set('result_text', change.result)
    if (change.finishedAt !== undefined) set('finished_at', change.finishedAt)
    if (change.deliveredAt !== undefined) set('delivered_at', change.deliveredAt)
    if (columns.length === 0) return
    this.#db
      .prepare(`UPDATE subagent_runs SET ${columns.join(', ')} WHERE item_id = ?`)
      .run(...values, itemId)
  }

  get(itemId: string): StoredSubagentRun | undefined {
    const row = this.#byItem.get(itemId) as RunRow | undefined
    return row ? toRun(row) : undefined
  }

  forThread(threadId: string): StoredSubagentRun | undefined {
    const row = this.#byThread.get(threadId) as RunRow | undefined
    return row ? toRun(row) : undefined
  }

  /** A chat's runs, newest first. */
  ofParent(parentThreadId: string): StoredSubagentRun[] {
    return (this.#byParent.all(parentThreadId) as RunRow[])
      .map(toRun)
      .filter((run): run is StoredSubagentRun => run !== undefined)
  }

  /**
   * Settles every run a previous process left unfinished: its sub-agent and
   * the approval it waited for died with that process. Returns them settled.
   */
  interruptUnfinished(at: number): StoredSubagentRun[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM subagent_runs WHERE state IN ('waiting_for_approval', 'running')
         ORDER BY created_at`,
      )
      .all() as RunRow[]
    const settled: StoredSubagentRun[] = []
    for (const row of rows) {
      const run = toRun(row)
      if (!run) continue
      const snapshot: Subagent = {
        ...run.snapshot,
        state: 'interrupted',
        background: false,
      }
      delete snapshot.attention
      this.update(run.itemId, { state: 'interrupted', snapshot, finishedAt: at })
      settled.push({ ...run, state: 'interrupted', snapshot, finishedAt: at })
    }
    return settled
  }

  /** Removes the runs of a chat, as parent or as sub-agent. */
  deleteFor(threadId: string): void {
    this.#db
      .prepare(`DELETE FROM subagent_runs WHERE parent_thread_id = ? OR thread_id = ?`)
      .run(threadId, threadId)
  }
}

/** The parent's `tool_call` item that shows a run, carrying its stored snapshot. */
export function subagentRunItem(run: StoredSubagentRun): Item {
  return {
    id: run.itemId,
    turnId: run.turnId,
    type: 'tool_call',
    // The call that started it is done; the sub-agent's own state is the snapshot's.
    status: run.state === 'failed' ? 'failed' : 'completed',
    text: `subagent\n${JSON.stringify({ prompt: shorten(run.task, ROW_TASK_CHARACTERS) })}`,
    subagent: run.snapshot,
    createdAt: run.createdAt,
  }
}

/** Keeps the start and the end, where a report puts its summary and its conclusion. */
export function shorten(text: string, limit: number): string {
  if (text.length <= limit) return text
  const marker = '\n\n[… shortened by TasteCode …]\n\n'
  const keep = limit - marker.length
  const head = Math.ceil(keep / 2)
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (keep - head))}`
}

function toRun(row: RunRow): StoredSubagentRun | undefined {
  const provider = ProviderIdSchema.safeParse(row.provider)
  if (!provider.success || !STATES.has(row.state)) return undefined
  let snapshot: Subagent
  try {
    const parsed = SubagentSchema.safeParse(JSON.parse(row.snapshot_json))
    if (!parsed.success) return undefined
    snapshot = parsed.data
  } catch {
    return undefined
  }
  return {
    itemId: row.item_id,
    parentThreadId: row.parent_thread_id,
    shortId: row.short_id,
    turnId: row.turn_id,
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    provider: provider.data,
    ...(row.agent === null ? {} : { agent: row.agent }),
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.name === null ? {} : { name: row.name }),
    task: row.task,
    state: row.state as SubagentRunState,
    snapshot,
    ...(row.result_text === null ? {} : { result: row.result_text }),
    createdAt: Number(row.created_at),
    ...(row.finished_at === null ? {} : { finishedAt: Number(row.finished_at) }),
    ...(row.delivered_at === null ? {} : { deliveredAt: Number(row.delivered_at) }),
  }
}
