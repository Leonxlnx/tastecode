import type { Usage } from '@harness/contracts'

export type AcpTurnTokenUsage = {
  totalTokens?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  thoughtTokens?: number | null
  cachedReadTokens?: number | null
  cachedWriteTokens?: number | null
}

export type AcpSessionUsageUpdate = {
  used?: number
  size?: number
  cost?: { amount?: number; currency?: string } | null
}

/** Maps the optional ACP end-turn usage extension onto TasteCode accounting. */
export function acpTurnUsage(
  value: AcpTurnTokenUsage | null | undefined,
  model?: string,
): Usage | undefined {
  if (!value) return undefined
  const input = token(value.inputTokens)
  const cachedRead = token(value.cachedReadTokens)
  const cachedWrite = token(value.cachedWriteTokens)
  const visibleOutput = token(value.outputTokens)
  const reasoning = token(value.thoughtTokens)
  const output = visibleOutput + reasoning
  const total = token(value.totalTokens) || input + output + cachedWrite
  if (total + cachedRead <= 0) return undefined
  return {
    ...(model ? { model } : {}),
    inputTokens: input,
    cachedInputTokens: cachedRead,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens: total,
    inputIncludesCached: true,
  }
}

/** Maps ACP's completed session context/cost update without treating context as spend. */
export function acpSessionUsage(value: AcpSessionUsageUpdate, model?: string): Usage | undefined {
  const used = token(value.used)
  const size = token(value.size)
  const amount =
    value.cost?.currency?.toUpperCase() === 'USD' ? positive(value.cost.amount) : undefined
  if (used <= 0 && size <= 0 && amount === undefined) return undefined
  return {
    ...(model ? { model } : {}),
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: used,
    cumulative: true,
    ...(size > 0 ? { contextWindow: size } : {}),
    ...(amount === undefined ? {} : { costUsd: amount }),
  }
}

function token(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
