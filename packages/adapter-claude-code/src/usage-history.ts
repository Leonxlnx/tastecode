import { createReadStream } from 'node:fs'
import readline from 'node:readline'
import type { LocalUsageRecord } from '@harness/contracts'

/** Reads Claude Code JSONL and collapses its repeated message snapshots. */
export async function readClaudeUsageHistory(filePath: string): Promise<LocalUsageRecord[]> {
  const messages = new Map<string, LocalUsageRecord>()
  const lines = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 }),
    crlfDelay: Infinity,
  })

  for await (const line of lines) {
    if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) continue
    const record = parseRecord(line)
    const message = asRecord(record?.['message'])
    const usage = asRecord(message?.['usage'])
    const timestamp = dateValue(record?.['timestamp'])
    if (!record || !message || !usage || !timestamp) continue

    const messageId =
      stringValue(message['id']) ??
      stringValue(record['uuid']) ??
      `${filePath}:${timestamp.getTime()}`
    const model = stringValue(message['model']) ?? 'Unknown model'
    const sessionId =
      stringValue(record['sessionId']) ?? stringValue(record['session_id']) ?? filePath
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
    const prior = messages.get(messageId)
    if (!prior) {
      messages.set(messageId, candidate)
      continue
    }
    prior.tokens = maxTokenCounts(prior.tokens, candidate.tokens)
    if (candidate.model !== 'Unknown model') prior.model = candidate.model
    prior.date = candidate.date
    prior.sessionId = candidate.sessionId
    prior.longContext = candidate.longContext
  }
  return [...messages.values()].filter((entry) => processedTokens(entry) > 0)
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
