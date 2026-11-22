import { readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { LocalUsageRecord, ProviderId } from '@harness/contracts'
import {
  discoverFileArchive,
  usageArchiveFile,
  type UsageArchive,
  type UsageArchiveFile,
  type UsageHistorySource,
} from '@harness/proc/usage-archive'
import {
  readUsageLog,
  type UsageCheckpoint,
  type UsageLogParser,
  type UsageLogRead,
} from '@harness/proc/usage-log'

/** Prompt tokens above which xAI charges its long-context rate. */
const LONG_CONTEXT_TOKENS = 200_000

/**
 * The Grok CLI keeps each session's token counts, turn by turn, in
 * `<GROK_HOME>/sessions/<folder>/<session>/usage.json`. CLIs before those files
 * appended them to `<GROK_HOME>/logs/unified.jsonl` instead; 1.0.70 and later
 * no longer do at the default log level. A home whose sessions have usage files
 * is read from them alone, since a debug-level log can hold the same turns again.
 */
export const GROK_USAGE_HISTORY: UsageHistorySource<ProviderId, LocalUsageRecord> = {
  provider: 'grok',
  label: 'Grok',
  root: (home = process.env['GROK_HOME'] ?? path.join(os.homedir(), '.grok')) => home,
  discover: discoverGrokUsageHistory,
}

async function discoverGrokUsageHistory(home: string): Promise<UsageArchive<LocalUsageRecord>> {
  const sessions = await sessionUsageFiles(path.join(home, 'sessions'))
  if (sessions.length > 0) return { available: true, files: sessions }
  return discoverFileArchive(
    path.join(home, 'logs', 'unified.jsonl'),
    readGrokUsageHistory,
    resumeGrokUsageHistory,
  )
}

/** Every `usage.json` one level below a working-folder directory of the session store. */
async function sessionUsageFiles(
  sessionsRoot: string,
): Promise<UsageArchiveFile<LocalUsageRecord>[]> {
  const files: UsageArchiveFile<LocalUsageRecord>[] = []
  for (const folder of await directories(sessionsRoot)) {
    const sessions = await directories(path.join(sessionsRoot, folder))
    await Promise.all(
      sessions.map(async (session) => {
        try {
          const file = await usageArchiveFile(
            path.join(sessionsRoot, folder, session, 'usage.json'),
            readGrokSessionUsage,
          )
          if (file) files.push(file)
        } catch {
          // Most sessions without a usage file are ones nobody wrote in.
        }
      }),
    )
  }
  return files
}

async function directories(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * One session's `usage.json`: a row per turn and model. Its input count holds
 * the cached reads and its output count the reasoning, as the log's did once
 * added up (`totalTokens` is input plus output).
 */
export async function readGrokSessionUsage(filePath: string): Promise<LocalUsageRecord[]> {
  let usage: Record<string, unknown> | undefined
  try {
    usage = asRecord(JSON.parse(await readFile(filePath, 'utf8')))
  } catch (error) {
    // The CLI rewrites the file after each turn; a read mid-write waits for the next scan.
    if (error instanceof SyntaxError) return []
    throw error
  }
  const sessionId = stringValue(usage?.['sessionId']) ?? path.basename(path.dirname(filePath))
  const entries = new Map<string, LocalUsageRecord>()
  for (const value of Array.isArray(usage?.['turns']) ? usage['turns'] : []) {
    const turn = asRecord(value)
    const endedAt = dateValue(turn?.['endedAt'])
    if (!turn || !endedAt) continue
    const models = Object.entries(asRecord(turn['modelUsage']) ?? {})
    const slices: [string, Record<string, unknown> | undefined][] = models.length
      ? models.map(([model, counts]) => [model, asRecord(counts)])
      : [[stringValue(turn['primaryModelId']) ?? 'Unknown model', turn]]
    for (const [model, counts] of slices) {
      const inputTokens = integerValue(counts?.['inputTokens']) ?? 0
      const outputTokens = integerValue(counts?.['outputTokens']) ?? 0
      if (inputTokens + outputTokens <= 0) continue
      const cachedInputTokens = Math.min(
        integerValue(counts?.['cachedReadTokens']) ?? 0,
        inputTokens,
      )
      const modelCalls = Math.max(integerValue(counts?.['modelCalls']) ?? 1, 1)
      mergeUsageRecord(entries, {
        date: localDateKey(endedAt),
        model,
        sessionId,
        // A turn adds up its model calls; their average stands in for each call's prompt.
        longContext: inputTokens / modelCalls > LONG_CONTEXT_TOKENS,
        tokens: {
          uncachedInputTokens: inputTokens - cachedInputTokens,
          cachedInputTokens,
          cacheWrite5mInputTokens: 0,
          cacheWrite1hInputTokens: 0,
          outputTokens,
          reasoningTokens: Math.min(integerValue(counts?.['reasoningTokens']) ?? 0, outputTokens),
          providerReportedCostUsd: 0,
        },
      })
    }
  }
  return [...entries.values()]
}

/** Reads the Grok CLI's append-only local token log in one streaming pass. */
export async function readGrokUsageHistory(filePath: string): Promise<LocalUsageRecord[]> {
  return (await readUsageLog(filePath, GROK_LOG_PARSER)).entries
}

/**
 * Reads only what the log gained since the checkpoint of an earlier read. The
 * CLI rewrites the log from time to time; a rewritten log starts differently
 * and is read in full, so token rows it no longer holds drop out of the index.
 */
export function resumeGrokUsageHistory(
  filePath: string,
  checkpoint?: UsageCheckpoint,
): Promise<UsageLogRead<LocalUsageRecord>> {
  return readUsageLog(filePath, GROK_LOG_PARSER, checkpoint)
}

const SAVED_STATE_VERSION = 1

/** The token rows so far, and which model and session each CLI process is on. */
type GrokLogState = {
  entries: Map<string, LocalUsageRecord>
  modelByProcess: Map<number, string>
  sessionByProcess: Map<number, string>
}

/** What the next read needs: the model and session of every process seen so far. */
type SavedGrokState = {
  version: typeof SAVED_STATE_VERSION
  models: [processId: number, model: string][]
  sessions: [processId: number, sessionId: string][]
}

const GROK_LOG_PARSER: UsageLogParser<LocalUsageRecord, GrokLogState> = {
  create: () => ({ entries: new Map(), modelByProcess: new Map(), sessionByProcess: new Map() }),
  restore: (saved) =>
    isSavedGrokState(saved)
      ? {
          entries: new Map(),
          modelByProcess: new Map(saved.models),
          sessionByProcess: new Map(saved.sessions),
        }
      : undefined,
  line: parseGrokLine,
  finish: (state) => {
    const saved: SavedGrokState = {
      version: SAVED_STATE_VERSION,
      models: [...state.modelByProcess],
      sessions: [...state.sessionByProcess],
    }
    return { entries: [...state.entries.values()], saved }
  },
}

function isSavedGrokState(value: unknown): value is SavedGrokState {
  const saved = asRecord(value)
  return (
    saved?.['version'] === SAVED_STATE_VERSION &&
    isProcessPairs(saved['models']) &&
    isProcessPairs(saved['sessions'])
  )
}

function isProcessPairs(value: unknown): value is [number, string][] {
  return (
    Array.isArray(value) &&
    value.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        Number.isSafeInteger(pair[0]) &&
        typeof pair[1] === 'string',
    )
  )
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
