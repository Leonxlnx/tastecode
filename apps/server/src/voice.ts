import type { VoiceTranscriptionInput } from '@harness/adapter-codex/voice'
import type { ParamsOf, ProviderId } from '@harness/contracts'

export type VoiceTranscriber = {
  status(): Promise<{ available: boolean; reason?: 'sign_in_required' }>
  transcribe(input: VoiceTranscriptionInput, signal?: AbortSignal): Promise<string>
}

/** The adapter owns account authorization; the server exchanges only audio and text. */
export class VoiceService {
  #starting: Promise<VoiceTranscriber> | undefined
  constructor(private transcriber?: VoiceTranscriber) {}

  async status(provider: ProviderId) {
    if (provider !== 'codex') return { available: false, reason: 'provider_unsupported' as const }
    return (await this.#get()).status()
  }

  async transcribe(input: ParamsOf<'voice.transcribe'>, signal?: AbortSignal): Promise<string> {
    if (input.provider !== 'codex') throw new Error('This provider does not support dictation.')
    signal?.throwIfAborted()
    return (await this.#get()).transcribe(
      {
        audioBase64: input.audioBase64,
        mimeType: input.mimeType,
        sampleRateHz: input.sampleRateHz,
        durationMs: input.durationMs,
      },
      signal,
    )
  }

  async #get(): Promise<VoiceTranscriber> {
    if (this.transcriber) return this.transcriber
    this.#starting ??= import('@harness/adapter-codex/voice').then(
      ({ CodexVoiceTranscriber }) => new CodexVoiceTranscriber(),
    )
    try {
      this.transcriber = await this.#starting
      return this.transcriber
    } finally {
      this.#starting = undefined
    }
  }
}
