/** Only an explicit audio-only request may reach the OS microphone prompt. */
export function allowsMicrophoneRequest(details: unknown): boolean {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return false
  const mediaTypes = (details as { mediaTypes?: unknown }).mediaTypes
  return Array.isArray(mediaTypes) && mediaTypes.length === 1 && mediaTypes[0] === 'audio'
}

export function isOwnRendererPermission(permission: string, mediaType?: unknown): boolean {
  return permission === 'local-fonts' || (permission === 'media' && mediaType === 'audio')
}

/**
 * Permission requests the app's own main-frame renderer may make. Element
 * fullscreen (the media viewer) only arrives as a request, so the
 * synchronous check path keeps answering through isOwnRendererPermission.
 */
export function allowsOwnRendererRequest(permission: string): boolean {
  return permission === 'fullscreen' || isOwnRendererPermission(permission)
}
