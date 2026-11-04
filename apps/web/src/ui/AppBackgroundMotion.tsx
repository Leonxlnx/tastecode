import { memo, useEffect, useRef } from 'react'
import type { AppBackgroundEffect } from '../app-background.js'
import { startEffectCanvas } from '../app-background-motion.js'

/**
 * An effect in motion: a canvas along the top of its .app-bg layer (see
 * app-background-motion.ts). It reports through `onDrawing` whether it draws,
 * so the still tile under it steps aside only then; `onDrawing` must keep its
 * identity (a state setter), or every report would restart the canvas.
 */
export const AppBackgroundMotion = memo(function AppBackgroundMotion(props: {
  effect: AppBackgroundEffect
  /** The window width a smaller canvas stands for (the Settings preview). */
  windowWidth?: number | undefined
  onDrawing: (drawing: boolean) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const { effect, windowWidth, onDrawing } = props
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const stop = startEffectCanvas(element, effect, {
      windowWidth,
      onLost: () => onDrawing(false),
    })
    onDrawing(stop !== undefined)
    return () => {
      stop?.()
      onDrawing(false)
    }
  }, [effect, windowWidth, onDrawing])
  return <canvas ref={canvas} className="app-bg__motion" aria-hidden />
})
