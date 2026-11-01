import type { ProviderId, ProviderStatus } from '@harness/contracts'

export type AttachmentSource = {
  provider: ProviderId
  connectionId?: string | undefined
  agentId?: string | undefined
  /** The selected model's own image declaration, when it makes one. */
  modelImages?: boolean | undefined
}

/**
 * Resolve attachment support from the effective source's own declaration.
 * Unknown sources fail closed. An engine that hands images over as files the
 * agent opens (`imageFiles`) takes them for every model; one that sends pixels
 * (`images`) takes them unless the selected model or agent says it cannot.
 */
export function sourceSupportsAttachments(
  source: AttachmentSource,
  providers: ProviderStatus[],
): boolean {
  if (source.connectionId) return false
  const capabilities = providers.find((provider) => provider.id === source.provider)?.capabilities
  if (!capabilities) return false
  if (capabilities.imageFiles === true) return true
  if (capabilities.images !== true) return false
  // An agent-scoped source sends pixels only when its own model row says it
  // can: an ACP agent negotiates image prompts itself.
  return source.agentId ? source.modelImages === true : source.modelImages !== false
}
