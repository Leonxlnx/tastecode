import { LoaderCircle, Mic } from 'lucide-react'

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
      {props.isTranscribing ? (
        <LoaderCircle className="spinner" size={15} aria-hidden />
      ) : (
        <Mic size={15} aria-hidden />
      )}
    </button>
  )
}
