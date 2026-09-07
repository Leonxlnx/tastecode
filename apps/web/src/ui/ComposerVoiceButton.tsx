import { IconLoader2 as LoaderCircle, IconMicrophone as Mic } from '@tabler/icons-react'
import { IconMorph } from './IconMorph.js'

export function ComposerVoiceButton(props: {
  disabled?: boolean
  isRecording: boolean
  isTranscribing: boolean
  durationLabel: string
  onClick: () => void
}) {
  const label = props.isTranscribing
    ? 'Transcribing voice note'
    : props.isRecording
      ? `Stop voice note (${props.durationLabel})`
      : 'Record voice note'

  return (
    <button
      type="button"
      className="icon-btn icon-btn--always composer-voice-button"
      disabled={props.disabled || props.isTranscribing}
      aria-label={label}
      onClick={props.onClick}
    >
      <IconMorph active={props.isTranscribing ? 1 : 0}>
        <Mic size={15} aria-hidden />
        <LoaderCircle className="spinner" size={15} aria-hidden />
      </IconMorph>
    </button>
  )
}
