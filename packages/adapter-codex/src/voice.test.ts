import { describe, expect, it } from 'vitest'
import {
  chatGptAccountIdFromToken,
  CodexVoiceTranscriber,
  MAX_VOICE_BYTES,
  validateVoiceClip,
  VoiceTranscriptionError,
  type VoiceTranscriptionInput,
} from './voice.js'

describe('chatGptAccountIdFromToken', () => {
  it('reads the account routing claim without accepting malformed tokens', () => {
    const payload = Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-123' },
      }),
    ).toString('base64url')

    expect(chatGptAccountIdFromToken(`header.${payload}.signature`)).toBe('workspace-123')
    expect(chatGptAccountIdFromToken('not-a-jwt')).toBeUndefined()
  })
})

describe('validateVoiceClip', () => {
  it('accepts a matching mono 24 kHz PCM WAV', () => {
    const input = voiceInput(1_000)
    const wav = validateVoiceClip(input)

    expect(wav.length).toBe(48_044)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
  })

  it('rejects forged declarations and malformed WAV headers', () => {
    expect(() => validateVoiceClip({ ...voiceInput(1_000), durationMs: 2_000 })).toThrow(
      /duration does not match/i,
    )

    const malformed = Buffer.from(voiceInput(1_000).audioBase64, 'base64')
    malformed.writeUInt32LE(48_000, 24)
    expect(() =>
      validateVoiceClip({ ...voiceInput(1_000), audioBase64: malformed.toString('base64') }),
    ).toThrow(/24 kHz/i)
  })

  it('rejects decoded payloads over 10 MB', () => {
    expect(() =>
      validateVoiceClip({
        ...voiceInput(1_000),
        audioBase64: Buffer.alloc(MAX_VOICE_BYTES + 1).toString('base64'),
      }),
    ).toThrow(/10 MB/i)
  })
})

describe('CodexVoiceTranscriber', () => {
  it('uses the Codex ChatGPT session to transcribe the validated WAV', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const call = async <T>(method: string, params: unknown): Promise<T> => {
      calls.push({ method, params })
      return {
        authMethod: 'chatgpt',
        authToken: 'voice-session',
      } as T
    }
    const requests: Array<{ audio: Buffer; token: string }> = []
    const transcriber = new CodexVoiceTranscriber(call, async (audio, token) => {
      requests.push({ audio, token })
      return { status: 200, body: JSON.stringify({ text: '  hello from voice  ' }) }
    })

    await expect(transcriber.transcribe(voiceInput(1_000))).resolves.toBe('hello from voice')
    expect(calls).toEqual([
      {
        method: 'getAuthStatus',
        params: { includeToken: true, refreshToken: false },
      },
    ])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.audio.toString('ascii', 0, 4)).toBe('RIFF')
    expect(requests[0]?.token).toBe('voice-session')
  })

  it('refreshes an expired session once before surfacing an auth failure', async () => {
    const refreshes: boolean[] = []
    const tokens: string[] = []
    const transcriber = new CodexVoiceTranscriber(
      async <T>(_method: string, params: unknown) => {
        const refresh = (params as { refreshToken: boolean }).refreshToken
        refreshes.push(refresh)
        return {
          authMethod: 'chatgpt',
          authToken: refresh ? 'fresh-session' : 'stale-session',
        } as T
      },
      async (_audio, token) => {
        tokens.push(token)
        return token === 'stale-session'
          ? { status: 401, body: '{}' }
          : { status: 200, body: JSON.stringify({ transcript: 'refreshed voice' }) }
      },
    )

    await expect(transcriber.transcribe(voiceInput(1_000))).resolves.toBe('refreshed voice')
    expect(refreshes).toEqual([false, true])
    expect(tokens).toEqual(['stale-session', 'fresh-session'])
  })

  it('gates non-ChatGPT auth without uploading audio', async () => {
    let uploaded = false
    const transcriber = new CodexVoiceTranscriber(
      async <T>() => {
        return { authMethod: 'apikey', authToken: null } as T
      },
      async () => {
        uploaded = true
        return { status: 200, body: '{}' }
      },
    )

    await expect(transcriber.transcribe(voiceInput(1_000))).rejects.toMatchObject({
      code: 'unsupported_auth',
    } satisfies Partial<VoiceTranscriptionError>)
    expect(uploaded).toBe(false)
  })

  it('aborts an in-flight transcription request', async () => {
    const controller = new AbortController()
    const transcriber = new CodexVoiceTranscriber(
      async <T>() => ({ authMethod: 'chatgpt', authToken: 'voice-session' }) as T,
      async (_audio, _token, signal) => {
        queueMicrotask(() => controller.abort())
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      },
    )
    const pending = transcriber.transcribe(voiceInput(1_000), controller.signal)

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  })
})

function voiceInput(durationMs: number): VoiceTranscriptionInput {
  const sampleCount = Math.round((durationMs / 1_000) * 24_000)
  const wav = Buffer.alloc(44 + sampleCount * 2)
  wav.write('RIFF', 0, 'ascii')
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(24_000, 24)
  wav.writeUInt32LE(48_000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36, 'ascii')
  wav.writeUInt32LE(sampleCount * 2, 40)
  return {
    audioBase64: wav.toString('base64'),
    mimeType: 'audio/wav',
    sampleRateHz: 24_000,
    durationMs,
  }
}
