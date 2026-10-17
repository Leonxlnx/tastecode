import os from 'node:os'
import path from 'node:path'
import type { LocalUsageRecord, ProviderId } from '@harness/contracts'
import { discoverJsonlArchive, type UsageHistorySource } from '@harness/proc/usage-archive'
import { readUsageLog, type UsageLogParser } from '@harness/proc/usage-log'

/** Claude Code keeps one JSONL transcript per session under `<config dir>/projects`. */
export const CLAUDE_USAGE_HISTORY: UsageHistorySource<ProviderId, LocalUsageRecord> = {
  provider: 'claude-code',
  label: 'Claude Code',
  root: (home = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude')) =>
    path.join(home, 'projects'),
  discover: (root) => discoverJsonlArchive(root, readClaudeUsageHistory),
}

/** Reads Claude Code JSONL and collapses its repeated message snapshots. */
export async function readClaudeUsageHistory(filePath: string): Promise<LocalUsageRecord[]> {
  return (await readUsageLog(filePath, CLAUDE_LOG_PARSER)).entries
}

/** Every message the transcript's lines so far carried usage for, by message id. */
type ClaudeLogState = {
  filePath: string
  messages: Map<string, LocalUsageRecord>
}

const CLAUDE_LOG_PARSER: UsageLogParser<LocalUsageRecord, ClaudeLogState> = {
  create: (filePath) => ({ filePath, messages: new Map() }),
  restore: () => undefined,
  line: parseClaudeLine,
  finish: (state) => ({
    entries: [...state.messages.values()].filter((entry) => processedTokens(entry) > 0),
  }),
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
