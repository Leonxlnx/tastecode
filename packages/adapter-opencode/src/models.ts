import type { Model } from '@harness/contracts'

/** One model a connected provider can run, as OpenCode lists it. */
export type OpenCodeCatalogEntry = {
  providerID: string
  providerName: string
  modelID: string
  name: string
  /** models.dev's release day, an ISO date. */
  releaseDate?: string | undefined
  isDefault: boolean
  reasoningEfforts: string[]
  defaultReasoningEffort?: string | undefined
}

/** The models of every connected provider, newest first. */
export function openCodeModels(entries: readonly OpenCodeCatalogEntry[]): Model[] {
  // An ISO date sorts as text. The sort is stable, so models of the same day
  // keep OpenCode's provider order.
  const ordered = [...entries].sort((left, right) =>
    (right.releaseDate ?? '').localeCompare(left.releaseDate ?? ''),
  )
  return ordered.map((entry) => ({
    id: `${entry.providerID}/${entry.modelID}`,
    displayName: `${entry.providerName} · ${entry.name}`,
    isDefault: entry.isDefault,
    reasoningEfforts: entry.reasoningEfforts,
    ...(entry.defaultReasoningEffort
      ? { defaultReasoningEffort: entry.defaultReasoningEffort }
      : {}),
    serviceTiers: [],
  }))
}
