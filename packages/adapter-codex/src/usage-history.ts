import { createReadStream } from 'node:fs'
import readline from 'node:readline'
import type { LocalUsageRecord } from '@harness/contracts'

type CodexUsage = {
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
}

/** Reads Codex JSONL without exposing its cumulative wire format to the core. */
export async function readCodexUsageHistory(filePath: string): Promise<LocalUsageRecord[]> {
  const entries = new Map<string, LocalUsageRecord>()
  const legacySubagentEntries = new Map<string, LocalUsageRecord>()
  let sessionId = filePath
  let sawSessionMeta = false
  let replayingParentHistory = false
  let sawLegacySubagentBoundary = false
  let currentModel = 'Unknown model'
  let previous: CodexUsage | undefined
  const lines = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 }),
    crlfDelay: Infinity,
  })

  for await (const line of lines) {
    const tokenLine = line.includes('"token_count"')
    const contextLine =
      !tokenLine &&
      line.length < 2 * 1024 * 1024 &&
      (line.includes('"turn_context"') ||
        line.includes('"inter_agent_communication_metadata"') ||
        line.includes('"session_meta"') ||
        line.includes('"model"'))
    if (!tokenLine && !contextLine) continue

    const record = parseRecord(line)
    if (!record) continue
    const payload = asRecord(record['payload'])
    if (record['type'] === 'session_meta') {
      if (!sawSessionMeta) {
        sawSessionMeta = true
        const id = stringValue(payload?.['id']) ?? stringValue(record['session_id'])
        if (id) sessionId = id
        replayingParentHistory = isSubagentSession(payload)
      }
    }
    const model = extractModel(payload)
    if (model) currentModel = model
    if (replayingParentHistory && record['type'] === 'turn_context' && model) {
      sawLegacySubagentBoundary = true
    }
    if (replayingParentHistory && record['type'] === 'inter_agent_communication_metadata') {
      replayingParentHistory = false
      legacySubagentEntries.clear()
    }
    if (record['type'] !== 'event_msg' || payload?.['type'] !== 'token_count') continue

    const timestamp = dateValue(record['timestamp'])
    const info = asRecord(payload['info'])
    const total = normalizeUsage(asRecord(info?.['total_token_usage']))
    const last = normalizeUsage(asRecord(info?.['last_token_usage']))
    let delta: CodexUsage | undefined
    if (total) {
      delta = rolledBack(total, previous) ? (last ?? total) : subtractUsage(total, previous)
      previous = total
    } else if (last) {
      delta = last
      previous = addUsage(previous, last)
    }

    if (!timestamp || !delta || delta.totalTokens <= 0) continue

    const entry = {
      date: localDateKey(timestamp),
      model: model ?? currentModel,
      sessionId,
      longContext: delta.inputTokens > 272_000,
      tokens: {
        observedInputTokens: delta.inputTokens,
        uncachedInputTokens: Math.max(
          delta.inputTokens - delta.cachedInputTokens - delta.cacheWriteInputTokens,
          0,
        ),
        cachedInputTokens: delta.cachedInputTokens,
        cacheWrite5mInputTokens: delta.cacheWriteInputTokens,
        cacheWrite1hInputTokens: 0,
        outputTokens: delta.outputTokens,
        reasoningTokens: delta.reasoningTokens,
        processedTokens: delta.totalTokens,
        providerReportedCostUsd: 0,
      },
    }

    // A spawned subagent rollout starts with a copy of its parent's cumulative
    // snapshots. The communication metadata marks the first real child turn.
    // Retain the old turn-context heuristic only for rollouts without that marker.
    if (replayingParentHistory) {
      if (sawLegacySubagentBoundary) mergeUsageRecord(legacySubagentEntries, entry)
      continue
    }
    mergeUsageRecord(entries, entry)
  }
  if (replayingParentHistory && sawLegacySubagentBoundary) {
    for (const entry of legacySubagentEntries.values()) mergeUsageRecord(entries, entry)
  }
  return [...entries.values()]
}

function isSubagentSession(payload: Record<string, unknown> | undefined): boolean {
  const source = asRecord(payload?.['source'])
  return asRecord(source?.['subagent']) !== undefined
}

function normalizeUsage(value: Record<string, unknown> | undefined): CodexUsage | undefined {
  if (!value) return undefined
  const inputTokens = numberValue(value['input_tokens'])
  const outputTokens = numberValue(value['output_tokens'])
  const inputDetails = asRecord(value['input_tokens_details'])
  const reportedTotal = numberValue(value['total_tokens'])
  return {
    inputTokens,
    cachedInputTokens: numberValue(
      value['cached_input_tokens'] ??
        value['cache_read_input_tokens'] ??
        inputDetails?.['cached_tokens'],
    ),
    cacheWriteInputTokens: numberValue(
      value['cache_write_tokens'] ??
        value['cache_write_input_tokens'] ??
        inputDetails?.['cache_write_tokens'],
    ),
    outputTokens,
    reasoningTokens: numberValue(value['reasoning_output_tokens']),
    totalTokens: reportedTotal > 0 ? reportedTotal : inputTokens + outputTokens,
  }
}

function rolledBack(current: CodexUsage, previous: CodexUsage | undefined): boolean {
  if (!previous) return false
  return (
    current.inputTokens < previous.inputTokens ||
    current.cachedInputTokens < previous.cachedInputTokens ||
    current.cacheWriteInputTokens < previous.cacheWriteInputTokens ||
    current.outputTokens < previous.outputTokens ||
    current.reasoningTokens < previous.reasoningTokens ||
    current.totalTokens < previous.totalTokens
  )
}

function subtractUsage(current: CodexUsage, previous: CodexUsage | undefined): CodexUsage {
  return {
    inputTokens: Math.max(current.inputTokens - (previous?.inputTokens ?? 0), 0),
    cachedInputTokens: Math.max(current.cachedInputTokens - (previous?.cachedInputTokens ?? 0), 0),
    cacheWriteInputTokens: Math.max(
      current.cacheWriteInputTokens - (previous?.cacheWriteInputTokens ?? 0),
      0,
    ),
    outputTokens: Math.max(current.outputTokens - (previous?.outputTokens ?? 0), 0),
    reasoningTokens: Math.max(current.reasoningTokens - (previous?.reasoningTokens ?? 0), 0),
    totalTokens: Math.max(current.totalTokens - (previous?.totalTokens ?? 0), 0),
  }
}

function addUsage(previous: CodexUsage | undefined, delta: CodexUsage): CodexUsage {
  return {
    inputTokens: (previous?.inputTokens ?? 0) + delta.inputTokens,
    cachedInputTokens: (previous?.cachedInputTokens ?? 0) + delta.cachedInputTokens,
    cacheWriteInputTokens: (previous?.cacheWriteInputTokens ?? 0) + delta.cacheWriteInputTokens,
    outputTokens: (previous?.outputTokens ?? 0) + delta.outputTokens,
    reasoningTokens: (previous?.reasoningTokens ?? 0) + delta.reasoningTokens,
    totalTokens: (previous?.totalTokens ?? 0) + delta.totalTokens,
  }
}

function mergeUsageRecord(entries: Map<string, LocalUsageRecord>, entry: LocalUsageRecord): void {
  const key = `${entry.date}\u0000${entry.model}\u0000${entry.sessionId}\u0000${entry.longContext}`
  const prior = entries.get(key)
  if (!prior) {
    entries.set(key, entry)
    return
  }
  prior.tokens.processedTokens =
    (prior.tokens.processedTokens ?? 0) + (entry.tokens.processedTokens ?? 0)
  prior.tokens.observedInputTokens =
    (prior.tokens.observedInputTokens ?? 0) + (entry.tokens.observedInputTokens ?? 0)
  prior.tokens.uncachedInputTokens += entry.tokens.uncachedInputTokens
  prior.tokens.cachedInputTokens += entry.tokens.cachedInputTokens
  prior.tokens.cacheWrite5mInputTokens += entry.tokens.cacheWrite5mInputTokens
  prior.tokens.cacheWrite1hInputTokens += entry.tokens.cacheWrite1hInputTokens
  prior.tokens.outputTokens += entry.tokens.outputTokens
  prior.tokens.reasoningTokens += entry.tokens.reasoningTokens
  prior.tokens.providerReportedCostUsd += entry.tokens.providerReportedCostUsd
}

function extractModel(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined
  const info = asRecord(payload['info'])
  const metadata = asRecord(payload['metadata'])
  const infoMetadata = asRecord(info?.['metadata'])
  return (
    stringValue(payload['model']) ??
    stringValue(payload['model_name']) ??
    stringValue(info?.['model']) ??
    stringValue(info?.['model_name']) ??
    stringValue(infoMetadata?.['model']) ??
    stringValue(metadata?.['model'])
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
