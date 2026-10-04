import { randomUUID } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { VoiceErrorResponseSchema, VoiceTranscriptResponseSchema } from './schemas.js'

export const VOICE_SAMPLE_RATE = 24_000
export const MAX_VOICE_DURATION_MS = 120_000
export const MAX_VOICE_BYTES = 10 * 1024 * 1024

const PCM_BYTES_PER_SAMPLE = 2
export const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions'
export const OPENAI_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe'
const TRANSCRIPTION_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 1024 * 1024

export type VoiceTranscriptionInput = {
  audioBase64: string
  mimeType: 'audio/wav'
  sampleRateHz: 24_000
  durationMs: number
}

export type VoiceHttpResponse = {
  status: number
  body: string
}

type RequestTranscription = (
  audio: Buffer,
  apiKey: string,
  signal?: AbortSignal,
) => Promise<VoiceHttpResponse>

export class VoiceTranscriptionError extends Error {
  constructor(
    readonly code:
      'invalid_audio' | 'unsupported_auth' | 'unsupported_codex' | 'cancelled' | 'upstream_failure',
    message: string,
  ) {
    super(message)
    this.name = 'VoiceTranscriptionError'
  }
}

export class OpenAiVoiceTranscriber {
  #requestTranscription: RequestTranscription

  constructor(requestVoiceTranscription: RequestTranscription = requestOpenAiTranscription) {
    this.#requestTranscription = requestVoiceTranscription
  }

  async transcribe(
    input: VoiceTranscriptionInput,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const wav = validateVoiceClip(input)
    if (signal?.aborted) throw cancelled()
    const credential = apiKey.trim()
    if (!credential || /[\r\n]/u.test(credential)) {
      throw new VoiceTranscriptionError(
        'unsupported_auth',
        'Voice transcription requires a valid OpenAI API key.',
      )
    }

    try {
      const response = await this.#requestTranscription(wav, credential, signal)
      if (response.status < 200 || response.status >= 300) {
        throw transcriptionError(response)
      }

      const text = readTranscript(response.body)
      if (!text) throw new VoiceTranscriptionError('upstream_failure', 'No speech was detected.')
      return text
    } catch (cause) {
      if (cause instanceof VoiceTranscriptionError) throw cause
      if (signal?.aborted) throw cancelled()
      throw new VoiceTranscriptionError(
        'upstream_failure',
        cause instanceof Error ? cause.message : 'Voice transcription failed.',
      )
    }
  }
}

export async function requestOpenAiTranscription(
  audio: Buffer,
  apiKey: string,
  signal?: AbortSignal,
  account = false,
): Promise<VoiceHttpResponse> {
  const boundary = `TasteCode-${randomUUID()}`
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
      'utf8',
    ),
    audio,
    Buffer.from(
      account
        ? `\r\n--${boundary}--\r\n`
        : `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${OPENAI_TRANSCRIPTION_MODEL}\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n--${boundary}--\r\n`,
      'utf8',
    ),
  ])
  const timeoutSignal = AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  return new Promise<VoiceHttpResponse>((resolve, reject) => {
    let settled = false
    const settle = (error: Error | null, response?: VoiceHttpResponse) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(response ?? { status: 0, body: '' })
    }
    const request = httpsRequest(
      account ? 'https://chatgpt.com/backend-api/transcribe' : OPENAI_TRANSCRIPTION_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.byteLength),
          Accept: 'application/json',
          ...(account ? { 'User-Agent': 'TasteCode/0.1.0' } : {}),
          'Accept-Encoding': 'identity',
        },
        signal: requestSignal,
      },
      (response) => {
        const declaredLength = Number(response.headers['content-length'])
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
          response.destroy()
          settle(
            new VoiceTranscriptionError(
              'upstream_failure',
              'Transcription response was too large.',
            ),
          )
          return
        }

        const chunks: Buffer[] = []
        let total = 0
        response.on('data', (chunk: Buffer) => {
          total += chunk.byteLength
          if (total > MAX_RESPONSE_BYTES) {
            response.destroy()
            settle(
              new VoiceTranscriptionError(
                'upstream_failure',
                'Transcription response was too large.',
              ),
            )
            return
          }
          chunks.push(chunk)
        })
        response.once('end', () => {
          settle(null, {
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks, total).toString('utf8'),
          })
        })
        response.once('error', (error) => settle(error))
      },
    )
    request.once('error', (error) => settle(error))
    request.end(body)
  })
}

function readTranscript(body: string): string | undefined {
  try {
    const payload = VoiceTranscriptResponseSchema.parse(JSON.parse(body))
    return payload.text.trim() || undefined
  } catch {
    throw new VoiceTranscriptionError(
      'upstream_failure',
      'The transcription response was not valid JSON.',
    )
  }
}

function transcriptionError(response: VoiceHttpResponse): VoiceTranscriptionError {
  let message = `Transcription failed with status ${response.status}.`
  try {
    const payload = VoiceErrorResponseSchema.parse(JSON.parse(response.body))
    const providerMessage = payload.error?.message ?? payload.message
    if (providerMessage?.trim()) message = providerMessage.trim()
  } catch {
    // Keep the status-based message when the provider body is empty or invalid.
  }
  if (response.status === 401 || response.status === 403) {
    return new VoiceTranscriptionError('unsupported_auth', message)
  }
  return new VoiceTranscriptionError('upstream_failure', message)
}

export function validateVoiceClip(input: VoiceTranscriptionInput): Buffer {
  if (input.mimeType !== 'audio/wav') {
    throw new VoiceTranscriptionError('invalid_audio', 'Only WAV audio is supported.')
  }
  if (input.sampleRateHz !== VOICE_SAMPLE_RATE) {
    throw new VoiceTranscriptionError('invalid_audio', 'Voice audio must be mono 24 kHz WAV.')
  }
  if (
    !Number.isInteger(input.durationMs) ||
    input.durationMs <= 0 ||
    input.durationMs > MAX_VOICE_DURATION_MS
  ) {
    throw new VoiceTranscriptionError(
      'invalid_audio',
      'Voice recordings are limited to 120 seconds.',
    )
  }
  if (input.audioBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.audioBase64)) {
    throw new VoiceTranscriptionError('invalid_audio', 'Voice audio is not valid base64.')
  }

  const wav = Buffer.from(input.audioBase64, 'base64')
  if (wav.length === 0 || wav.length > MAX_VOICE_BYTES) {
    throw new VoiceTranscriptionError('invalid_audio', 'Voice recordings are limited to 10 MB.')
  }
  if (
    wav.length < 44 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.readUInt32LE(4) !== wav.length - 8 ||
    wav.toString('ascii', 8, 12) !== 'WAVE' ||
    wav.toString('ascii', 12, 16) !== 'fmt ' ||
    wav.readUInt32LE(16) !== 16 ||
    wav.readUInt16LE(20) !== 1 ||
    wav.readUInt16LE(22) !== 1 ||
    wav.readUInt32LE(24) !== VOICE_SAMPLE_RATE ||
    wav.readUInt32LE(28) !== VOICE_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE ||
    wav.readUInt16LE(32) !== PCM_BYTES_PER_SAMPLE ||
    wav.readUInt16LE(34) !== 16 ||
    wav.toString('ascii', 36, 40) !== 'data'
  ) {
    throw new VoiceTranscriptionError('invalid_audio', 'Voice audio must be mono 24 kHz PCM WAV.')
  }

  const declaredDataBytes = wav.readUInt32LE(40)
  if (declaredDataBytes === 0 || declaredDataBytes !== wav.length - 44 || declaredDataBytes % 2) {
    throw new VoiceTranscriptionError('invalid_audio', 'Voice audio has an invalid WAV header.')
  }

  const expectedDurationMs = Math.round(
    (declaredDataBytes / PCM_BYTES_PER_SAMPLE / VOICE_SAMPLE_RATE) * 1_000,
  )
  if (Math.abs(expectedDurationMs - input.durationMs) > 250) {
    throw new VoiceTranscriptionError(
      'invalid_audio',
      'Voice duration does not match the WAV data.',
    )
  }
  return wav
}

function cancelled(): VoiceTranscriptionError {
  return new VoiceTranscriptionError('cancelled', 'Voice transcription was cancelled.')
}

export { CodexVoiceTranscriber } from './account-voice.js'
