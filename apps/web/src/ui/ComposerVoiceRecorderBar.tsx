import { ArrowUp, LoaderCircle, Square, X } from 'lucide-react'
import { DitherWaveform } from './dither-kit/DitherWaveform.js'

export function ComposerVoiceRecorderBar(props: {
  disabled?: boolean
  durationLabel: string
  isTranscribing: boolean
  waveformLevels: readonly number[]
  onCancel: () => void
  onStop: () => void
  onSubmit: () => void
}) {
  return (
    <div className={`composer-voice-bar ${props.isTranscribing ? 'is-transcribing' : ''}`}>
      <div className="composer-voice-bar__track">
        <DitherWaveform levels={props.waveformLevels} />
      </div>

      <span className="composer-voice-bar__duration">{props.durationLabel}</span>

      <button
        type="button"
        className="composer-voice-bar__button composer-voice-bar__button--stop"
        aria-label={
          props.isTranscribing ? 'Cancel transcription' : 'Stop and transcribe voice note'
        }
        title={props.isTranscribing ? 'Cancel transcription' : 'Stop and transcribe'}
        disabled={props.disabled}
        onClick={props.isTranscribing ? props.onCancel : props.onStop}
      >
        {props.isTranscribing ? (
          <X size={13} aria-hidden />
        ) : (
          <Square size={11} fill="currentColor" strokeWidth={0} aria-hidden />
        )}
      </button>

      <button
        type="button"
        className="composer-voice-bar__button composer-voice-bar__button--submit"
        aria-label={
          props.isTranscribing ? 'Transcribing voice note' : 'Transcribe and send voice note'
        }
        title={props.isTranscribing ? 'Transcribing voice note' : 'Transcribe and send'}
        disabled={props.disabled || props.isTranscribing}
        onClick={props.onSubmit}
      >
        {props.isTranscribing ? (
          <LoaderCircle className="spinner" size={12} aria-hidden />
        ) : (
          <ArrowUp size={13} strokeWidth={2.25} aria-hidden />
        )}
      </button>
    </div>
  )
}
