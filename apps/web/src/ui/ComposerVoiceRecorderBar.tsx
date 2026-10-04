import {
  IconArrowUp as ArrowUp,
  IconLoader2 as LoaderCircle,
  IconPlayerStop as Square,
  IconMicrophone as Mic,
  IconX as X,
} from '@tabler/icons-react'
import { IconMorph } from './IconMorph.js'
import { VoiceWaveform } from './VoiceWaveform.js'

export function ComposerVoiceRecorderBar(props: {
  disabled?: boolean
  idle?: boolean
  onStart?: () => void
  durationLabel: string
  isTranscribing: boolean
  isStarting?: boolean
  waveformLevels: readonly number[]
  onCancel: () => void
  onStop: () => void
  onSubmit: () => void
}) {
  return (
    <div
      className={`composer-voice-bar ${props.idle ? 'is-idle' : ''} ${props.isTranscribing ? 'is-transcribing' : ''}`}
    >
      {!props.idle ? (
        <div className="composer-voice-bar__track">
          <VoiceWaveform
            levels={props.waveformLevels}
            active={!props.isStarting && !props.isTranscribing}
          />
        </div>
      ) : null}

      <span className="composer-voice-bar__duration" hidden={props.idle}>
        {props.isStarting
          ? 'Starting…'
          : props.isTranscribing
            ? 'Transcribing…'
            : props.durationLabel}
      </span>

      {!props.idle && !props.isTranscribing ? (
        <button
          type="button"
          className="composer-voice-bar__button composer-voice-bar__button--stop"
          aria-label="Discard voice note"
          title="Discard voice note"
          onClick={props.onCancel}
        >
          <IconMorph active={1} from={0}>
            <Mic size={15} aria-hidden />
            <X size={15} aria-hidden />
          </IconMorph>
        </button>
      ) : null}

      <button
        type="button"
        className={
          props.idle
            ? 'icon-btn icon-btn--always composer-voice-button'
            : 'composer-voice-bar__button composer-voice-bar__button--stop'
        }
        aria-label={
          props.idle
            ? 'Record voice note'
            : props.isTranscribing
              ? 'Cancel transcription'
              : 'Stop and transcribe voice note'
        }
        title={
          props.idle
            ? 'Dictate with Codex'
            : props.isTranscribing
              ? 'Cancel transcription'
              : 'Stop and transcribe'
        }
        disabled={props.isStarting || (props.disabled && !props.isTranscribing)}
        onClick={props.idle ? props.onStart : props.isTranscribing ? props.onCancel : props.onStop}
      >
        <IconMorph active={props.idle ? 0 : props.isTranscribing ? 2 : 1}>
          <Mic size={15} aria-hidden />
          <Square size={15} aria-hidden />
          <X size={15} aria-hidden />
        </IconMorph>
      </button>

      <button
        type="button"
        className="composer-voice-bar__button composer-voice-bar__button--submit"
        hidden={props.idle}
        aria-label={
          props.isTranscribing ? 'Transcribing voice note' : 'Transcribe and send voice note'
        }
        title={props.isTranscribing ? 'Transcribing voice note' : 'Transcribe and send'}
        disabled={props.disabled || props.isTranscribing || props.isStarting}
        onClick={props.onSubmit}
      >
        <IconMorph active={props.isTranscribing ? 1 : 0}>
          <ArrowUp size={15} aria-hidden />
          <LoaderCircle className="spinner" size={15} aria-hidden />
        </IconMorph>
      </button>
    </div>
  )
}
