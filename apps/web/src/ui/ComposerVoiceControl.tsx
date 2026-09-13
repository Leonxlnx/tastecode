import { useEffect, useRef, useState } from 'react'
import {
  describeMicrophoneError,
  formatRecordingDuration,
  MAX_RECORDING_MS,
  useVoiceRecorder,
} from '../voice-recorder.js'
import type { VoiceRecording } from '../voice-capability.js'
import { ComposerVoiceRecorderBar } from './ComposerVoiceRecorderBar.js'
import '../styles/composer-voice-control.css'

export type ComposerVoiceState = 'idle' | 'starting' | 'recording' | 'transcribing'

export function ComposerVoiceControl(props: {
  disabled: boolean
  running: boolean
  getCursor: () => number
  onStateChange: (state: ComposerVoiceState) => void
  onError: (message: string | undefined) => void
  onTranscript: (transcript: string, cursor: number, sendAfter: boolean) => void
  onTranscribeVoice: (requestId: string, recording: VoiceRecording) => Promise<string>
  onCancelVoice: (requestId: string) => void
}) {
  const [state, setState] = useState<ComposerVoiceState>('idle')
  const stateRef = useRef<ComposerVoiceState>('idle')
  const recorder = useVoiceRecorder()
  const request = useRef<string | undefined>(undefined)
  const operation = useRef(0)
  const mounted = useRef(true)
  const cancelRequest = useRef(props.onCancelVoice)
  cancelRequest.current = props.onCancelVoice

  const updateState = (next: ComposerVoiceState) => {
    stateRef.current = next
    setState(next)
    props.onStateChange(next)
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      operation.current += 1
      void recorder.cancel()
      if (request.current) cancelRequest.current(request.current)
    }
  }, [recorder.cancel])

  const start = async () => {
    if (stateRef.current !== 'idle') return
    updateState('starting')
    const generation = operation.current + 1
    operation.current = generation
    props.onError(undefined)
    try {
      await recorder.start()
      if (mounted.current && operation.current === generation) updateState('recording')
    } catch (error) {
      if (mounted.current && operation.current === generation) {
        updateState('idle')
        props.onError(describeMicrophoneError(error))
      }
    }
  }

  const transcribe = async (sendAfter = false) => {
    if (stateRef.current !== 'recording') return
    const generation = operation.current
    const cursor = props.getCursor()
    updateState('transcribing')
    props.onError(undefined)
    const requestId = crypto.randomUUID()
    request.current = requestId
    try {
      const recording = await recorder.stop()
      if (!mounted.current || operation.current !== generation) return
      if (!recording) {
        props.onError('No audio was captured. Check the selected microphone and try again.')
        return
      }
      const transcript = await props.onTranscribeVoice(requestId, recording)
      if (mounted.current && operation.current === generation && request.current === requestId) {
        props.onTranscript(transcript, cursor, sendAfter)
      }
    } catch (error) {
      if (mounted.current && operation.current === generation && request.current === requestId) {
        props.onError(error instanceof Error ? error.message : 'Voice transcription failed.')
      }
    } finally {
      if (mounted.current && operation.current === generation && request.current === requestId) {
        request.current = undefined
        updateState('idle')
      }
    }
  }

  const cancel = () => {
    operation.current += 1
    if (request.current) {
      props.onCancelVoice(request.current)
      request.current = undefined
    }
    void recorder.cancel()
    props.onError(undefined)
    updateState('idle')
  }

  useEffect(() => {
    if (state === 'recording' && recorder.durationMs >= MAX_RECORDING_MS) {
      void transcribe()
    }
  }, [state, recorder.durationMs])

  useEffect(() => {
    if (state === 'idle') return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state])

  if (state === 'idle' && props.running) return null

  return (
    <ComposerVoiceRecorderBar
      idle={state === 'idle'}
      onStart={() => void start()}
      disabled={props.disabled || props.running}
      isStarting={state === 'starting'}
      isTranscribing={state === 'transcribing'}
      durationLabel={formatRecordingDuration(recorder.durationMs)}
      waveformLevels={recorder.levels}
      onCancel={cancel}
      onStop={() => void transcribe()}
      onSubmit={() => void transcribe(true)}
    />
  )
}
