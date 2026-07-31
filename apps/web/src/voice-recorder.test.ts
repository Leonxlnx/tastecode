import { describe, expect, it } from 'vitest'
import {
  describeMicrophoneError,
  encodeMonoPcmWav,
  formatRecordingDuration,
  resampleLinear,
} from './voice-recorder.js'

describe('voice recorder utilities', () => {
  it('resamples capture audio to 24 kHz', () => {
    const input = Float32Array.from({ length: 48_000 }, (_, index) => index / 48_000)
    const output = resampleLinear(input, 48_000, 24_000)
    expect(output).toHaveLength(24_000)
    expect(output[12_000]).toBeCloseTo(0.5, 3)
  })

  it('writes a mono 16-bit PCM WAV header', () => {
    const wav = new DataView(encodeMonoPcmWav(new Float32Array(24_000), 24_000))
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...new Uint8Array(wav.buffer, offset, length))
    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 4)).toBe('WAVE')
    expect(wav.getUint16(22, true)).toBe(1)
    expect(wav.getUint32(24, true)).toBe(24_000)
    expect(wav.getUint16(34, true)).toBe(16)
    expect(wav.getUint32(40, true)).toBe(48_000)
  })

  it('formats duration and explains microphone denial', () => {
    expect(formatRecordingDuration(65_500)).toBe('1:05')
    const denied = new Error('Permission denied')
    denied.name = 'NotAllowedError'
    expect(describeMicrophoneError(denied)).toMatch(/Allow it/i)
  })
})
