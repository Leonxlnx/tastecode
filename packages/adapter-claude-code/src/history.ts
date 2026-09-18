import { createReadStream } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
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

function metadata(
  rows: SavedRecord[],
  id: string,
  locator: string,
  revision: string,
  mtime: number,
  index: SavedRecord,
): ProviderHistorySession | undefined {
  const main = rows.filter(visible)
  const messages = main.filter((row) => row.type === 'user' || row.type === 'assistant')
  if (!messages.length) return undefined
  const workspacePath =
    string(main.findLast((row) => row.type === 'relocated')?.relocatedCwd) ??
    string(messages.find((row) => typeof row.cwd === 'string')?.cwd) ??
    string(index.projectPath)
  if (!workspacePath) return undefined
  const firstPrompt = messages.find(isPrompt)
  const promptText = firstPrompt
    ? contentBlocks(firstPrompt)
        .map((block) => string(block.text) ?? '')
        .join(' ')
    : ''
  const title =
    string(main.findLast((row) => typeof row.customTitle === 'string')?.customTitle) ??
    string(main.findLast((row) => typeof row.aiTitle === 'string')?.aiTitle) ??
    string(index.summary) ??
    string(index.firstPrompt) ??
    promptText
  return {
    id,
    locator,
    revision,
    workspacePath,
    title: title.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Claude Code conversation',
    createdAt: timestamp(messages[0]?.timestamp) ?? timestamp(index.created) ?? mtime,
    updatedAt: Math.max(mtime, timestamp(messages.at(-1)?.timestamp) ?? 0),
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
            // Reimport saved transcripts that previously exposed machine notifications.
            const revision = `2:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
            let cached = cache.get(locator)
            if (cached?.revision !== revision) {
              const id = file.name.slice(0, -6)
              cached = {
                revision,
                session: metadata(
                  await records(locator),
                  id,
                  locator,
                  revision,
                  info.mtimeMs,
                  byId.get(id) ?? {},
                ),
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
