import { z } from 'zod'
import {
  ProviderIdSchema,
  ProviderLimitSourceSchema,
  type ProviderId,
  type ProviderLimitSource,
} from '@harness/contracts'

type ReadyLimitSource = Extract<ProviderLimitSource, { status: 'ready' }>

/**
 * A provider's newest failed read, kept so the next launch answers a shown
 * view with that outcome at once and keeps its backoff instead of waiting
 * seconds for a vendor process that is likely to fail the same way.
 */
export type SavedLimitFailure = {
  /** The stable, bounded text clients were shown for it. */
  error: string
  /** Failed reads in a row, which set the backoff of the next one. */
  count: number
  /** How many of them missed their deadline. */
  timeouts: number
  /** When the server reads on its own again, in Unix milliseconds. */
  retryAt: number
}

const VERSION = 1

/**
 * Older builds read only `sources`, so failures ride along under their own
 * key without a version change.
 */
const SavedFailureSchema = z.object({
  provider: ProviderIdSchema,
  error: z.string().min(1).max(300),
  count: z.number().int().positive(),
  timeouts: z.number().int().nonnegative(),
  retryAt: z.number().int().nonnegative(),
})

/**
 * Reads the plan limits the last session read in full, by provider. A value
 * a newer or older build shaped differently is skipped rather than shown:
 * losing it only costs a shown view its figures until the first read answers.
 */
export function parseLimitSnapshot(text: string | undefined): Map<ProviderId, ReadyLimitSource> {
  const saved = new Map<ProviderId, ReadyLimitSource>()
  for (const entry of savedEntries(text, 'sources')) {
    const parsed = ProviderLimitSourceSchema.safeParse(entry)
    if (!parsed.success || parsed.data.status !== 'ready') continue
    saved.set(parsed.data.provider, parsed.data)
  }
  return saved
}

/** Reads each provider's newest failed read; a malformed entry is skipped. */
export function parseLimitFailures(text: string | undefined): Map<ProviderId, SavedLimitFailure> {
  const saved = new Map<ProviderId, SavedLimitFailure>()
  for (const entry of savedEntries(text, 'failures')) {
    const parsed = SavedFailureSchema.safeParse(entry)
    if (!parsed.success) continue
    const { provider, ...failure } = parsed.data
    saved.set(provider, failure)
  }
  return saved
}

export function serializeLimitSnapshot(
  saved: ReadonlyMap<ProviderId, ReadyLimitSource>,
  failures: ReadonlyMap<ProviderId, SavedLimitFailure> = new Map(),
): string {
  return JSON.stringify({
    version: VERSION,
    sources: [...saved.values()],
    ...(failures.size > 0
      ? { failures: [...failures].map(([provider, failure]) => ({ provider, ...failure })) }
      : {}),
  })
}

function savedEntries(text: string | undefined, key: 'sources' | 'failures'): unknown[] {
  if (!text) return []
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return []
  }
  if (!isRecord(value) || value['version'] !== VERSION || !Array.isArray(value['sources'])) {
    return []
  }
  const entries = value[key]
  return Array.isArray(entries) ? entries : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
