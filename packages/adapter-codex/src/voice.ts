import { randomUUID } from 'node:crypto'
import { request as httpsRequest } from 'node:https'

export const VOICE_SAMPLE_RATE = 24_000
export const MAX_VOICE_DURATION_MS = 120_000
export const MAX_VOICE_BYTES = 10 * 1024 * 1024

const PCM_BYTES_PER_SAMPLE = 2
const TRANSCRIPTION_URL = 'https://chatgpt.com/backend-api/transcribe'
const TRANSCRIPTION_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 1024 * 1024

export type VoiceTranscriptionInput = {
  audioBase64: string
  mimeType: 'audio/wav'
  sampleRateHz: 24_000
  durationMs: number
}

export type VoiceCapability = {
  available: boolean
  reason?: 'sign_in_required' | 'unsupported_auth' | 'codex_too_old'
}

type RpcCall = <T>(method: string, params: unknown) => Promise<T>

type VoiceHttpResponse = {
  status: number
  body: string
}

type RequestTranscription = (
  audio: Buffer,
  token: string,
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

export class CodexVoiceTranscriber {
  #call: RpcCall
  #requestTranscription: RequestTranscription

  constructor(
    call: RpcCall,
    requestVoiceTranscription: RequestTranscription = requestChatGptTranscription,
  ) {
    this.#call = call
    this.#requestTranscription = requestVoiceTranscription
  }

  async capability(): Promise<VoiceCapability> {
    let authMethod: string | null
    try {
      const response = await this.#call<{ authMethod: string | null }>('getAuthStatus', {
        includeToken: false,
        refreshToken: false,
      })
      authMethod = response.authMethod
    } catch {
      return { available: false, reason: 'codex_too_old' }
    }

    if (!authMethod) return { available: false, reason: 'sign_in_required' }
    return isChatGptAuth(authMethod)
      ? { available: true }
      : { available: false, reason: 'unsupported_auth' }
  }

  async transcribe(input: VoiceTranscriptionInput, signal?: AbortSignal): Promise<string> {
    const wav = validateVoiceClip(input)
    if (signal?.aborted) throw cancelled()

    try {
      let token = await this.#resolveToken(false)
      let response = await this.#requestTranscription(wav, token, signal)
      if (response.status === 401 || response.status === 403) {
        token = await this.#resolveToken(true)
        response = await this.#requestTranscription(wav, token, signal)
      }
      if (response.status < 200 || response.status >= 300) {
        throw transcriptionError(response)
      }

      const text = readTranscript(response.body)
      if (!text) throw new VoiceTranscriptionError('upstream_failure', 'No speech was detected.')
      return text
    } catch (error) {
      if (error instanceof VoiceTranscriptionError) throw error
      if (signal?.aborted) throw cancelled()
      throw new VoiceTranscriptionError(
        'upstream_failure',
        error instanceof Error ? error.message : 'Voice transcription failed.',
      )
    }
  }

  async #resolveToken(refreshToken: boolean): Promise<string> {
    const response = await this.#call<{
      authMethod: string | null
      authToken: string | null
    }>('getAuthStatus', {
      includeToken: true,
      refreshToken,
    })
    if (!isChatGptAuth(response.authMethod)) {
      throw new VoiceTranscriptionError(
        'unsupported_auth',
        'Voice transcription requires a ChatGPT-authenticated Codex session.',
      )
    }
    if (response.authToken) return response.authToken
    if (!refreshToken) return this.#resolveToken(true)
    throw new VoiceTranscriptionError(
      'unsupported_auth',
      'No ChatGPT session token is available. Sign in to ChatGPT in Codex.',
    )
  }
}

async function requestChatGptTranscription(
  audio: Buffer,
  token: string,
  signal?: AbortSignal,
): Promise<VoiceHttpResponse> {
  const boundary = `Harness-${randomUUID()}`
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
      'utf8',
    ),
    audio,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ])
  const timeoutSignal = AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  const accountId = chatGptAccountIdFromToken(token)
  return new Promise<VoiceHttpResponse>((resolve, reject) => {
    let settled = false
    const settle = (error: Error | null, response?: VoiceHttpResponse) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(response ?? { status: 0, body: '' })
    }
    const request = httpsRequest(
      TRANSCRIPTION_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(accountId ? { 'ChatGPT-Account-ID': accountId } : {}),
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.byteLength),
          'Accept-Encoding': 'identity',
          'User-Agent': 'Personal Harness',
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

export function chatGptAccountIdFromToken(token: string): string | undefined {
  try {
    const parts = token.split('.')
    if (parts.length !== 3 || !parts[1]) return undefined
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    const auth = payload['https://api.openai.com/auth']
    if (!auth || typeof auth !== 'object') return undefined
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id
    return typeof accountId === 'string' && accountId && !/[\r\n]/u.test(accountId)
      ? accountId
      : undefined
  } catch {
    return undefined
  }
}

function readTranscript(body: string): string | undefined {
  try {
    const payload = JSON.parse(body) as { text?: unknown; transcript?: unknown }
    const value = typeof payload.text === 'string' ? payload.text : payload.transcript
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
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
    const payload = JSON.parse(response.body) as {
      error?: { message?: unknown }
      message?: unknown
    }
    const providerMessage =
      typeof payload.error?.message === 'string'
        ? payload.error.message
        : typeof payload.message === 'string'
          ? payload.message
          : undefined
    if (providerMessage?.trim()) message = providerMessage.trim()
  } catch {
    // Keep the status-based message when the provider body is empty or invalid.
  }
  if (response.status === 401 || response.status === 403) {
    return new VoiceTranscriptionError('unsupported_auth', message)
  }
  return new VoiceTranscriptionError('upstream_failure', message)
}

function isChatGptAuth(authMethod: string | null): boolean {
  return authMethod === 'chatgpt' || authMethod === 'chatgptAuthTokens'
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
