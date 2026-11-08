import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  DomainEvent,
  Item,
  ProviderHistorySession,
  ProviderHistorySource,
} from '@harness/contracts'
import { toolKind } from './events.js'

/**
 * OpenCode's chats live in `opencode.db`. 2.x writes `session_v2` and
 * `session_message`; older builds wrote `session`, `message` and `part`, and 2.x
 * keeps those beside the new ones. Both were read from a real database of
 * OpenCode 2.2.1. Tables it did not have before it migrated are simply absent.
 */
const DATABASE = 'opencode.db'

type Row = Record<string, unknown>
type Turn = { id: string; createdAt: number; items: Item[]; failed: boolean }

export type OpenCodeHistorySource = ProviderHistorySource & { present(): boolean }

export function createOpenCodeHistorySource(
  options: { root?: string } = {},
): OpenCodeHistorySource {
  const root =
    options.root ??
    process.env['OPENCODE_DATA_DIR'] ??
    path.join(
      process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share'),
      'opencode',
    )
  const file = path.join(root, DATABASE)
  const withDatabase = <T>(read: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(file, { readOnly: true, allowExtension: false })
    try {
      return read(db)
    } finally {
      db.close()
    }
  }
  return {
    present: () => existsSync(file),
    async list() {
      if (!existsSync(file)) return []
      // A database whose 2.x table is still empty keeps its chats in the older ones,
      // as read() does for each session.
      return withDatabase((db) => {
        const v2 = hasTable(db, 'session_v2') && hasTable(db, 'session_message') ? listV2(db) : []
        return v2.length || !hasTable(db, 'session') ? v2 : listLegacy(db)
      })
    },
    async read(session) {
      if (!existsSync(file)) return []
      // 1.x builds already create an empty `session_message` and keep writing the older tables.
      const turns = withDatabase((db) => {
        const v2 = hasTable(db, 'session_message') ? readV2(db, session.id) : []
        return v2.length || !hasTable(db, 'message') ? v2 : readLegacy(db, session.id)
      })
      return transcriptEvents(session, turns)
    },
  }
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
    undefined
  )
}

function listV2(db: DatabaseSync): ProviderHistorySession[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.directory, s.title, s.time_created, s.time_updated, s.time_archived,
              (SELECT COUNT(*) FROM session_message m
                WHERE m.session_id = s.id AND m.type = 'user') AS prompts
         FROM session_v2 s WHERE s.parent_id IS NULL`,
    )
    .all() as Row[]
  return rows.flatMap(savedSession)
}

function listLegacy(db: DatabaseSync): ProviderHistorySession[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.directory, s.title, s.time_created, s.time_updated, s.time_archived,
              (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS prompts
         FROM session s WHERE s.parent_id IS NULL`,
    )
    .all() as Row[]
  return rows.flatMap(savedSession)
}

/** A child session is a sub-agent's run; it belongs to its parent's chat, not the list. */
function savedSession(row: Row): ProviderHistorySession[] {
  const id = text(row['id'])
  const workspacePath = text(row['directory'])
  const createdAt = number(row['time_created'])
  const prompts = number(row['prompts'])
  if (!id || !workspacePath || !path.isAbsolute(workspacePath)) return []
  if (createdAt === undefined || !prompts) return []
  const updatedAt = number(row['time_updated']) ?? createdAt
  return [
    {
      id,
      workspacePath,
      title: text(row['title']) ?? '',
      createdAt,
      updatedAt,
      revision: `${updatedAt}:${prompts}`,
      ...(row['time_archived'] === null || row['time_archived'] === undefined
        ? {}
        : { archived: true }),
    },
  ]
}

function readV2(db: DatabaseSync, sessionId: string): Turn[] {
  const rows = db
    .prepare(
      `SELECT id, type, time_created, data FROM session_message
        WHERE session_id = ? ORDER BY seq, id`,
    )
    .all(sessionId) as Row[]
  const turns: Turn[] = []
  for (const row of rows) {
    const id = text(row['id'])
    const data = parsed(row['data'])
    if (!id || !data) continue
    const createdAt = number(row['time_created']) ?? 0
    if (row['type'] === 'user') {
      const prompt = text(data['text'])
      if (!prompt) continue
      const turn: Turn = { id, createdAt, items: [], failed: false }
      turn.items.push(message(id, id, 'user', prompt, createdAt))
      turns.push(turn)
    } else if (row['type'] === 'assistant') {
      const turn = turns.at(-1)
      if (!turn) continue
      const content = Array.isArray(data['content']) ? data['content'] : []
      for (const [index, value] of content.entries()) {
        const part = value as Row
        const partId = text(part['id']) ?? `${id}-${index}`
        const at = number((part['time'] as Row | undefined)?.['created']) ?? createdAt
        if (part['type'] === 'text' && text(part['text'])) {
          turn.items.push(message(`${id}-${partId}`, turn.id, 'assistant', text(part['text'])!, at))
        } else if (part['type'] === 'reasoning' && text(part['text'])) {
          turn.items.push({
            id: `${id}-${partId}`,
            turnId: turn.id,
            type: 'reasoning',
            status: 'completed',
            text: text(part['text'])!,
            createdAt: at,
          })
        } else if (part['type'] === 'tool') {
          const state = (part['state'] ?? {}) as Row
          turn.items.push(
            toolItem(`${id}-${partId}`, turn.id, text(part['name']) ?? 'tool', state, at, {
              output: contentText(state['content']),
            }),
          )
        }
      }
      const failure = text((data['error'] as Row | undefined)?.['message'])
      if (failure) {
        turn.failed = true
        turn.items.push(errorItem(`${id}-error`, turn.id, failure, createdAt))
      }
    }
  }
  return turns.filter((turn) => turn.items.length)
}

function readLegacy(db: DatabaseSync, sessionId: string): Turn[] {
  const messages = db
    .prepare(
      `SELECT id, time_created, data FROM message
        WHERE session_id = ? ORDER BY time_created, id`,
    )
    .all(sessionId) as Row[]
  const parts = db
    .prepare(`SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY id`)
    .all(sessionId) as Row[]
  const byMessage = new Map<string, Row[]>()
  for (const part of parts) {
    const owner = text(part['message_id'])
    if (owner) byMessage.set(owner, [...(byMessage.get(owner) ?? []), part])
  }
  const turns: Turn[] = []
  for (const row of messages) {
    const id = text(row['id'])
    const data = parsed(row['data'])
    if (!id || !data) continue
    const createdAt = number(row['time_created']) ?? 0
    const owned = byMessage.get(id) ?? []
    if (data['role'] === 'user') {
      const prompt = owned
        .flatMap((part) => {
          const value = parsed(part['data'])
          return value?.['type'] === 'text' && text(value['text']) ? [text(value['text'])!] : []
        })
        .join('\n')
      if (!prompt) continue
      turns.push({
        id,
        createdAt,
        items: [message(id, id, 'user', prompt, createdAt)],
        failed: false,
      })
      continue
    }
    const turn = turns.at(-1)
    if (!turn) continue
    for (const part of owned) {
      const partId = text(part['id'])
      const value = parsed(part['data'])
      if (!partId || !value) continue
      if (value['type'] === 'text' && text(value['text'])) {
        turn.items.push(message(partId, turn.id, 'assistant', text(value['text'])!, createdAt))
      } else if (value['type'] === 'reasoning' && text(value['text'])) {
        turn.items.push({
          id: partId,
          turnId: turn.id,
          type: 'reasoning',
          status: 'completed',
          text: text(value['text'])!,
          createdAt,
        })
      } else if (value['type'] === 'tool') {
        const state = (value['state'] ?? {}) as Row
        turn.items.push(
          toolItem(partId, turn.id, text(value['tool']) ?? 'tool', state, createdAt, {
            output: text(state['output']) ?? text(state['error']) ?? '',
          }),
        )
      }
    }
    const failure = text((data['error'] as Row | undefined)?.['message'])
    if (failure) {
      turn.failed = true
      turn.items.push(errorItem(`${id}-error`, turn.id, failure, createdAt))
    }
  }
  return turns.filter((turn) => turn.items.length)
}

function message(
  id: string,
  turnId: string,
  role: 'user' | 'assistant',
  value: string,
  createdAt: number,
): Item {
  return { id, turnId, type: 'message', status: 'completed', role, text: value, createdAt }
}

function errorItem(id: string, turnId: string, value: string, createdAt: number): Item {
  return { id, turnId, type: 'error', status: 'failed', text: value, createdAt }
}

function toolItem(
  id: string,
  turnId: string,
  name: string,
  state: Row,
  createdAt: number,
  { output }: { output: string },
): Item {
  const input = (state['input'] ?? {}) as Row
  const status = state['status'] === 'error' ? 'failed' : 'completed'
  const kind = toolKind(name)
  if (kind === 'command') {
    return {
      id,
      turnId,
      type: 'command',
      status,
      command: text(input['command']) ?? text(input['cmd']) ?? name,
      ...(output ? { text: output } : {}),
      createdAt,
    }
  }
  if (kind === 'file_change') {
    return {
      id,
      turnId,
      type: 'file_change',
      status,
      path: text(input['filePath']) ?? text(input['path']) ?? name,
      createdAt,
    }
  }
  return {
    id,
    turnId,
    type: 'tool_call',
    status,
    text: `${name}\n${JSON.stringify(input)}${output ? `\n${output}` : ''}`,
    createdAt,
  }
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .flatMap((entry) => {
      const part = entry as Row | null
      return part?.['type'] === 'text' && text(part['text']) ? [text(part['text'])!] : []
    })
    .join('\n')
}

function transcriptEvents(session: ProviderHistorySession, turns: Turn[]): DomainEvent[] {
  if (!turns.length) return []
  const events: DomainEvent[] = [
    {
      type: 'thread.started',
      thread: {
        id: session.id,
        provider: 'opencode',
        workspacePath: session.workspacePath,
        title: session.title,
        createdAt: session.createdAt,
      },
    },
  ]
  for (const turn of turns) {
    events.push({
      type: 'turn.started',
      turn: { id: turn.id, threadId: session.id, status: 'running', createdAt: turn.createdAt },
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

function parsed(value: unknown): Row | undefined {
  try {
    const result: unknown = JSON.parse(text(value) ?? 'null')
    return result !== null && typeof result === 'object' ? (result as Row) : undefined
  } catch {
    return undefined
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined
}

function number(value: unknown): number | undefined {
  const parsedValue = typeof value === 'bigint' ? Number(value) : value
  return typeof parsedValue === 'number' && Number.isFinite(parsedValue) ? parsedValue : undefined
}
