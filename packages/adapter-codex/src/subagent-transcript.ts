import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { Item, ProviderHistorySession } from '@harness/contracts'
import { parseCodexHistory } from './history-transcript.js'
import { object, timestamp } from './history-values.js'
import { allowedFile, jsonLines, stateFiles } from './rollout-files.js'
import { transcriptRecords } from './rollout-records.js'

type JsonObject = Record<string, unknown>
type Header = {
  cwd: string
  createdAt: number
  /** The first record of the sub-agent's own history; the records before it copy its parent's. */
  start: number
  /** "/root/read_first_line": the sub-agent's place in the agent tree. */
  path: string | undefined
}

/** Codex names threads with UUIDs and ends each rollout's file name with one. */
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The header is the first record; a few more allow for a partial write before it. */
const HEADER_RECORDS = 4
/** Where recently read sub-agents' rollouts are, so re-reads while one runs skip the search. */
const located = new Map<string, string>()
const LOCATED_LIMIT = 64
/** "Message Type: NEW_TASK\nTask name: …\nSender: /root\nPayload:\n<the message>" */
const PAYLOAD_MARKER = 'Payload:\n'

/**
 * The conversation of a sub-agent Codex ran itself, from the rollout Codex
 * keeps for the sub-agent's own thread in `home`: the task its parent sent,
 * its work and its answer. A spawned sub-agent's rollout opens with a copy of
 * its parent's history up to the spawn, which is left out. Empty when Codex
 * keeps no rollout for it there.
 */
export async function readCodexSubagentTranscript(home: string, threadId: string): Promise<Item[]> {
  // The id names a file, so only the shape Codex gives its threads is looked up.
  if (!THREAD_ID.test(threadId)) return []
  const file = await rolloutFile(home, threadId)
  if (!file) return []
  const header = await readHeader(file, threadId)
  if (!header) return []
  const records = (await transcriptRecords(file)).flatMap(({ index, record }) => {
    const ordinal = typeof record.ordinal === 'number' ? record.ordinal : index
    if (ordinal < header.start) return []
    const own = ownRecord(record, header.path)
    return own ? [{ index, record: own }] : []
  })
  const session: ProviderHistorySession = {
    id: threadId,
    workspacePath: header.cwd,
    title: '',
    createdAt: header.createdAt,
    updatedAt: header.createdAt,
    revision: '',
  }
  return parseCodexHistory(records, session).flatMap((event) =>
    event.type === 'item.completed' ? [event.item] : [],
  )
}

async function rolloutFile(home: string, threadId: string): Promise<string | undefined> {
  const key = `${home}\0${threadId}`
  const known = located.get(key)
  if (known && (await allowedFile(home, known))) return known
  located.delete(key)
  const file = (await indexedRollout(home, threadId)) ?? (await searchedRollout(home, threadId))
  if (!file) return undefined
  if (located.size >= LOCATED_LIMIT) located.delete(located.keys().next().value!)
  located.set(key, file)
  return file
}

/** Codex's state index names each thread's rollout. */
async function indexedRollout(home: string, threadId: string): Promise<string | undefined> {
  for (const name of await stateFiles(home)) {
    let file: unknown
    let db: import('node:sqlite').DatabaseSync | undefined
    try {
      const { DatabaseSync } = await import('node:sqlite')
      db = new DatabaseSync(path.join(home, name), { readOnly: true })
      file = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(threadId)?.rollout_path
    } catch {
      /* An older, locked or unreadable index leaves the search through the folders. */
    } finally {
      db?.close()
    }
    if (typeof file === 'string' && (await allowedFile(home, file))) return file
  }
  return undefined
}

/** Without an index entry, the rollout is the one whose name ends with the thread's id. */
async function searchedRollout(home: string, threadId: string): Promise<string | undefined> {
  const suffix = `-${threadId.toLowerCase()}.jsonl`
  async function search(directory: string): Promise<string | undefined> {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return undefined
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name)
      if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) return file
    }
    // Codex files sessions by date, so the newest folders are searched first.
    const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    for (const name of folders.sort().reverse()) {
      const file = await search(path.join(directory, name))
      if (file) return file
    }
    return undefined
  }
  for (const folder of ['sessions', 'archived_sessions']) {
    const file = await search(path.join(home, folder))
    if (file && (await allowedFile(home, file))) return file
  }
  return undefined
}

async function readHeader(file: string, threadId: string): Promise<Header | undefined> {
  let scanned = 0
  for await (const record of jsonLines(file)) {
    if (++scanned > HEADER_RECORDS) break
    const payload = object(record.payload)
    if (record.type !== 'session_meta' || payload.id !== threadId) continue
    const spawn = object(object(object(payload.source).subagent).thread_spawn)
    const agentPath = payload.agent_path ?? spawn.agent_path
    const start = payload.subagent_history_start_ordinal
    return {
      cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
      createdAt: timestamp(payload.timestamp ?? record.timestamp, 0),
      start: typeof start === 'number' && Number.isInteger(start) && start > 0 ? start : 0,
      path: typeof agentPath === 'string' && agentPath ? agentPath : undefined,
    }
  }
  return undefined
}

/**
 * A record as the sub-agent's conversation shows it. Messages its parent sent
 * it are its prompts. Text the harness adds in the user's place, such as the
 * project instructions, is left out: here no user typed anything.
 */
function ownRecord(record: JsonObject, agentPath: string | undefined): JsonObject | undefined {
  if (record.type !== 'response_item') return record
  const payload = object(record.payload)
  if (payload.type === 'message' && payload.role === 'user') {
    return fromUser(payload) ? record : undefined
  }
  if (payload.type !== 'agent_message' || !agentPath) return record
  const parentPath = agentPath.slice(0, agentPath.lastIndexOf('/'))
  if (payload.recipient !== agentPath || !parentPath || payload.author !== parentPath) return record
  const task = messageText(payload.content)
  // Codex can keep the message itself encrypted; its plain notice row stays then.
  if (!task) return record
  return {
    ...record,
    payload: {
      type: 'message',
      ...(typeof payload.id === 'string' ? { id: payload.id } : {}),
      role: 'user',
      content: [{ type: 'input_text', text: task }],
    },
  }
}

/** Codex marks where each part of a prompt came from; parts from the user have `user`. */
function fromUser(payload: JsonObject): boolean {
  const parts = object(payload.internal_chat_message_metadata_passthrough).content_item_metadata
  if (!Array.isArray(parts) || parts.length === 0) return true
  return parts.some((part) => object(object(part).provenance).type === 'user')
}

function messageText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const text = content
    .map((part) => {
      const value = object(part)
      return value.type === 'input_text' && typeof value.text === 'string' ? value.text : ''
    })
    .join('')
  const marker = text.indexOf(PAYLOAD_MARKER)
  const body = (marker === -1 ? text : text.slice(marker + PAYLOAD_MARKER.length)).trim()
  return body || undefined
}
