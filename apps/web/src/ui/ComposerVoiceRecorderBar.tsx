import { useEffect, useRef, useState } from 'react'
import { ArrowUp, LoaderCircle, Square } from 'lucide-react'

const BAR_WIDTH_PX = 2
const BAR_GAP_PX = 2
const BAR_MIN_HEIGHT_PX = 3
const BAR_MAX_HEIGHT_PX = 22

export function ComposerVoiceRecorderBar(props: {
  disabled?: boolean
  durationLabel: string
  isTranscribing: boolean
  waveformLevels: readonly number[]
  onCancel: () => void
  onSubmit: () => void
}) {
  const track = useRef<HTMLDivElement>(null)
  const [visibleBarCount, setVisibleBarCount] = useState(96)

  useEffect(() => {
    const node = track.current
    if (!node) return
    const computeVisibleBars = () => {
      if (node.clientWidth <= 0) return
      setVisibleBarCount(Math.max(8, Math.floor(node.clientWidth / (BAR_WIDTH_PX + BAR_GAP_PX))))
    }
    computeVisibleBars()
    const observer = new ResizeObserver(computeVisibleBars)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const visibleLevels = props.waveformLevels.slice(-visibleBarCount)

  return (
    <div className={`composer-voice-bar ${props.isTranscribing ? 'is-transcribing' : ''}`}>
      <div ref={track} className="composer-voice-bar__track" aria-hidden="true">
        <span className="composer-voice-bar__centerline" />
        <span className="composer-voice-bar__levels">
          {visibleLevels.map((level, index) => {
            const clamped = Math.max(0.04, Math.min(1, level))
            const height = Math.round(
              BAR_MIN_HEIGHT_PX + clamped * (BAR_MAX_HEIGHT_PX - BAR_MIN_HEIGHT_PX),
            )
            return (
              <span
                key={visibleLevels.length - index}
                className="composer-voice-bar__level"
                style={{ width: BAR_WIDTH_PX, height }}
              />
            )
          })}
        </span>
      </div>

      <span className="composer-voice-bar__duration">{props.durationLabel}</span>

      <button
        type="button"
        className="composer-voice-bar__button composer-voice-bar__button--cancel"
        aria-label={props.isTranscribing ? 'Cancel transcription' : 'Cancel voice note'}
        title={props.isTranscribing ? 'Cancel transcription' : 'Cancel voice note'}
        disabled={props.disabled}
        onClick={props.onCancel}
      >
        {props.isTranscribing ? (
          <LoaderCircle className="spinner" size={12} aria-hidden />
        ) : (
          <Square size={11} fill="currentColor" strokeWidth={0} aria-hidden />
        )}
      </button>

      <button
        type="button"
        className="composer-voice-bar__button composer-voice-bar__button--submit"
        aria-label={props.isTranscribing ? 'Transcribing voice note' : 'Send voice note'}
        title={props.isTranscribing ? 'Transcribing voice note' : 'Send voice note'}
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
