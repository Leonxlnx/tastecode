import { describe, expect, it } from 'vitest'
import { CodexAdapter } from './adapter.js'
import {
  OpenAiVoiceTranscriber,
  OPENAI_TRANSCRIPTION_MODEL,
  OPENAI_TRANSCRIPTION_URL,
  MAX_VOICE_BYTES,
  validateVoiceClip,
  VoiceTranscriptionError,
  type VoiceTranscriptionInput,
} from './voice.js'

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

describe('OpenAiVoiceTranscriber', () => {
  it('uses an explicit OpenAI API key to transcribe the validated WAV', async () => {
    const requests: Array<{ audio: Buffer; apiKey: string }> = []
    const transcriber = new OpenAiVoiceTranscriber(async (audio, apiKey) => {
      requests.push({ audio, apiKey })
      return { status: 200, body: JSON.stringify({ text: '  hello from voice  ' }) }
    })

    await expect(transcriber.transcribe(voiceInput(1_000), 'openai-test-key')).resolves.toBe(
      'hello from voice',
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]?.audio.toString('ascii', 0, 4)).toBe('RIFF')
    expect(requests[0]?.apiKey).toBe('openai-test-key')
    expect(OPENAI_TRANSCRIPTION_URL).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(OPENAI_TRANSCRIPTION_MODEL).toBe('gpt-4o-mini-transcribe')
  })

  it('rejects an empty or header-unsafe API key without uploading audio', async () => {
    let uploaded = false
    const transcriber = new OpenAiVoiceTranscriber(async () => {
      uploaded = true
      return { status: 200, body: '{}' }
    })

    await expect(transcriber.transcribe(voiceInput(1_000), '  ')).rejects.toMatchObject({
      code: 'unsupported_auth',
    } satisfies Partial<VoiceTranscriptionError>)
    await expect(transcriber.transcribe(voiceInput(1_000), 'key\r\nunsafe')).rejects.toMatchObject({
      code: 'unsupported_auth',
    } satisfies Partial<VoiceTranscriptionError>)
    expect(uploaded).toBe(false)
  })

  it('surfaces an OpenAI authentication failure without retrying', async () => {
    let requests = 0
    const transcriber = new OpenAiVoiceTranscriber(async () => {
      requests += 1
      return { status: 401, body: JSON.stringify({ error: { message: 'Invalid API key.' } }) }
    })

    await expect(
      transcriber.transcribe(voiceInput(1_000), 'openai-test-key'),
    ).rejects.toMatchObject({ code: 'unsupported_auth', message: 'Invalid API key.' })
    expect(requests).toBe(1)
  })

  it('aborts an in-flight transcription request', async () => {
    const controller = new AbortController()
    const transcriber = new OpenAiVoiceTranscriber(async (_audio, _apiKey, signal) => {
      queueMicrotask(() => controller.abort())
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })
    const pending = transcriber.transcribe(voiceInput(1_000), 'openai-test-key', controller.signal)

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  })
})

it('keeps adapter voice unavailable until the server supplies an OpenAI key', async () => {
  const adapter = new CodexAdapter()

  await expect(adapter.voiceCapability()).resolves.toEqual({
    available: false,
    reason: 'unsupported_auth',
  })
  await expect(adapter.transcribeVoice(voiceInput(1_000))).rejects.toMatchObject({
    code: 'unsupported_auth',
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
