import {
  IconArrowUp as ArrowUp,
  IconLoader2 as LoaderCircle,
  IconSquare as Square,
  IconX as X,
} from '@tabler/icons-react'
import { IconMorph } from './IconMorph.js'
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

      {!props.isTranscribing ? (
        <button
          type="button"
          className="composer-voice-bar__button composer-voice-bar__button--stop"
          aria-label="Discard voice note"
          title="Discard voice note"
          disabled={props.disabled}
          onClick={props.onCancel}
        >
          <X size={13} aria-hidden />
        </button>
      ) : null}

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
        <IconMorph active={props.isTranscribing ? 1 : 0}>
          <Square size={11} fill="currentColor" strokeWidth={0} aria-hidden />
          <X size={13} aria-hidden />
        </IconMorph>
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
        <IconMorph active={props.isTranscribing ? 1 : 0}>
          <ArrowUp size={13} strokeWidth={2.25} aria-hidden />
          <LoaderCircle className="spinner" size={12} aria-hidden />
        </IconMorph>
      </button>
    </div>
  )
}
