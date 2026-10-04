import { describe, expect, it, vi } from 'vitest'
import { CodexVoiceTranscriber } from './account-voice.js'
import type { VoiceTranscriptionInput } from './voice.js'

function clip(): VoiceTranscriptionInput {
  const wav = Buffer.alloc(48_044)
  wav.write('RIFF')
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(24_000, 24)
  wav.writeUInt32LE(48_000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(48_000, 40)
  return {
    audioBase64: wav.toString('base64'),
    mimeType: 'audio/wav',
    sampleRateHz: 24_000,
    durationMs: 1_000,
  }
}

describe('Codex account dictation', () => {
  it('refreshes once after an expired account and returns only text', async () => {
    const auth = vi.fn().mockResolvedValueOnce('test-first').mockResolvedValueOnce('test-refreshed')
    const upload = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, body: '' })
      .mockResolvedValueOnce({ status: 200, body: '{"transcript":" hello "}' })
    await expect(new CodexVoiceTranscriber(auth, upload).transcribe(clip())).resolves.toBe('hello')
    expect(auth.mock.calls).toEqual([
      [false, undefined],
      [true, undefined],
    ])
    expect(upload).toHaveBeenCalledTimes(2)
    expect(upload.mock.calls[1]?.[1]).toBe('test-refreshed')
  })

  it('does not upload malformed audio or retry non-auth failures', async () => {
    const auth = vi.fn().mockResolvedValue('test-token')
    const upload = vi.fn().mockResolvedValue({ status: 429, body: 'private upstream details' })
    const client = new CodexVoiceTranscriber(auth, upload)
    await expect(client.transcribe({ ...clip(), durationMs: 20 })).rejects.toMatchObject({
      code: 'invalid_audio',
    })
    expect(auth).not.toHaveBeenCalled()
    await expect(client.transcribe(clip())).rejects.toMatchObject({
      message: 'Dictation failed (429). Try again.',
    })
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('does not leak upstream errors or upload after cancellation during auth', async () => {
    const controller = new AbortController()
    const upload = vi.fn()
    const client = new CodexVoiceTranscriber(async () => {
      controller.abort()
      return 'test-token'
    }, upload)
    await expect(client.transcribe(clip(), controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    })
    expect(upload).not.toHaveBeenCalled()
    const failing = new CodexVoiceTranscriber(async () => {
      throw new Error('private credential')
    }, upload)
    await expect(failing.transcribe(clip())).rejects.toMatchObject({
      message: 'Dictation could not connect. Check Codex sign-in and try again.',
    })
  })
})
