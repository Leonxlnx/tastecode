import {
  ProviderLimitSourceSchema,
  type ProviderId,
  type ProviderLimitSource,
} from '@harness/contracts'

type ReadyLimitSource = Extract<ProviderLimitSource, { status: 'ready' }>

const VERSION = 1

/**
 * Reads the plan limits the last session read in full, by provider. A value
 * a newer or older build shaped differently is skipped rather than shown:
 * losing it only costs a shown view its figures until the first read answers.
 */
export function parseLimitSnapshot(text: string | undefined): Map<ProviderId, ReadyLimitSource> {
  const saved = new Map<ProviderId, ReadyLimitSource>()
  if (!text) return saved
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return saved
  }
  if (!isRecord(value) || value['version'] !== VERSION || !Array.isArray(value['sources'])) {
    return saved
  }
  for (const entry of value['sources']) {
    const parsed = ProviderLimitSourceSchema.safeParse(entry)
    if (!parsed.success || parsed.data.status !== 'ready') continue
    saved.set(parsed.data.provider, parsed.data)
  }
  return saved
}

export function serializeLimitSnapshot(saved: ReadonlyMap<ProviderId, ReadyLimitSource>): string {
  return JSON.stringify({ version: VERSION, sources: [...saved.values()] })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
