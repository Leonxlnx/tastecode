/** Only an explicit audio-only request may reach the OS microphone prompt. */
export function allowsMicrophoneRequest(details: unknown): boolean {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return false
  const mediaTypes = (details as { mediaTypes?: unknown }).mediaTypes
  return Array.isArray(mediaTypes) && mediaTypes.length === 1 && mediaTypes[0] === 'audio'
}

export function isOwnRendererPermission(permission: string, mediaType?: unknown): boolean {
  return permission === 'local-fonts' || (permission === 'media' && mediaType === 'audio')
}
