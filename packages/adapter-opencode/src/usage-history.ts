import { DatabaseSync } from 'node:sqlite'
import type { LocalUsageRecord } from '@harness/contracts'

type UsageRow = {
  session_id: string
  time_created: number
  cost: number | null
  input_tokens: number | null
  cached_input_tokens: number | null
  cache_write_tokens: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
  model_id: string | null
  provider_id: string | null
}

/** Reads OpenCode's local message database without touching prompts or credentials. */
export async function readOpenCodeUsageHistory(filePath: string): Promise<LocalUsageRecord[]> {
  const database = new DatabaseSync(filePath, { readOnly: true, allowExtension: false })
  try {
    const rows = database
      .prepare(
        `SELECT session_id,
                time_created,
                json_extract(data, '$.cost') AS cost,
                json_extract(data, '$.tokens.input') AS input_tokens,
                json_extract(data, '$.tokens.cache.read') AS cached_input_tokens,
                json_extract(data, '$.tokens.cache.write') AS cache_write_tokens,
                json_extract(data, '$.tokens.output') AS output_tokens,
                json_extract(data, '$.tokens.reasoning') AS reasoning_tokens,
                json_extract(data, '$.modelID') AS model_id,
                json_extract(data, '$.providerID') AS provider_id
           FROM message
          WHERE json_valid(data)
            AND json_extract(data, '$.role') = 'assistant'
            AND json_type(data, '$.tokens') = 'object'`,
      )
      .all() as UsageRow[]

    const entries = new Map<string, LocalUsageRecord>()
    for (const row of rows) {
      const timestamp = dateValue(row.time_created)
      if (!timestamp || typeof row.session_id !== 'string' || !row.session_id) continue
      const inputTokens = tokenNumber(row.input_tokens)
      const cachedInputTokens = tokenNumber(row.cached_input_tokens)
      const cacheWriteTokens = tokenNumber(row.cache_write_tokens)
      const rawOutputTokens = tokenNumber(row.output_tokens)
      const reasoningTokens = tokenNumber(row.reasoning_tokens)
      const outputTokens = rawOutputTokens + reasoningTokens
      const providerReportedCostUsd = positiveNumber(row.cost)
      if (
        inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens <= 0 &&
        providerReportedCostUsd <= 0
      ) {
        continue
      }

      const modelId = stringValue(row.model_id)
      const providerId = stringValue(row.provider_id)
      const model =
        providerId && modelId ? `${providerId}/${modelId}` : (modelId ?? 'Unknown model')
      mergeUsageRecord(entries, {
        date: localDateKey(timestamp),
        model,
        sessionId: row.session_id,
        longContext: inputTokens + cachedInputTokens + cacheWriteTokens > 272_000,
        tokens: {
          uncachedInputTokens: inputTokens,
          cachedInputTokens,
          cacheWrite5mInputTokens: cacheWriteTokens,
          cacheWrite1hInputTokens: 0,
          outputTokens,
          reasoningTokens,
          providerReportedCostUsd,
        },
      })
    }
    return [...entries.values()]
  } finally {
    database.close()
  }
}

function mergeUsageRecord(entries: Map<string, LocalUsageRecord>, entry: LocalUsageRecord): void {
  const key = `${entry.date}\u0000${entry.model}\u0000${entry.sessionId}\u0000${entry.longContext}`
  const prior = entries.get(key)
  if (!prior) {
    entries.set(key, entry)
    return
  }
  prior.tokens.uncachedInputTokens += entry.tokens.uncachedInputTokens
  prior.tokens.cachedInputTokens += entry.tokens.cachedInputTokens
  prior.tokens.cacheWrite5mInputTokens += entry.tokens.cacheWrite5mInputTokens
  prior.tokens.outputTokens += entry.tokens.outputTokens
  prior.tokens.reasoningTokens += entry.tokens.reasoningTokens
  prior.tokens.providerReportedCostUsd += entry.tokens.providerReportedCostUsd
}

function dateValue(value: unknown): Date | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const date = new Date(value < 100_000_000_000 ? value * 1_000 : value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function tokenNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function positiveNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
