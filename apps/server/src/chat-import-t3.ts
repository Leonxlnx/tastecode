import { existsSync, statSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ProviderIdSchema, type DomainEvent, type Item, type ProviderId } from '@harness/contracts'
import type { ChatImportReader, SavedChat } from './chat-import.js'
import { DatabaseSync } from './sqlite.js'
import { MAX_ATTACHMENT_BYTES } from './uploaded-attachment.js'

/**
 * T3 Code keeps its chats in one SQLite database under `~/.t3/userdata`:
 * `statev2.sqlite` on current builds, `state.sqlite` on older ones. Current
 * builds migrate the older file and leave it behind, so the newer one wins.
 * Everything here was written against databases of T3 Code 0.1.7.
 */
const V2_FILE = 'statev2.sqlite'
const LEGACY_FILE = 'state.sqlite'
/** What a tool step keeps. A preview tool saved whole screenshots as text. */
const TOOL_TEXT_CHARACTERS = 64_000
const IMAGE_EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
])

type Row = Record<string, unknown>
type Turn = { id: string; createdAt: number; items: Item[]; failed: boolean }
/** Where pictures are kept, and those a read found that still need copying there. */
type Pictures = { saved: string; from: string; copies: Map<string, string> }

export function createT3CodeReader(options: {
  /** Pictures are copied here, so a chat keeps them if T3 Code is removed later. */
  attachmentsDir: string
  root?: string
}): ChatImportReader {
  const userData = path.join(
    options.root ?? process.env['T3CODE_HOME'] ?? path.join(os.homedir(), '.t3'),
    'userdata',
  )
  const database = () => {
    if (existsSync(path.join(userData, V2_FILE))) return { file: V2_FILE, v2: true }
    if (existsSync(path.join(userData, LEGACY_FILE))) return { file: LEGACY_FILE, v2: false }
    return undefined
  }
  const open = (file: string) =>
    new DatabaseSync(path.join(userData, file), { readOnly: true, allowExtension: false })
  return {
    id: 't3-code',
    name: 'T3 Code',
    present: () => database() !== undefined,
    async list() {
      const found = database()
      if (!found) return []
      const db = open(found.file)
      try {
        return found.v2 ? listV2(db) : listLegacy(db)
      } finally {
        db.close()
      }
    },
    async read(chat) {
      const found = database()
      if (!found) return []
      const pictures: Pictures = {
        saved: path.join(options.attachmentsDir, 't3-code'),
        from: path.join(userData, 'attachments'),
        copies: new Map(),
      }
      const db = open(found.file)
      let turns: Turn[]
      try {
        turns = found.v2 ? readV2(db, chat.id, pictures) : readLegacy(db, chat.id, pictures)
      } finally {
        db.close()
      }
      await copyPictures(pictures)
      return transcriptEvents(chat, turns)
    },
  }
}

function listV2(db: DatabaseSync): SavedChat[] {
  const rows = db
    .prepare(
      `SELECT t.thread_id, t.title, t.default_provider, t.created_at, t.updated_at, t.archived_at,
              p.workspace_root, r.resume_cursor_json,
              json_extract(n.payload_json, '$.nativeThreadRef.nativeId') AS native_id,
              EXISTS (SELECT 1 FROM orchestration_v2_projection_messages m
                WHERE m.thread_id = t.thread_id) AS has_messages
         FROM orchestration_v2_projection_threads t
         JOIN projection_projects p ON p.project_id = t.project_id
         LEFT JOIN provider_session_runtime r ON r.thread_id = t.thread_id
         LEFT JOIN orchestration_v2_projection_provider_threads n
           ON n.provider_thread_id = t.active_provider_thread_id
        WHERE t.deleted_at IS NULL
          AND COALESCE(json_extract(t.payload_json, '$.lineage.relationshipToParent'), '')
              <> 'subagent'`,
    )
    .all() as Row[]
  return rows.flatMap(savedChat)
}

function listLegacy(db: DatabaseSync): SavedChat[] {
  const rows = db
    .prepare(
      `SELECT t.thread_id, t.title, r.provider_name AS default_provider, t.created_at,
              t.updated_at, t.archived_at, p.workspace_root, r.resume_cursor_json,
              EXISTS (SELECT 1 FROM projection_thread_messages m
                WHERE m.thread_id = t.thread_id) AS has_messages
         FROM projection_threads t
         JOIN projection_projects p ON p.project_id = t.project_id
         LEFT JOIN provider_session_runtime r ON r.thread_id = t.thread_id
        WHERE t.deleted_at IS NULL`,
    )
    .all() as Row[]
  return rows.flatMap(savedChat)
}

function savedChat(row: Row): SavedChat[] {
  const id = text(row['thread_id'])
  const folder = text(row['workspace_root'])
  const createdAt = time(row['created_at'])
  if (!id || !folder || !path.isAbsolute(folder) || createdAt === undefined) return []
  if (!Number(row['has_messages'])) return []
  const updatedAt = time(row['updated_at']) ?? createdAt
  const nativeSession = text(row['native_id']) ?? resumeCursorSession(row['resume_cursor_json'])
  return [
    {
      id,
      workspacePath: folder,
      title: text(row['title']) ?? '',
      createdAt,
      updatedAt,
      revision: text(row['updated_at']) ?? '',
      archived: row['archived_at'] !== null && row['archived_at'] !== undefined,
      provider: providerOf(text(row['default_provider'])),
      ...(nativeSession ? { nativeSession } : {}),
    },
  ]
}

/** T3 Code's own driver names. Anything else continues with the most common one. */
function providerOf(driver: string | undefined): ProviderId {
  if (driver === 'claudeAgent') return 'claude-code'
  const known = ProviderIdSchema.safeParse(driver)
  return known.success ? known.data : 'codex'
}

function resumeCursorSession(value: unknown): string | undefined {
  try {
    const cursor = JSON.parse(text(value) ?? 'null') as Row | null
    return text(cursor?.['resume']) ?? text(cursor?.['threadId'])
  } catch {
    return undefined
  }
}

function readV2(db: DatabaseSync, threadId: string, pictures: Pictures): Turn[] {
  const rows = db
    .prepare(
      `SELECT turn_item_id, run_id, type, status, updated_at, payload_json
         FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ? ORDER BY ordinal, turn_item_id`,
    )
    .all(threadId) as Row[]
  const turns = new Turns()
  for (const row of rows) {
    const payload = json(row['payload_json'])
    if (!payload) continue
    const id = text(row['turn_item_id'])
    const type = text(row['type'])
    if (!id || !type) continue
    const createdAt = time(payload['startedAt']) ?? time(row['updated_at']) ?? 0
    const run = text(row['run_id'])
    if (type === 'user_message') turns.open(run ?? id, createdAt, run)
    const turnId = turns.current(run ?? id, createdAt)
    const item = v2Item(type, payload, {
      id,
      turnId,
      status: row['status'] === 'failed' ? 'failed' : 'completed',
      createdAt,
      pictures,
    })
    if (item) turns.add(item)
  }
  return turns.all()
}

type ItemBase = Pick<Item, 'id' | 'turnId' | 'status' | 'createdAt'> & { pictures: Pictures }

function v2Item(type: string, payload: Row, base: ItemBase): Item | undefined {
  const { pictures, ...item } = base
  switch (type) {
    case 'user_message':
      return message(item, 'user', text(payload['text']), attachments(payload, pictures))
    case 'assistant_message':
      return message(item, 'assistant', text(payload['text']))
    case 'reasoning': {
      const value = text(payload['text'])
      return value ? { ...item, type: 'reasoning', text: value } : undefined
    }
    case 'command_execution':
      return {
        ...item,
        type: 'command',
        command: text(payload['input']) ?? '',
        ...(text(payload['output']) ? { text: text(payload['output'])! } : {}),
        ...duration(payload),
      }
    case 'file_change':
      return fileChange(item, payload)
    case 'dynamic_tool':
      return toolCall(
        item,
        text(payload['toolName']) ?? 'tool',
        payload['input'],
        payload['output'],
      )
    case 'web_search':
      return toolCall(item, 'Web search', { queries: payload['patterns'] }, payload['results'])
    case 'file_search':
      return toolCall(item, 'File search', { pattern: payload['pattern'] }, payload['results'])
    case 'subagent':
      return toolCall(
        item,
        text(payload['title']) ?? 'Subagent',
        { prompt: payload['prompt'] },
        payload['result'],
      )
    case 'error': {
      const failure = json(payload['failure']) ?? (payload['failure'] as Row | undefined)
      const value = text(failure?.['message'])
      return value ? { ...item, type: 'error', status: 'failed', text: value } : undefined
    }
    // Approvals, checkpoints and the like described a live run; a transcript has no use for them.
    default:
      return undefined
  }
}

function fileChange(item: Omit<ItemBase, 'pictures'>, payload: Row): Item {
  const diff = text(payload['diffStr'])
  const oldText = typeof payload['oldStr'] === 'string' ? payload['oldStr'] : undefined
  const newText = typeof payload['newStr'] === 'string' ? payload['newStr'] : undefined
  const counted = diff ? diffCounts(diff) : editCounts(oldText, newText)
  return {
    ...item,
    type: 'file_change',
    path: text(payload['fileName']) ?? text(payload['title']) ?? 'file',
    ...(diff ? { text: diff } : {}),
    ...counted,
    ...duration(payload),
  }
}

function diffCounts(diff: string): Pick<Item, 'linesAdded' | 'linesRemoved'> {
  let linesAdded = 0
  let linesRemoved = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) linesAdded += 1
    else if (line.startsWith('-') && !line.startsWith('---')) linesRemoved += 1
  }
  return { linesAdded, linesRemoved }
}

function editCounts(oldText?: string, newText?: string): Pick<Item, 'linesAdded' | 'linesRemoved'> {
  return {
    linesAdded: newText ? newText.split('\n').length : 0,
    linesRemoved: oldText ? oldText.split('\n').length : 0,
  }
}

/** The form the transcript reads: the name, then its arguments as JSON, then the output. */
function toolCall(
  item: Omit<ItemBase, 'pictures'>,
  name: string,
  input: unknown,
  output: unknown,
): Item {
  const args = input === undefined || input === null ? '' : `\n${capped(JSON.stringify(input))}`
  const result =
    typeof output === 'string'
      ? `\n${capped(output)}`
      : output === undefined || output === null
        ? ''
        : `\n${capped(JSON.stringify(output))}`
  return { ...item, type: 'tool_call', text: `${name}${args}${result}` }
}

function capped(value: string): string {
  return value.length > TOOL_TEXT_CHARACTERS
    ? `${value.slice(0, TOOL_TEXT_CHARACTERS)}… (shortened on import)`
    : value
}

function duration(payload: Row): Pick<Item, 'durationMs'> | undefined {
  const started = time(payload['startedAt'])
  const completed = time(payload['completedAt'])
  return started !== undefined && completed !== undefined && completed >= started
    ? { durationMs: completed - started }
    : undefined
}

function message(
  item: Omit<ItemBase, 'pictures'>,
  role: 'user' | 'assistant',
  value: string | undefined,
  pictures: string[] = [],
): Item | undefined {
  if (!value && !pictures.length) return undefined
  return {
    ...item,
    type: 'message',
    role,
    text: value ?? '',
    ...(pictures.length ? { attachments: pictures } : {}),
  }
}

/** Paths of a prompt's pictures once copied. Only pictures this chat attached are read. */
function attachments(source: Row, pictures: Pictures): string[] {
  const list = source['attachments']
  if (!Array.isArray(list)) return []
  return list.flatMap((value: unknown) => {
    const attachment = value as Row | null
    const id = text(attachment?.['id'])
    const mimeType = text(attachment?.['mimeType'])
    const extension = mimeType ? IMAGE_EXTENSIONS.get(mimeType) : undefined
    if (!id || !extension || path.basename(id) !== id) return []
    const name = `${id}${extension}`
    const file = path.join(pictures.from, name)
    try {
      if (statSync(file).size > MAX_ATTACHMENT_BYTES) return []
    } catch {
      return []
    }
    pictures.copies.set(name, file)
    return [path.join(pictures.saved, name)]
  })
}

async function copyPictures({ saved, copies }: Pictures): Promise<void> {
  if (!copies.size) return
  await mkdir(saved, { recursive: true })
  for (const [name, file] of copies) {
    // A picture gone since it was seen leaves a chat that still reads fine.
    await copyFile(file, path.join(saved, name)).catch(() => undefined)
  }
}

function readLegacy(db: DatabaseSync, threadId: string, pictures: Pictures): Turn[] {
  const rows = db
    .prepare(
      `SELECT message_id, turn_id, role, text, created_at, attachments_json
         FROM projection_thread_messages
        WHERE thread_id = ? ORDER BY created_at, message_id`,
    )
    .all(threadId) as Row[]
  const turns = new Turns()
  for (const row of rows) {
    const id = text(row['message_id'])
    const createdAt = time(row['created_at'])
    if (!id || createdAt === undefined) continue
    const run = text(row['turn_id'])
    const role = row['role']
    if (role === 'user') turns.open(run ?? id, createdAt, run)
    const item = {
      id,
      turnId: turns.current(run ?? id, createdAt),
      status: 'completed',
      createdAt,
    } as const
    const value = text(row['text'])
    if (role === 'user' || role === 'assistant') {
      const attached =
        role === 'user' ? attachments({ attachments: list(row['attachments_json']) }, pictures) : []
      const built = message(item, role, value, attached)
      if (built) turns.add(built)
    } else if (role === 'reasoning' && value) {
      turns.add({ ...item, type: 'reasoning', text: value })
    }
  }
  return turns.all()
}

/**
 * Splits items into turns. A prompt opens one, except a prompt steering a run
 * that is already open, which stays in that run as it did in T3 Code.
 */
class Turns {
  #turns: Turn[] = []

  open(id: string, createdAt: number, run: string | undefined): void {
    const last = this.#turns.at(-1)
    if (last && run && last.id === run) return
    this.#turns.push({ id, createdAt, items: [], failed: false })
  }

  /** Items before the first prompt still need a turn to belong to. */
  current(id: string, createdAt: number): string {
    const last = this.#turns.at(-1)
    if (last) return last.id
    this.#turns.push({ id, createdAt, items: [], failed: false })
    return id
  }

  add(item: Item): void {
    const last = this.#turns.at(-1)
    if (!last) return
    last.items.push(item)
    if (item.type === 'error') last.failed = true
  }

  all(): Turn[] {
    return this.#turns.filter((turn) => turn.items.length)
  }
}

function transcriptEvents(chat: SavedChat, turns: Turn[]): DomainEvent[] {
  if (!turns.length) return []
  const events: DomainEvent[] = [
    {
      type: 'thread.started',
      thread: {
        id: chat.id,
        provider: chat.provider,
        workspacePath: chat.workspacePath,
        title: chat.title,
        createdAt: chat.createdAt,
      },
    },
  ]
  for (const turn of turns) {
    events.push({
      type: 'turn.started',
      turn: { id: turn.id, threadId: chat.id, status: 'running', createdAt: turn.createdAt },
    })
    for (const item of turn.items) events.push({ type: 'item.completed', item })
    events.push({
      type: 'turn.completed',
      turnId: turn.id,
      status: turn.failed ? 'failed' : 'completed',
    })
  }
  return events
}

function list(value: unknown): unknown[] {
  try {
    const parsed: unknown = JSON.parse(text(value) ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function json(value: unknown): Row | undefined {
  if (value !== null && typeof value === 'object') return value as Row
  try {
    const parsed: unknown = JSON.parse(text(value) ?? 'null')
    return parsed !== null && typeof parsed === 'object' ? (parsed as Row) : undefined
  } catch {
    return undefined
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined
}

function time(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : undefined
}
