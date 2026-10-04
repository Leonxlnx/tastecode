import { describe, expect, it, vi } from 'vitest'
import { VoiceService } from './voice.js'

const input = {
  requestId: 'f2fdef87-1235-455a-818f-e9636d5cf32d',
  provider: 'codex' as const,
  audioBase64: 'UklGRg==',
  mimeType: 'audio/wav' as const,
  sampleRateHz: 24_000 as const,
  durationMs: 1_000,
}

describe('VoiceService', () => {
  it('checks account availability without a connection or credential store', async () => {
    const status = vi.fn().mockResolvedValue({ available: true })
    const service = new VoiceService({ status, transcribe: vi.fn() })
    await expect(service.status('codex')).resolves.toEqual({ available: true })
    await expect(service.status('claude-code')).resolves.toEqual({
      available: false,
      reason: 'provider_unsupported',
    })
    expect(status).toHaveBeenCalledTimes(1)
  })

  it('passes only audio and cancellation to the adapter', async () => {
    const transcribe = vi.fn().mockResolvedValue('spoken words')
    const service = new VoiceService({ status: vi.fn(), transcribe })
    const controller = new AbortController()
    await expect(service.transcribe(input, controller.signal)).resolves.toBe('spoken words')
    const { requestId: _id, provider: _provider, ...audio } = input
    expect(transcribe).toHaveBeenCalledWith(audio, controller.signal)
    await expect(service.transcribe({ ...input, provider: 'claude-code' })).rejects.toThrow(
      'does not support',
    )
    controller.abort()
    await expect(service.transcribe(input, controller.signal)).rejects.toThrow()
    expect(transcribe).toHaveBeenCalledTimes(1)
  })
})
