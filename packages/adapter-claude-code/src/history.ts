import { createReadStream } from 'node:fs'
import { open, readdir, readFile, realpath, stat, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import type {
  DomainEvent,
  Item,
  ProviderHistorySession,
  ProviderHistorySource,
} from '@harness/contracts'
import {
  contentBlocks,
  historyItems,
  isInterruptMarker,
  isPrompt,
  object,
  string,
  type SavedRecord,
} from './history-items.js'
import { toUsage } from './events.js'

export type ClaudeHistoryOptions = {
  /** Claude Code's config directory, containing projects/. Never reads credentials. */
  configDir?: string
}

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i
const LINE_FEED = 0x0a
// Rows that set a title or working directory from anywhere in a transcript. A quoted
// token matches a key or an exact value, never text inside a string: there the quotes
// are escaped. UTF-8 never encodes another character with these bytes.
const METADATA_TOKENS = ['"customTitle"', '"aiTitle"', '"relocated"'].map((token) =>
  Buffer.from(token, 'latin1'),
)
const TOKEN_OVERLAP = Math.max(...METADATA_TOKENS.map((token) => token.length)) - 1
// Transcripts are read in positioned chunks: whole files reached hundreds of megabytes
// and a cold listing read 3 GB, blocking the event loop for seconds. Every chunk is an
// await, so no synchronous multi-megabyte stretch remains.
const LINE_CHUNK_BYTES = 64 * 1024
const SCAN_CHUNK_BYTES = 1024 * 1024

function timestamp(value: unknown): number | undefined {
  const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(at) ? at : undefined
}

async function records(file: string): Promise<SavedRecord[]> {
  const rows: SavedRecord[] = []
  const stream = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      try {
        const row = object(JSON.parse(line))
        if (typeof row.type === 'string') rows.push(row)
      } catch {
        // Concurrent writes can leave the final record incomplete.
      }
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  return rows
}

function visible(row: SavedRecord): boolean {
  return (
    !row.isSidechain &&
    !row.teamName &&
    !row.isMeta &&
    object(row.origin).kind !== 'task-notification'
  )
}

function visibleMessage(row: SavedRecord | undefined): row is SavedRecord {
  return row !== undefined && visible(row) && (row.type === 'user' || row.type === 'assistant')
}

function parseRecord(line: string): SavedRecord | undefined {
  try {
    const row = object(JSON.parse(line))
    return typeof row.type === 'string' ? row : undefined
  } catch {
    // Concurrent writes can leave the final record incomplete.
    return undefined
  }
}

type Line = { start: number; end: number; bytes: Buffer }

async function readAt(handle: FileHandle, start: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length)
  const { bytesRead } = await handle.read(buffer, 0, length, start)
  return buffer.subarray(0, bytesRead)
}

function lineFeedBefore(chunk: Buffer, end: number): number {
  return end > 0 ? chunk.lastIndexOf(LINE_FEED, end - 1) : -1
}

/** Lines in [from, to), first to last. `from` starts a line and `to` follows a line feed. */
async function* linesForward(handle: FileHandle, from: number, to: number): AsyncGenerator<Line> {
  let pieces: Buffer[] = []
  let start = from
  for (let position = from; position < to;) {
    const chunk = await readAt(handle, position, Math.min(LINE_CHUNK_BYTES, to - position))
    if (!chunk.length) return
    let cursor = 0
    for (let newline = chunk.indexOf(LINE_FEED); newline !== -1;) {
      pieces.push(chunk.subarray(cursor, newline))
      yield { start, end: position + newline, bytes: Buffer.concat(pieces) }
      pieces = []
      cursor = newline + 1
      start = position + cursor
      newline = chunk.indexOf(LINE_FEED, cursor)
    }
    if (cursor < chunk.length) pieces.push(chunk.subarray(cursor))
    position += chunk.length
  }
}

/** Lines in [from, to), last to first. `from` starts a line and `to` follows a line feed. */
async function* linesBackward(handle: FileHandle, from: number, to: number): AsyncGenerator<Line> {
  let pieces: Buffer[] = []
  let end = to - 1
  for (let position = end; position > from;) {
    const start = Math.max(from, position - LINE_CHUNK_BYTES)
    const chunk = await readAt(handle, start, position - start)
    if (chunk.length < position - start) return
    let cursor = chunk.length
    for (let newline = lineFeedBefore(chunk, cursor); newline !== -1;) {
      pieces.unshift(chunk.subarray(newline + 1, cursor))
      yield { start: start + newline + 1, end, bytes: Buffer.concat(pieces) }
      pieces = []
      end = start + newline
      cursor = newline
      newline = lineFeedBefore(chunk, cursor)
    }
    if (cursor) pieces.unshift(chunk.subarray(0, cursor))
    position = start
  }
  if (end > from) yield { start: from, end, bytes: Buffer.concat(pieces) }
}

/** The offset after the last line feed in [from, size), or `from` when there is none. */
async function completeEnd(handle: FileHandle, from: number, size: number): Promise<number> {
  for (let position = size; position > from;) {
    const start = Math.max(from, position - LINE_CHUNK_BYTES)
    const newline = (await readAt(handle, start, position - start)).lastIndexOf(LINE_FEED)
    if (newline !== -1) return start + newline + 1
    position = start
  }
  return from
}

/**
 * Lines in [from, to) that hold a metadata token, as [start, end] pairs in file order.
 * Chunks overlap by a token's length, so a token split across two reads still counts.
 */
async function tokenLines(
  handle: FileHandle,
  from: number,
  to: number,
): Promise<Array<[number, number]>> {
  const lines: Array<[number, number]> = []
  const buffer = Buffer.allocUnsafe(TOKEN_OVERLAP + SCAN_CHUNK_BYTES)
  let kept = 0
  // Where the line that holds the byte after the last line feed seen so far starts.
  let lineStart = from
  // A matching line whose line feed is not read yet.
  let pending: number | undefined
  for (let position = from; position < to;) {
    const length = Math.min(SCAN_CHUNK_BYTES, to - position)
    const { bytesRead } = await handle.read(buffer, kept, length, position)
    if (!bytesRead) break
    const base = position - kept
    const window = buffer.subarray(0, kept + bytesRead)
    const pendingEnd = pending === undefined ? -1 : window.indexOf(LINE_FEED, kept)
    if (pending !== undefined && pendingEnd !== -1) {
      lines.push([pending, base + pendingEnd])
      pending = undefined
    }
    const hits: number[] = []
    for (const token of METADATA_TOKENS)
      for (let hit = window.indexOf(token); hit !== -1; hit = window.indexOf(token, hit + 1))
        if (hit + token.length > kept) hits.push(hit)
    for (const hit of hits.sort((left, right) => left - right)) {
      // Each line is searched once, so a line with many tokens costs no more than one.
      if (pending !== undefined || base + hit < (lines.at(-1)?.[1] ?? from)) continue
      const before = window.lastIndexOf(LINE_FEED, hit)
      const start = before === -1 ? lineStart : base + before + 1
      const after = window.indexOf(LINE_FEED, hit)
      if (after === -1) pending = start
      else lines.push([start, base + after])
    }
    const last = window.lastIndexOf(LINE_FEED)
    if (last !== -1) lineStart = base + last + 1
    kept = Math.min(TOKEN_OVERLAP, window.length)
    buffer.copyWithin(0, window.length - kept, window.length)
    position += bytesRead
  }
  return lines
}

function parseLine(bytes: Buffer): SavedRecord | undefined {
  return parseRecord(bytes.toString('utf8'))
}

/**
 * Fold a transcript's listing metadata from the rows that can change it: every row
 * through the first message with a working directory and the first prompt, the last
 * visible message, and every row that can set a title or relocate the session. A final
 * line without its line feed may still be in the middle of a write; it counts as it is.
 */
async function transcriptDigest(file: string, size: number): Promise<Digest> {
  const digest: Digest = { message: false }
  const handle = await open(file, 'r')
  try {
    const complete = await completeEnd(handle, 0, size)
    let headEnd: number | undefined
    for await (const line of linesForward(handle, 0, complete)) {
      const row = parseLine(line.bytes)
      if (row) observe(digest, row)
      if (digest.cwd !== undefined && digest.prompt !== undefined) {
        headEnd = line.end + 1
        break
      }
    }
    if (headEnd !== undefined) {
      // Rows a digest ignores are remembered as parsed but not kept: the walk back can
      // pass megabytes of subagent rows after the last visible message.
      const later = new Map<number, SavedRecord | undefined>()
      for await (const line of linesBackward(handle, headEnd, complete)) {
        const row = parseLine(line.bytes)
        later.set(line.start, row && visible(row) ? row : undefined)
        if (visibleMessage(row)) break
      }
      for (const [start, end] of await tokenLines(handle, headEnd, complete))
        if (!later.has(start)) later.set(start, parseLine(await readAt(handle, start, end - start)))
      for (const [, row] of [...later].sort(([left], [right]) => left - right))
        if (row) observe(digest, row)
    }
    if (complete < size) {
      const row = parseLine(await readAt(handle, complete, size - complete))
      if (row) observe(digest, row)
    }
  } finally {
    await handle.close()
  }
  return digest
}

function sdkRecord(row: SavedRecord): SavedRecord & { type: string } {
  const compactMetadata = object(row.compactMetadata)
  const preservedMessages = object(compactMetadata.preservedMessages)
  const preservedSegment = object(compactMetadata.preservedSegment)
  return {
    ...row,
    type: String(row.type),
    // Keep a malformed optional compaction field from hiding a valid conversation.
    compactMetadata: {
      ...(Array.isArray(preservedMessages.uuids) &&
      preservedMessages.uuids.every((id) => typeof id === 'string') &&
      typeof preservedMessages.anchorUuid === 'string'
        ? { preservedMessages }
        : {}),
      ...(typeof preservedSegment.headUuid === 'string' &&
      typeof preservedSegment.tailUuid === 'string' &&
      typeof preservedSegment.anchorUuid === 'string'
        ? { preservedSegment }
        : {}),
    },
  }
}

/** The SDK owns native branch selection and parallel tool-result sibling recovery. */
async function conversation(
  rows: SavedRecord[],
  session: ProviderHistorySession,
): Promise<SavedRecord[]> {
  const byId = new Map(
    rows.flatMap((row, index) =>
      typeof row.uuid === 'string' ? [[row.uuid, { row, index }] as const] : [],
    ),
  )
  const seen = new Set<string>()
  const result: SavedRecord[] = []
  const collect = async (prefix: SavedRecord[]): Promise<void> => {
    const messages = await getSessionMessages(session.id, {
      dir: session.workspacePath,
      includeSystemMessages: true,
      sessionStore: {
        load: async () => prefix.filter((row) => !row.isSidechain && !row.teamName).map(sdkRecord),
        append: async () => {
          throw new Error('Claude history is read-only')
        },
      },
    })
    for (const message of messages) {
      if (seen.has(message.uuid)) continue
      seen.add(message.uuid)
      const entry = byId.get(message.uuid)
      if (!entry) continue
      const row = entry.row
      if (row.type === 'system' && row.subtype === 'compact_boundary') {
        // A compacted model context is shorter than the conversation the user saw.
        // Recover the earlier visible chain, without replaying discarded branches.
        const parent = byId.get(string(row.logicalParentUuid) ?? '')
        const end = parent?.index ?? entry.index - 1
        if (end >= 0 && end < entry.index) await collect(rows.slice(0, end + 1))
      }
      if (visible(row) && !row.isCompactSummary) result.push(row)
    }
  }
  await collect(rows)
  return result
}

/**
 * What a listing needs from a transcript, folded from its rows in file order: the
 * first visible message, the first one with a working directory, the first prompt,
 * the last visible message, and the last relocation and titles. A fold keeps a few
 * strings instead of the rows, which can hold megabytes of tool output or images.
 */
type Digest = {
  message: boolean
  firstAt?: unknown
  lastAt?: unknown
  cwd?: string
  /** The first prompt, already shaped as a title. */
  prompt?: string
  relocatedCwd?: unknown
  customTitle?: string
  aiTitle?: string
}

function titleText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200)
}

function observe(digest: Digest, row: SavedRecord): void {
  if (!visible(row)) return
  if (row.type === 'user' || row.type === 'assistant') {
    if (!digest.message) digest.firstAt = row.timestamp
    digest.message = true
    digest.lastAt = row.timestamp
    if (digest.cwd === undefined && typeof row.cwd === 'string') digest.cwd = row.cwd
    if (digest.prompt === undefined && isPrompt(row))
      digest.prompt = titleText(
        contentBlocks(row)
          .map((block) => string(block.text) ?? '')
          .join(' '),
      )
  }
  if (row.type === 'relocated') digest.relocatedCwd = row.relocatedCwd
  if (typeof row.customTitle === 'string') digest.customTitle = row.customTitle
  if (typeof row.aiTitle === 'string') digest.aiTitle = row.aiTitle
}

function metadata(
  digest: Digest,
  id: string,
  locator: string,
  revision: string,
  mtime: number,
  index: SavedRecord,
): ProviderHistorySession | undefined {
  if (!digest.message) return undefined
  const workspacePath = string(digest.relocatedCwd) ?? digest.cwd ?? string(index.projectPath)
  if (!workspacePath) return undefined
  const named =
    digest.customTitle ?? digest.aiTitle ?? string(index.summary) ?? string(index.firstPrompt)
  return {
    id,
    locator,
    revision,
    workspacePath,
    title:
      (named === undefined ? (digest.prompt ?? '') : titleText(named)) ||
      'Claude Code conversation',
    createdAt: timestamp(digest.firstAt) ?? timestamp(index.created) ?? mtime,
    updatedAt: Math.max(mtime, timestamp(digest.lastAt) ?? 0),
  }
}

function eventsFor(rows: SavedRecord[], session: ProviderHistorySession): DomainEvent[] {
  const events: DomainEvent[] = [
    {
      type: 'thread.started',
      thread: {
        id: session.id,
        provider: 'claude-code',
        workspacePath: session.workspacePath,
        title: session.title,
        createdAt: session.createdAt,
      },
    },
  ]
  const tools = new Map<string, Item>()
  const usageByMessage = new Map<string, ReturnType<typeof toUsage>>()
  let turnId: string | undefined
  let lastAt = session.createdAt
  let completed = false
  let failed = false
  const finish = () => {
    if (!turnId) return
    for (const usage of usageByMessage.values())
      if (usage) events.push({ type: 'usage.updated', usage })
    usageByMessage.clear()
    events.push({
      type: 'turn.completed',
      turnId,
      status: failed ? 'failed' : completed ? 'completed' : 'interrupted',
      completedAt: lastAt,
    })
    turnId = undefined
  }
  for (const row of rows) {
    if (row.type !== 'user' && row.type !== 'assistant') continue
    const at = timestamp(row.timestamp) ?? lastAt
    if (isInterruptMarker(row)) {
      // A Stop ends the turn it interrupted instead of starting one of its own; a
      // tool result saved beside it still belongs to that turn.
      if (!turnId) continue
      completed = false
    }
    if (isPrompt(row)) finish()
    if (!turnId) {
      turnId = `${session.id}:${String(row.uuid)}`
      completed = false
      failed = false
      events.push({
        type: 'turn.started',
        turn: { id: turnId, threadId: session.id, status: 'running', createdAt: at },
      })
    }
    lastAt = at
    const message = object(row.message)
    if (row.type === 'assistant') {
      const usage = object(message.usage)
      const counts: Record<string, number> = {}
      for (const key of [
        'input_tokens',
        'output_tokens',
        'cache_read_input_tokens',
        'cache_creation_input_tokens',
      ]) {
        if (typeof usage[key] === 'number') counts[key] = usage[key]
      }
      if (Object.keys(counts).length)
        usageByMessage.set(string(message.id) ?? String(row.uuid), toUsage(counts))
      completed =
        message.stop_reason === 'end_turn' ||
        message.stop_reason === 'stop_sequence' ||
        message.stop_reason === 'max_tokens'
      failed ||= row.isApiErrorMessage === true
    }
    for (const item of historyItems(row, turnId, at, tools))
      events.push({ type: item.status === 'started' ? 'item.started' : 'item.completed', item })
  }
  finish()
  return events
}

export function createClaudeHistorySource(
  options: ClaudeHistoryOptions = {},
): ProviderHistorySource {
  const projects = path.resolve(
    options.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'),
    'projects',
  )
  const cache = new Map<string, { revision: string; session: ProviderHistorySession | undefined }>()
  const validLocator = async (locator: string): Promise<boolean> => {
    const relative = path.relative(projects, locator)
    if (
      path.isAbsolute(relative) ||
      relative.startsWith(`..${path.sep}`) ||
      relative === '..' ||
      relative.split(path.sep).length !== 2 ||
      !SESSION_FILE.test(path.basename(locator))
    )
      return false
    const [actualRoot, actualFile] = await Promise.all([realpath(projects), realpath(locator)])
    const actualRelative = path.relative(actualRoot, actualFile)
    return (
      !path.isAbsolute(actualRelative) &&
      actualRelative !== '..' &&
      !actualRelative.startsWith(`..${path.sep}`)
    )
  }
  return {
    resolveSessionId: (threadId) => (threadId.startsWith('claude-') ? threadId.slice(7) : threadId),
    async list() {
      const directories = await readdir(projects, { withFileTypes: true }).catch(() => [])
      const sessions = new Map<string, ProviderHistorySession>()
      const present = new Set<string>()
      for (const directory of directories) {
        if (!directory.isDirectory()) continue
        const project = path.join(projects, directory.name)
        const files = await readdir(project, { withFileTypes: true }).catch(() => [])
        let entries: SavedRecord[] = []
        try {
          const index = object(
            JSON.parse(await readFile(path.join(project, 'sessions-index.json'), 'utf8')),
          )
          if (Array.isArray(index.entries)) entries = index.entries.map(object)
        } catch {
          /* The index is optional and can be stale. Scan transcript files as well. */
        }
        const byId = new Map(entries.map((entry) => [string(entry.sessionId), entry]))
        for (const file of files) {
          if (!file.isFile() || !SESSION_FILE.test(file.name)) continue
          const locator = path.join(project, file.name)
          present.add(locator)
          try {
            const info = await stat(locator)
            // Reimport saved transcripts that previously exposed machine notifications
            // or Stop markers.
            const revision = `3:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
            let cached = cache.get(locator)
            if (cached?.revision !== revision) {
              const id = file.name.slice(0, -6)
              const digest = await transcriptDigest(locator, info.size)
              cached = {
                revision,
                session: metadata(digest, id, locator, revision, info.mtimeMs, byId.get(id) ?? {}),
              }
              cache.set(locator, cached)
            }
            const session = cached.session
            if (session && session.updatedAt >= (sessions.get(session.id)?.updatedAt ?? 0))
              sessions.set(session.id, session)
          } catch {
            /* One locked, removed or malformed transcript must not hide the others. */
          }
        }
      }
      for (const file of cache.keys()) if (!present.has(file)) cache.delete(file)
      return [...sessions.values()].sort(
        (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
      )
    },
    async read(session) {
      const locator = session.locator
      if (!locator || path.basename(locator) !== `${session.id}.jsonl`) return []
      if (!(await validLocator(locator).catch(() => false))) return []
      const rows = await records(locator)
      return eventsFor(await conversation(rows, session), session)
    },
    dispose() {
      cache.clear()
    },
  }
}
