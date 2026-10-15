import type { ProviderId, ProviderStatus } from '@harness/contracts'

export type AttachmentSource = {
  provider: ProviderId
  agentId?: string | undefined
}

/**
 * Resolve attachment support from the effective source's own declaration.
 * Unknown sources fail closed; a custom harness does not expose its
 * capabilities to the renderer yet, so it is unknown rather than guessed.
 */
export function sourceSupportsAttachments(
  source: AttachmentSource,
  providers: ProviderStatus[],
): boolean {
  if (source.agentId) return false
  return (
    providers.find((provider) => provider.id === source.provider)?.capabilities?.images === true
  )
}
