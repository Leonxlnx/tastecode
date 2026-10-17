import os from 'node:os'
import path from 'node:path'
import type { LocalUsageRecord, ProviderId } from '@harness/contracts'
import { discoverFileArchive, type UsageHistorySource } from '@harness/proc/usage-archive'
import { readUsageLog, type UsageLogParser } from '@harness/proc/usage-log'

/** The Grok CLI appends every turn's token counts to `<GROK_HOME>/logs/unified.jsonl`. */
export const GROK_USAGE_HISTORY: UsageHistorySource<ProviderId, LocalUsageRecord> = {
  provider: 'grok',
  label: 'Grok',
  root: (home = process.env['GROK_HOME'] ?? path.join(os.homedir(), '.grok')) =>
    path.join(home, 'logs', 'unified.jsonl'),
  discover: (root) => discoverFileArchive(root, readGrokUsageHistory),
}

/** Reads the Grok CLI's append-only local token log in one streaming pass. */
export async function readGrokUsageHistory(filePath: string): Promise<LocalUsageRecord[]> {
  return (await readUsageLog(filePath, GROK_LOG_PARSER)).entries
}

/** The token rows so far, and which model and session each CLI process is on. */
type GrokLogState = {
  entries: Map<string, LocalUsageRecord>
  modelByProcess: Map<number, string>
  sessionByProcess: Map<number, string>
}

const GROK_LOG_PARSER: UsageLogParser<LocalUsageRecord, GrokLogState> = {
  create: () => ({ entries: new Map(), modelByProcess: new Map(), sessionByProcess: new Map() }),
  restore: () => undefined,
  line: parseGrokLine,
  finish: (state) => ({ entries: [...state.entries.values()] }),
}

function parseGrokLine(state: GrokLogState, line: string): void {
  if (
    !line.includes('inference_done') &&
    !line.includes('model') &&
    !line.includes('agent initialized')
  ) {
    return
  }
  const record = parseRecord(line)
  const message = stringValue(record?.['msg'])
  const context = asRecord(record?.['ctx']) ?? {}
  const processId = integerValue(record?.['pid'])
  if (!record || !message || processId === undefined) return

  if (message === 'agent initialized') {
    state.modelByProcess.delete(processId)
    const startedAt = dateValue(record['ts'])?.getTime()
    state.sessionByProcess.set(
      processId,
      startedAt === undefined
        ? `grok-process-${processId}`
        : `grok-process-${processId}-${startedAt}`,
    )
    return
  }

  const model = modelFromEvent(message, context)
  if (model) {
    state.modelByProcess.set(processId, model)
    return
  }
  if (message !== 'shell.turn.inference_done') return

  const timestamp = dateValue(record['ts'])
  const promptTokens = finiteNumber(context['prompt_tokens'])
  if (!timestamp || promptTokens === undefined) return
  const cachedInputTokens = Math.min(
    Math.max(integerValue(context['cached_prompt_tokens']) ?? 0, 0),
    promptTokens,
  )
  const completionTokens = Math.max(integerValue(context['completion_tokens']) ?? 0, 0)
  const reasoningTokens = Math.max(integerValue(context['reasoning_tokens']) ?? 0, 0)
  const outputTokens = completionTokens + reasoningTokens
  if (promptTokens + outputTokens <= 0) return

  mergeUsageRecord(state.entries, {
    date: localDateKey(timestamp),
    model: state.modelByProcess.get(processId) ?? 'Unknown model',
    // The log has no session id. A CLI process initialization is the
    // narrowest stable session boundary it does expose; the pid fallback
    // keeps older log versions useful when that event is absent.
    sessionId: state.sessionByProcess.get(processId) ?? `grok-process-${processId}`,
    longContext: promptTokens > 200_000,
    tokens: {
      uncachedInputTokens: Math.max(promptTokens - cachedInputTokens, 0),
      cachedInputTokens,
      cacheWrite5mInputTokens: 0,
      cacheWrite1hInputTokens: 0,
      outputTokens,
      reasoningTokens,
      providerReportedCostUsd: 0,
    },
  })
}

function modelFromEvent(message: string, context: Record<string, unknown>): string | undefined {
  if (message === 'model changed') return stringValue(context['model'])
  if (message === 'model catalog: notifying clients') {
    return stringValue(context['current_model_id'])
  }
  if (message === 'backend_search: model switch') {
    return (
      stringValue(context['model']) ??
      stringValue(context['current_model_id']) ??
      stringValue(context['model_id'])
    )
  }
  if (message === 'subagent model resolved') {
    return stringValue(context['model_id']) ?? stringValue(context['model'])
  }
  return undefined
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
  prior.tokens.outputTokens += entry.tokens.outputTokens
  prior.tokens.reasoningTokens += entry.tokens.reasoningTokens
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

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function integerValue(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number === undefined ? undefined : Math.floor(number)
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
