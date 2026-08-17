/**
 * Electron may omit `mediaTypes` for an audio-only request. Treat that as a
 * possible microphone request so macOS can show its system prompt, while an
 * explicit video request remains denied.
 */
export function allowsMicrophoneRequest(details: BoundaryValue): boolean {
  const parsed = MediaRequestSchema.safeParse(details)
  if (!parsed.success || !parsed.data.mediaTypes?.length) return true
  const mediaTypes = parsed.data.mediaTypes
  return mediaTypes.includes('audio') && !mediaTypes.includes('video')
}
import { z } from 'zod'
import type { BoundaryValue } from './boundary.js'

const MediaRequestSchema = z.object({ mediaTypes: z.array(z.string()).optional() })
