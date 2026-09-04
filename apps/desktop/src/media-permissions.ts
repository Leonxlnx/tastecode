/**
 * Electron may omit `mediaTypes` for an audio-only request. Treat that as a
 * possible microphone request so macOS can show its system prompt, while an
 * explicit video request remains denied.
 */
export function allowsMicrophoneRequest(details: unknown): boolean {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return true
  const mediaTypes = (details as { mediaTypes?: unknown }).mediaTypes
  if (
    !Array.isArray(mediaTypes) ||
    mediaTypes.length === 0 ||
    !mediaTypes.every((type) => typeof type === 'string')
  ) {
    return true
  }
  return mediaTypes.includes('audio') && !mediaTypes.includes('video')
}

export function isOwnRendererPermission(permission: string): boolean {
  return permission === 'media' || permission === 'local-fonts'
}
