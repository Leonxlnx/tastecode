import { useEffect, useRef, useState } from 'react'
import { Minus, Plus, RotateCcw } from 'lucide-react'
import { onAppZoomChange, setAppZoom } from '../bridge.js'

const HIDE_DELAY_MS = 3_000

export type ZoomHudServices = {
  onAppZoomChange: typeof onAppZoomChange
  setAppZoom: typeof setAppZoom
}

const defaultZoomHudServices: ZoomHudServices = { onAppZoomChange, setAppZoom }

export function ZoomHud(props: { services?: ZoomHudServices | undefined }) {
  const services = props.services ?? defaultZoomHudServices
  const [percent, setPercent] = useState<number>()
  const hideTimer = useRef<number | undefined>(undefined)

  const hideLater = () => {
    if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setPercent(undefined), HIDE_DELAY_MS)
  }

  useEffect(
    () =>
      services.onAppZoomChange((factor) => {
        setPercent(Math.round(factor * 100))
        hideLater()
      }),
    [services],
  )

  useEffect(
    () => () => {
      if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current)
    },
    [],
  )

  if (percent === undefined) return null

  return (
    <div
      className="zoom-hud"
      role="status"
      aria-label={`App zoom ${percent}%`}
      onPointerEnter={() => {
        if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current)
      }}
      onPointerLeave={hideLater}
    >
      <button type="button" aria-label="Zoom out" onClick={() => void services.setAppZoom('out')}>
        <Minus size={14} aria-hidden />
      </button>
      <output aria-live="polite">{percent}%</output>
      <button type="button" aria-label="Zoom in" onClick={() => void services.setAppZoom('in')}>
        <Plus size={14} aria-hidden />
      </button>
      <span className="zoom-hud__rule" aria-hidden />
      <button
        type="button"
        className="zoom-hud__reset"
        disabled={percent === 100}
        onClick={() => void services.setAppZoom('reset')}
      >
        <RotateCcw size={13} aria-hidden />
        Reset
      </button>
    </div>
  )
}
