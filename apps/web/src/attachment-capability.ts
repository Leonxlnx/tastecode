import type { ProviderId, ProviderStatus } from '@harness/contracts'

export type AttachmentSource = {
  provider: ProviderId
  connectionId?: string | undefined
  agentId?: string | undefined
}

/**
 * Resolve attachment support from the effective source's own declaration.
 * Unknown sources fail closed; ACP does not expose per-agent capabilities to
 * the renderer yet, so an agent-scoped source is unknown rather than guessed.
 */
export function sourceSupportsAttachments(
  source: AttachmentSource,
  providers: ProviderStatus[],
): boolean {
  if (source.connectionId || source.agentId) return false
  return (
    providers.find((provider) => provider.id === source.provider)?.capabilities?.images === true
  )
}
