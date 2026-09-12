import { useCallback, useEffect, useRef, useState } from 'react'
import { canCaptureVoice, type VoiceRecording } from './voice-capability.js'

export type { VoiceRecording } from './voice-capability.js'

const VOICE_SAMPLE_RATE = 24_000
export const MAX_RECORDING_MS = 120_000
const BUFFER_SIZE = 4_096
const MAX_WAVEFORM_LEVELS = 160
const WAVEFORM_EMIT_INTERVAL_MS = 45

type RecorderRuntime = {
  audioContext: AudioContext
  source: MediaStreamAudioSourceNode
  processor: ScriptProcessorNode
  silentGain: GainNode
  stream: MediaStream
  chunks: Float32Array[]
  startedAt: number
}

type RecorderStart = {
  cancelled: boolean
  stream?: MediaStream
  audioContext?: AudioContext
}

async function releaseStart(start: RecorderStart): Promise<void> {
  const { stream, audioContext } = start
  delete start.stream
  delete start.audioContext
  for (const track of stream?.getTracks() ?? []) track.stop()
  await audioContext?.close().catch(() => undefined)
}

export function useVoiceRecorder() {
  const runtime = useRef<RecorderRuntime | null>(null)
  const mounted = useRef(true)
  /** Set synchronously, before the permission prompt can be awaited twice. */
  const starting = useRef<RecorderStart | undefined>(undefined)
  const timer = useRef<number | undefined>(undefined)
  const levelsRef = useRef<number[]>([])
  const lastLevelEmitAt = useRef(0)
  const [recording, setRecording] = useState(false)
  const [durationMs, setDurationMs] = useState(0)
  const [levels, setLevels] = useState<number[]>([])

  const teardown = useCallback(async () => {
    const pending = starting.current
    starting.current = undefined
    if (pending) pending.cancelled = true
    const releasedStart = pending ? releaseStart(pending) : undefined
    const current = runtime.current
    runtime.current = null
    if (timer.current !== undefined) window.clearInterval(timer.current)
    timer.current = undefined
    if (mounted.current) {
      setRecording(false)
      setDurationMs(0)
    }

    if (!current) {
      await releasedStart
      return undefined
    }
    current.processor.onaudioprocess = null
    current.source.disconnect()
    current.processor.disconnect()
    current.silentGain.disconnect()
    for (const track of current.stream.getTracks()) track.stop()
    await current.audioContext.close().catch(() => undefined)
    return current
  }, [])

  const start = useCallback(async () => {
    // `starting` as well as `runtime`: runtime is only assigned after the
    // permission prompt resolves, so two clicks inside that window both got
    // past a runtime-only guard and the first stream became unreachable —
    // microphone left live for the rest of the session.
    if (runtime.current || starting.current) throw new Error('Voice recording is already running.')
    if (!canCaptureVoice()) {
      throw new Error('Microphone recording is unavailable in this browser.')
    }
    const pending: RecorderStart = { cancelled: false }
    starting.current = pending

    let stream: MediaStream | undefined
    let audioContext: AudioContext | undefined
    let source: MediaStreamAudioSourceNode | undefined
    let processor: ScriptProcessorNode | undefined
    let silentGain: GainNode | undefined
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      pending.stream = stream
      if (pending.cancelled) throw new DOMException('Voice recording was cancelled.', 'AbortError')
      audioContext = new AudioContext()
      pending.audioContext = audioContext
      await audioContext.resume()
      if (pending.cancelled) throw new DOMException('Voice recording was cancelled.', 'AbortError')
      source = audioContext.createMediaStreamSource(stream)
      processor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1)
      silentGain = audioContext.createGain()
      silentGain.gain.value = 0

      const current: RecorderRuntime = {
        audioContext,
        source,
        processor,
        silentGain,
        stream,
        chunks: [],
        startedAt: performance.now(),
      }
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer
        const mono = new Float32Array(input.length)
        for (let channel = 0; channel < input.numberOfChannels; channel += 1) {
          const data = input.getChannelData(channel)
          for (let index = 0; index < data.length; index += 1) {
            mono[index] = (mono[index] ?? 0) + (data[index] ?? 0)
          }
        }
        const channels = Math.max(1, input.numberOfChannels)
        let squares = 0
        for (let index = 0; index < mono.length; index += 1) {
          const sample = (mono[index] ?? 0) / channels
          mono[index] = sample
          squares += sample * sample
        }
        current.chunks.push(mono)
        const level = Math.min(1, Math.sqrt(squares / Math.max(1, mono.length)) * 3.2)
        const now = performance.now()
        if (now - lastLevelEmitAt.current >= WAVEFORM_EMIT_INTERVAL_MS) {
          lastLevelEmitAt.current = now
          const next = [...levelsRef.current, level].slice(-MAX_WAVEFORM_LEVELS)
          levelsRef.current = next
          setLevels(next)
        }
      }
      source.connect(processor)
      processor.connect(silentGain)
      silentGain.connect(audioContext.destination)
      runtime.current = current
      delete pending.stream
      delete pending.audioContext
      levelsRef.current = []
      lastLevelEmitAt.current = 0
      setLevels([])
      setDurationMs(0)
      setRecording(true)
      timer.current = window.setInterval(() => {
        if (runtime.current) setDurationMs(performance.now() - runtime.current.startedAt)
      }, 200)
    } catch (error) {
      processor?.disconnect()
      source?.disconnect()
      silentGain?.disconnect()
      await releaseStart(pending)
      throw error
    } finally {
      if (starting.current === pending) starting.current = undefined
    }
  }, [])

  const stop = useCallback(async (): Promise<VoiceRecording | undefined> => {
    const current = await teardown()
    if (!current) return undefined
    const merged = mergeChunks(current.chunks)
    if (merged.length === 0) return undefined
    const bounded = merged.subarray(
      0,
      Math.min(
        merged.length,
        Math.floor(current.audioContext.sampleRate * (MAX_RECORDING_MS / 1_000)),
      ),
    )
    const resampled = resampleLinear(bounded, current.audioContext.sampleRate, VOICE_SAMPLE_RATE)
    if (resampled.length === 0) return undefined
    const wav = encodeMonoPcmWav(resampled, VOICE_SAMPLE_RATE)
    return {
      audioBase64: arrayBufferBase64(wav),
      mimeType: 'audio/wav',
      sampleRateHz: VOICE_SAMPLE_RATE,
      durationMs: Math.max(1, Math.round((resampled.length / VOICE_SAMPLE_RATE) * 1_000)),
    }
  }, [teardown])

  const cancel = useCallback(async () => {
    await teardown()
    levelsRef.current = []
    lastLevelEmitAt.current = 0
    if (mounted.current) setLevels([])
  }, [teardown])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      void teardown()
    }
  }, [teardown])
  return { recording, durationMs, levels, start, stop, cancel }
}

export function formatRecordingDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function describeMicrophoneError(error: unknown): string {
  if (!(error instanceof Error)) return 'The microphone could not be opened.'
  switch (error.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Microphone access was denied. Allow it in system or browser settings, then try again.'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone was found. Connect one and try again.'
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The microphone is busy. Close other audio apps and try again.'
    case 'SecurityError':
      return 'Microphone access is blocked in this environment.'
    default:
      return error.message.trim() || 'The microphone could not be opened.'
  }
}

export function resampleLinear(
  samples: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (!Number.isFinite(inputRate) || inputRate <= 0 || samples.length === 0) {
    return new Float32Array()
  }
  if (inputRate === outputRate) return samples.slice()
  const ratio = inputRate / outputRate
  const output = new Float32Array(Math.max(1, Math.round(samples.length / ratio)))
  for (let index = 0; index < output.length; index += 1) {
    const source = index * ratio
    const left = Math.floor(source)
    const right = Math.min(samples.length - 1, left + 1)
    const mix = source - left
    const a = samples[left] ?? 0
    output[index] = a + ((samples[right] ?? a) - a) * mix
  }
  return output
}

export function encodeMonoPcmWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2))
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0))
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 0x8000 : 0x7fff)), true)
  }
  return view.buffer
}

function mergeChunks(chunks: Float32Array[]): Float32Array {
  const merged = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index))
  }
}

function arrayBufferBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}
