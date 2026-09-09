export type VoiceRecording = {
  audioBase64: string
  mimeType: 'audio/wav'
  sampleRateHz: 24_000
  durationMs: number
}

export function canCaptureVoice(): boolean {
  return navigator.mediaDevices !== undefined && 'AudioContext' in globalThis
}
