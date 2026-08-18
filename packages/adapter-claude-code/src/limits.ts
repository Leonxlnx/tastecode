export type ProviderLimit = {
  label: string
  usedPercent: number
  resetsAt?: number | undefined
  valueLabel?: string | undefined
}

export type ClaudeLimitSource =
  { status: 'ready'; limits: ProviderLimit[] } | { status: 'unavailable' }

/**
 * Claude Code does not expose subscription limits through a supported CLI or
 * SDK surface. Keep the account panel honest instead of reading provider-owned
 * credentials or calling private billing endpoints.
 */
export async function claudeLimitSource(): Promise<ClaudeLimitSource> {
  return { status: 'unavailable' }
}
