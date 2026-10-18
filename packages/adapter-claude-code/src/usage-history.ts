import os from 'node:os'
import path from 'node:path'
import type { LocalUsageRecord, ProviderId } from '@harness/contracts'
import { discoverJsonlArchive, type UsageHistorySource } from '@harness/proc/usage-archive'
import {
  readUsageLog,
  type UsageCheckpoint,
  type UsageLogParser,
  type UsageLogRead,
} from '@harness/proc/usage-log'

/** Claude Code keeps one JSONL transcript per session under `<config dir>/projects`. */
export const CLAUDE_USAGE_HISTORY: UsageHistorySource<ProviderId, LocalUsageRecord> = {
  provider: 'claude-code',
  label: 'Claude Code',
  root: (home = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude')) =>
    path.join(home, 'projects'),
  discover: (root) => discoverJsonlArchive(root, readClaudeUsageHistory, resumeClaudeUsageHistory),
}

/** Reads Claude Code JSONL and collapses its repeated message snapshots. */
export async function readClaudeUsageHistory(filePath: string): Promise<LocalUsageRecord[]> {
  return (await readUsageLog(filePath, CLAUDE_LOG_PARSER)).entries
}

/** Reads only what a transcript gained since the checkpoint of an earlier read, when it can. */
export function resumeClaudeUsageHistory(
  filePath: string,
  checkpoint?: UsageCheckpoint,
): Promise<UsageLogRead<LocalUsageRecord>> {
  return readUsageLog(filePath, CLAUDE_LOG_PARSER, checkpoint)
}

/**
 * How many of the latest messages a checkpoint remembers. Claude Code writes
 * one line per content block, each repeating the message's usage so far; on
 * this machine's transcripts every repeat came within three messages of the
 * one before. A repeat further back than this would be counted twice.
 */
const RECENT_MESSAGES = 8
const SAVED_STATE_VERSION = 1

/** Every message the transcript's lines so far carried usage for, by message id. */
type ClaudeLogState = {
  filePath: string
  messages: Map<string, LocalUsageRecord>
  /** The latest message ids, oldest first. */
  recent: Set<string>
  /** After a restore: the latest messages as the earlier read counted them. */
  counted: Map<string, LocalUsageRecord>
}

/** A message as a checkpoint keeps it: id, then the record's fields in a fixed order. */
type SavedMessage = [
  id: string,
  date: string,
  model: string,
  sessionId: string,
  longContext: boolean,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  cacheWrite5mInputTokens: number,
  cacheWrite1hInputTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  providerReportedCostUsd: number,
]

type SavedClaudeState = { version: typeof SAVED_STATE_VERSION; recent: SavedMessage[] }

const CLAUDE_LOG_PARSER: UsageLogParser<LocalUsageRecord, ClaudeLogState> = {
  create: (filePath) => ({ filePath, messages: new Map(), recent: new Set(), counted: new Map() }),
  restore: (saved, filePath) => {
    if (!isSavedClaudeState(saved)) return undefined
    const state: ClaudeLogState = {
      filePath,
      messages: new Map(),
      recent: new Set(),
      counted: new Map(),
    }
    for (const message of saved.recent) {
      const [id] = message
      state.messages.set(id, savedRecord(message))
      state.recent.add(id)
      state.counted.set(id, savedRecord(message))
    }
    return state
  },
  line: parseClaudeLine,
  finish: (state) => {
    const entries: LocalUsageRecord[] = []
    for (const [id, entry] of state.messages) {
      if (processedTokens(entry) <= 0) continue
      const counted = state.counted.get(id)
      if (!counted || processedTokens(counted) <= 0) {
        entries.push(entry)
        continue
      }
      // A later snapshot of a counted message adds only what it grew by, as
      // long as it still belongs to the same day, model, session and pricing.
      if (attribution(entry) !== attribution(counted)) return undefined
      const growth = tokenGrowth(entry.tokens, counted.tokens)
      if (Object.values(growth).some((count) => count > 0))
        entries.push({ ...entry, tokens: growth })
    }
    const recent = [...state.recent].flatMap((id): SavedMessage[] => {
      const entry = state.messages.get(id)
      return entry ? [savedMessage(id, entry)] : []
    })
    const saved: SavedClaudeState = { version: SAVED_STATE_VERSION, recent }
    return { entries, saved }
  },
}

function attribution(entry: LocalUsageRecord): string {
  return [
    entry.date,
    entry.model,
    entry.sessionId,
    entry.longContext,
    entry.tokens.providerReportedCostUsd > 0,
  ].join('\u0000')
}

/** Snapshots only ever raise a count, so every difference is zero or more. */
function tokenGrowth(
  current: LocalUsageRecord['tokens'],
  counted: LocalUsageRecord['tokens'],
): LocalUsageRecord['tokens'] {
  return {
    uncachedInputTokens: current.uncachedInputTokens - counted.uncachedInputTokens,
    cachedInputTokens: current.cachedInputTokens - counted.cachedInputTokens,
    cacheWrite5mInputTokens: current.cacheWrite5mInputTokens - counted.cacheWrite5mInputTokens,
    cacheWrite1hInputTokens: current.cacheWrite1hInputTokens - counted.cacheWrite1hInputTokens,
    outputTokens: current.outputTokens - counted.outputTokens,
    reasoningTokens: current.reasoningTokens - counted.reasoningTokens,
    providerReportedCostUsd: current.providerReportedCostUsd - counted.providerReportedCostUsd,
  }
}

function savedMessage(id: string, entry: LocalUsageRecord): SavedMessage {
  const { tokens } = entry
  return [
    id,
    entry.date,
    entry.model,
    entry.sessionId,
    entry.longContext,
    tokens.uncachedInputTokens,
    tokens.cachedInputTokens,
    tokens.cacheWrite5mInputTokens,
    tokens.cacheWrite1hInputTokens,
    tokens.outputTokens,
    tokens.reasoningTokens,
    tokens.providerReportedCostUsd,
  ]
}

function savedRecord([, date, model, sessionId, longContext, ...counts]: SavedMessage) {
  const [
    uncachedInputTokens,
    cachedInputTokens,
    cacheWrite5mInputTokens,
    cacheWrite1hInputTokens,
    outputTokens,
    reasoningTokens,
    providerReportedCostUsd,
  ] = counts
  const record: LocalUsageRecord = {
    date,
    model,
    sessionId,
    longContext,
    tokens: {
      uncachedInputTokens,
      cachedInputTokens,
      cacheWrite5mInputTokens,
      cacheWrite1hInputTokens,
      outputTokens,
      reasoningTokens,
      providerReportedCostUsd,
    },
  }
  return record
}

function isSavedClaudeState(value: unknown): value is SavedClaudeState {
  const saved = asRecord(value)
  const recent = saved?.['recent']
  return (
    saved?.['version'] === SAVED_STATE_VERSION &&
    Array.isArray(recent) &&
    recent.length <= RECENT_MESSAGES &&
    recent.every(isSavedMessage)
  )
}

function isSavedMessage(value: unknown): value is SavedMessage {
  if (!Array.isArray(value) || value.length !== 12) return false
  const [id, date, model, sessionId, longContext, ...counts] = value as unknown[]
  return (
    typeof id === 'string' &&
    typeof date === 'string' &&
    typeof model === 'string' &&
    typeof sessionId === 'string' &&
    typeof longContext === 'boolean' &&
    counts.every((count) => typeof count === 'number' && Number.isFinite(count) && count >= 0)
  )
}

function parseClaudeLine(state: ClaudeLogState, line: string): void {
  if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) return
  const record = parseRecord(line)
  const message = asRecord(record?.['message'])
  const usage = asRecord(message?.['usage'])
  const timestamp = dateValue(record?.['timestamp'])
  if (!record || !message || !usage || !timestamp) return

  const messageId =
    stringValue(message['id']) ??
    stringValue(record['uuid']) ??
    `${state.filePath}:${timestamp.getTime()}`
  const model = stringValue(message['model']) ?? 'Unknown model'
  const sessionId =
    stringValue(record['sessionId']) ?? stringValue(record['session_id']) ?? state.filePath
  const cacheCreation = numberValue(usage['cache_creation_input_tokens'])
  const cacheCreationDetail = asRecord(usage['cache_creation'])
  const oneHour = numberValue(cacheCreationDetail?.['ephemeral_1h_input_tokens'])
  const reportedFiveMinutes = numberValue(cacheCreationDetail?.['ephemeral_5m_input_tokens'])
  const fiveMinutes = Math.max(
    reportedFiveMinutes + Math.max(cacheCreation - oneHour - reportedFiveMinutes, 0),
    0,
  )
  const inputTokens = numberValue(usage['input_tokens'])
  const cachedInputTokens = numberValue(usage['cache_read_input_tokens'])
  const candidate: LocalUsageRecord = {
    date: localDateKey(timestamp),
    model,
    sessionId,
    longContext: inputTokens + cachedInputTokens + cacheCreation > 272_000,
    tokens: {
      uncachedInputTokens: inputTokens,
      cachedInputTokens,
      cacheWrite5mInputTokens: fiveMinutes,
      cacheWrite1hInputTokens: oneHour,
      outputTokens: numberValue(usage['output_tokens']),
      reasoningTokens: numberValue(usage['reasoning_output_tokens']),
      providerReportedCostUsd: numberValue(
        usage['cost_usd'] ?? record['costUSD'] ?? record['cost_usd'],
      ),
    },
  }
  state.recent.delete(messageId)
  state.recent.add(messageId)
  if (state.recent.size > RECENT_MESSAGES) {
    for (const oldest of state.recent) {
      state.recent.delete(oldest)
      break
    }
  }
  const prior = state.messages.get(messageId)
  if (!prior) {
    state.messages.set(messageId, candidate)
    return
  }
  prior.tokens = maxTokenCounts(prior.tokens, candidate.tokens)
  if (candidate.model !== 'Unknown model') prior.model = candidate.model
  prior.date = candidate.date
  prior.sessionId = candidate.sessionId
  prior.longContext = candidate.longContext
}

function maxTokenCounts(
  left: LocalUsageRecord['tokens'],
  right: LocalUsageRecord['tokens'],
): LocalUsageRecord['tokens'] {
  return {
    uncachedInputTokens: Math.max(left.uncachedInputTokens, right.uncachedInputTokens),
    cachedInputTokens: Math.max(left.cachedInputTokens, right.cachedInputTokens),
    cacheWrite5mInputTokens: Math.max(left.cacheWrite5mInputTokens, right.cacheWrite5mInputTokens),
    cacheWrite1hInputTokens: Math.max(left.cacheWrite1hInputTokens, right.cacheWrite1hInputTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    reasoningTokens: Math.max(left.reasoningTokens, right.reasoningTokens),
    providerReportedCostUsd: Math.max(left.providerReportedCostUsd, right.providerReportedCostUsd),
  }
}

function processedTokens(entry: LocalUsageRecord): number {
  return (
    entry.tokens.uncachedInputTokens +
    entry.tokens.cachedInputTokens +
    entry.tokens.cacheWrite5mInputTokens +
    entry.tokens.cacheWrite1hInputTokens +
    entry.tokens.outputTokens
  )
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(line))
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function dateValue(value: unknown): Date | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
