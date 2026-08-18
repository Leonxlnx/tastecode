import {
  OpenAiVoiceTranscriber,
  VoiceTranscriptionError,
  type VoiceTranscriptionInput,
} from '@harness/adapter-codex'
import type { ParamsOf, ProviderId, StoredModelConnection } from '@harness/contracts'
import type { ModelConnectionStore } from './model-connections.js'

type VoiceStatus = {
  available: boolean
  reason?: 'provider_unsupported' | 'unsupported_auth'
}

export type VoiceTranscriber = {
  transcribe(input: VoiceTranscriptionInput, apiKey: string, signal?: AbortSignal): Promise<string>
}

/** Keeps OpenAI credentials in the server and outside provider CLI sessions. */
export class VoiceService {
  constructor(
    private readonly connections: ModelConnectionStore,
    private readonly readCredential: (reference: string) => string,
    private readonly transcriber: VoiceTranscriber = new OpenAiVoiceTranscriber(),
  ) {}

  status(provider: ProviderId): VoiceStatus {
    if (provider !== 'codex') return { available: false, reason: 'provider_unsupported' }
    return this.#connection()
      ? { available: true }
      : { available: false, reason: 'unsupported_auth' }
  }

  async transcribe(input: ParamsOf<'voice.transcribe'>, signal?: AbortSignal): Promise<string> {
    const connection = this.#connection()
    if (!connection) {
      throw new VoiceTranscriptionError(
        'unsupported_auth',
        'Add and enable an OpenAI API connection to use voice transcription.',
      )
    }

    let apiKey: string
    try {
      apiKey = this.readCredential(connection.credentialRef)
    } catch {
      throw new VoiceTranscriptionError(
        'unsupported_auth',
        'The OpenAI API key is unavailable. Save it again in Connections.',
      )
    }

    return this.transcriber.transcribe(
      {
        audioBase64: input.audioBase64,
        mimeType: input.mimeType,
        sampleRateHz: input.sampleRateHz,
        durationMs: input.durationMs,
      },
      apiKey,
      signal,
    )
  }

  #connection(): StoredModelConnection | undefined {
    const connection = this.connections
      .list()
      .find(
        (candidate) =>
          candidate.enabled &&
          candidate.credentialConfigured &&
          candidate.preset === 'openai' &&
          candidate.transport === 'openai-responses' &&
          isOfficialOpenAiEndpoint(candidate.baseUrl),
      )
    return connection ? this.connections.get(connection.id) : undefined
  }
}

function isOfficialOpenAiEndpoint(baseUrl: string): boolean {
  try {
    const endpoint = new URL(baseUrl)
    return (
      endpoint.protocol === 'https:' &&
      endpoint.hostname === 'api.openai.com' &&
      endpoint.port === '' &&
      endpoint.username === '' &&
      endpoint.password === ''
    )
  } catch {
    return false
  }
}
