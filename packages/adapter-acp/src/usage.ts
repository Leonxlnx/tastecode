import type { Usage } from '@harness/contracts'
import { z } from 'zod'

export const AcpTurnTokenUsageSchema = z.object({
  totalTokens: z.number().nullable().optional(),
  inputTokens: z.number().nullable().optional(),
  outputTokens: z.number().nullable().optional(),
  thoughtTokens: z.number().nullable().optional(),
  cachedReadTokens: z.number().nullable().optional(),
  cachedWriteTokens: z.number().nullable().optional(),
})

export const AcpSessionUsageUpdateSchema = z.object({
  used: z.number().optional(),
  size: z.number().optional(),
  cost: z
    .object({ amount: z.number().optional(), currency: z.string().optional() })
    .nullable()
    .optional(),
})

export type AcpTurnTokenUsage = z.infer<typeof AcpTurnTokenUsageSchema>
export type AcpSessionUsageUpdate = z.infer<typeof AcpSessionUsageUpdateSchema>

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
    ...(!(amount === undefined) ? { costUsd: amount } : {}),
  }
}

function token(value: number | null | undefined): number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined
}
