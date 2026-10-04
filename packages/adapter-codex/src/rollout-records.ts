import { createReadStream } from 'node:fs'
import { object } from './history-values.js'

type JsonObject = Record<string, unknown>

const LINE_FEED = 0x0a
const PREFIX_BYTES = 256
// V8 cannot hold a longer string, so such a line could never be parsed.
const MAX_LINE_BYTES = 512 * 1024 * 1024
// Codex writes scalar fields such as the timestamp and ordinal, then the record
// type, then the payload with its own type first. Anything else is parsed.
const SCALAR_FIELD = String.raw`"[a-z_]+":(?:-?\d+(?:\.\d+)?|"[^"\\]*"|true|false|null),`
const RECORD_PREFIX = new RegExp(
  String.raw`^\{(?:${SCALAR_FIELD})*"type":"([a-z_]+)"(?:,(?:${SCALAR_FIELD})*"payload":\{"type":"([a-z_]+)")?`,
)
/** The record and event types `parseCodexHistory` reads. */
const TRANSCRIPT_RECORDS = new Set(['turn_context', 'event_msg', 'response_item'])
const TRANSCRIPT_EVENTS = new Set([
  'task_started',
  'task_complete',
  'turn_aborted',
  'task_failed',
  'item_completed',
  'user_message',
  'agent_message',
  'agent_reasoning',
])
const TURN_ENDS = new Set(['task_complete', 'turn_aborted', 'task_failed'])

/**
 * The rollout records the transcript parser reads, in order, each with its
 * position among all records. A long task's rollout holds hundreds of
 * megabytes of compaction snapshots and tool images, and each open or send
 * after a turn parsed all of it again. Records the parser ignores, and
 * response items of turns already in the local log, are skipped by their
 * prefix without being decoded.
 */
export async function transcriptRecords(
  file: string,
  localTurnIds?: ReadonlySet<string>,
): Promise<Array<{ index: number; record: JsonObject }>> {
  const records: Array<{ index: number; record: JsonObject }> = []
  const turns = currentTurn(localTurnIds)
  let index = 0
  const wanted = (prefix: string): boolean => {
    const match = RECORD_PREFIX.exec(prefix)
    if (!match) return true
    const [, type = '', payloadType] = match
    if (!TRANSCRIPT_RECORDS.has(type)) return false
    if (type === 'event_msg' && payloadType && !TRANSCRIPT_EVENTS.has(payloadType)) return false
    return !(type === 'response_item' && turns.isLocal())
  }
  const keep = (prefix: string): boolean => {
    if (wanted(prefix)) return true
    index += 1
    return false
  }
  try {
    for await (const line of rolloutLines(file, keep)) {
      const record = parseRecord(line)
      if (!record) continue
      records.push({ index: index++, record })
      turns.observe(record)
    }
  } catch {
    /* Missing and concurrently removed history files are normal. */
  }
  return records
}

/**
 * Follows `parseCodexHistory`'s current turn: response items join it, so they
 * belong to a local turn exactly when this reports one that has not ended.
 */
function currentTurn(localTurnIds: ReadonlySet<string> | undefined) {
  let current: string | undefined
  const ended = new Set<string>()
  return {
    isLocal: () =>
      current !== undefined && localTurnIds?.has(current) === true && !ended.has(current),
    observe(record: JsonObject): void {
      const payload = object(record.payload)
      const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : undefined
      const event = record.type === 'event_msg' ? String(payload.type) : undefined
      if (
        record.type === 'turn_context' ||
        event === 'task_started' ||
        event === 'item_completed'
      ) {
        if (turnId) current = turnId
      } else if (event !== undefined && TURN_ENDS.has(event)) {
        if (turnId) current = turnId
        if (current) ended.add(current)
      } else if (
        current !== undefined &&
        ended.has(current) &&
        (event === 'user_message' ||
          (record.type === 'response_item' &&
            payload.type === 'message' &&
            payload.role === 'user'))
      ) {
        current = undefined
      }
    },
  }
}

/**
 * Lines of a JSONL file whose first bytes `keep` accepts. A rejected line, or
 * one too long to ever decode, is never assembled; single rollout lines reach
 * hundreds of megabytes.
 */
async function* rolloutLines(
  file: string,
  keep: (prefix: string) => boolean,
): AsyncGenerator<Buffer> {
  let parts: Buffer[] = []
  let length = 0
  let kept: boolean | undefined
  const decide = () => {
    kept = keep(Buffer.concat(parts, Math.min(length, PREFIX_BYTES)).toString('latin1'))
  }
  const input = createReadStream(file, { highWaterMark: 1024 * 1024 })
  try {
    for await (const chunk of input) {
      if (!Buffer.isBuffer(chunk)) continue
      let start = 0
      while (start < chunk.length) {
        const newline = chunk.indexOf(LINE_FEED, start)
        const end = newline === -1 ? chunk.length : newline
        if (kept !== false) {
          parts.push(chunk.subarray(start, end))
          length += end - start
          if (kept === undefined && (length >= PREFIX_BYTES || newline !== -1)) decide()
          if (length > MAX_LINE_BYTES) kept = false
          if (kept === false) {
            parts = []
            length = 0
          }
        }
        if (newline === -1) break
        if (kept) yield parts.length === 1 ? parts[0]! : Buffer.concat(parts, length)
        parts = []
        length = 0
        kept = undefined
        start = newline + 1
      }
    }
    if (length > 0 && kept === undefined) decide()
    if (length > 0 && kept) yield Buffer.concat(parts, length)
  } finally {
    input.destroy()
  }
}

function parseRecord(line: Buffer): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(line.toString('utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as JsonObject)
      : undefined
  } catch {
    /* Partial trailing writes, malformed rows and oversized rows cannot hide the rest. */
    return undefined
  }
}
