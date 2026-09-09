import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'

type BeamPhase = 'idle' | 'active' | 'fading'
type BeamStyle = CSSProperties & { '--beam-strength': number }
let designBeamStyles: Promise<unknown> | undefined

export function preloadDesignBeamStyles(): void {
  designBeamStyles ??= import('../styles/design-beam.css').catch((error: unknown) => {
    designBeamStyles = undefined
    throw error
  })
  void designBeamStyles.catch(() => undefined)
}

export function DesignBeam(props: {
  active: boolean
  className: string
  strength: number
  children: ReactNode
}) {
  const [phase, setPhase] = useState<BeamPhase>(props.active ? 'active' : 'idle')

  useEffect(() => {
    if (props.active) preloadDesignBeamStyles()
    setPhase((current) => (props.active ? 'active' : current === 'active' ? 'fading' : 'idle'))
  }, [props.active])

  const style: BeamStyle = { '--beam-strength': props.strength }
  return (
    <div
      className={props.className}
      data-active={phase === 'active' ? '' : undefined}
      data-fading={phase === 'fading' ? '' : undefined}
      style={style}
      onAnimationEnd={(event) => {
        if (event.animationName === 'composer-design-beam-fade-out') setPhase('idle')
      }}
    >
      {props.children}
      {phase === 'idle' ? null : <div data-beam-bloom />}
    </div>
  )
}
