import { useEffect, useId, useRef } from 'react'

const WIDTH = 360
const HEIGHT = 28
const STEPS = 80

/** Paints between audio samples without making the composer render at frame rate. */
export function VoiceWaveform({ levels, active }: { levels: readonly number[]; active: boolean }) {
  const gradientId = useId().replaceAll(':', '')
  const paths = useRef<Array<SVGPathElement | null>>([])
  const input = useRef({ levels, active })
  input.current = { levels, active }

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    let previous = performance.now()
    let phase = 0
    let amplitude = 0

    const draw = (now: number) => {
      const delta = Math.min(50, now - previous)
      previous = now
      const current = input.current
      const recent = current.levels.slice(-4)
      const target =
        current.active && recent.length
          ? Math.min(
              1,
              Math.sqrt(recent.reduce((sum, value) => sum + value * value, 0) / recent.length) *
                2.4,
            )
          : 0
      // Fast attack follows speech; the longer release softens pauses.
      amplitude += (target - amplitude) * (1 - Math.exp(-delta / (target > amplitude ? 85 : 220)))
      phase += delta * 0.0018
      paths.current.forEach((path, layer) => {
        if (!path) return
        const top: number[] = []
        const bottom: number[] = []
        for (let index = 0; index <= STEPS; index += 1) {
          const x = index / STEPS
          const envelope = Math.sin(Math.PI * x) ** 1.8
          const energy = motion.matches ? 0 : amplitude * envelope
          const offset = Math.sin(x * Math.PI * 4 - phase + layer * 1.7) * energy * 2.5
          const fold = Math.sin(x * Math.PI * 2 + phase * 0.6 + layer * 1.8)
          const thickness = energy * (1.4 + fold * fold * (8.5 - layer * 1.5))
          top.push(HEIGHT / 2 + offset - thickness)
          bottom.push(HEIGHT / 2 + offset + thickness)
        }
        const d = `M 0 ${HEIGHT / 2}${ribbonEdge(top, false)}${ribbonEdge(bottom.reverse(), true)} Z`
        path.setAttribute('d', d)
      })
      if (!motion.matches) frame = requestAnimationFrame(draw)
    }
    const restart = () => {
      cancelAnimationFrame(frame)
      previous = performance.now()
      draw(previous)
    }
    restart()
    motion.addEventListener('change', restart)
    return () => {
      cancelAnimationFrame(frame)
      motion.removeEventListener('change', restart)
    }
  }, [])

  return (
    <svg
      className="composer-voice-wave"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="0"
          y1="0"
          x2="0"
          y2="1"
          gradientUnits="objectBoundingBox"
        >
          <stop offset="0" stopColor="#fff" stopOpacity="0.06" />
          <stop offset="0.48" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.06" />
        </linearGradient>
        <linearGradient id={`${gradientId}-edge`}>
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.48" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line
        x1="0"
        y1={HEIGHT / 2}
        x2={WIDTH}
        y2={HEIGHT / 2}
        stroke="#fff"
        strokeWidth={0.6}
        opacity={0.16}
        vectorEffect="non-scaling-stroke"
      />
      {[0, 1].map((layer) => (
        <path
          key={layer}
          ref={(path) => {
            paths.current[layer] = path
          }}
          d={`M 0 ${HEIGHT / 2} H ${WIDTH}`}
          fill={`url(#${gradientId})`}
          stroke={`url(#${gradientId}-edge)`}
          strokeWidth={0.6}
          opacity={layer === 0 ? 1 : 0.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  )
}

function ribbonEdge(samples: readonly number[], reverse: boolean): string {
  const step = (reverse ? -WIDTH : WIDTH) / STEPS
  const origin = reverse ? WIDTH : 0
  let edge = ''
  for (let index = 0; index < STEPS; index += 1) {
    const start = samples[index]!
    const end = samples[index + 1]!
    const before = samples[Math.max(0, index - 1)]!
    const after = samples[Math.min(STEPS, index + 2)]!
    edge += ` C ${(origin + index * step + step / 3).toFixed(2)} ${(start + (end - before) / 6).toFixed(2)} ${(origin + (index + 1) * step - step / 3).toFixed(2)} ${(end - (after - start) / 6).toFixed(2)} ${(origin + (index + 1) * step).toFixed(2)} ${end.toFixed(2)}`
  }
  return edge
}
