import type { ModelConnection, ProviderId, ProviderStatus } from '@harness/contracts'

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
  connections: ModelConnection[],
): boolean {
  if (source.connectionId) {
    return (
      connections.find((connection) => connection.id === source.connectionId)?.capabilities
        ?.images === true
    )
  }
  if (source.agentId) return false
  return (
    providers.find((provider) => provider.id === source.provider)?.capabilities?.images === true
  )
}
