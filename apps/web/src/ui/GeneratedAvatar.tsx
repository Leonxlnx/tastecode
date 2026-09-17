import { memo, useId, useMemo } from 'react'
import {
  AVATAR_SIZE,
  CELL,
  generatedAvatar,
  type AvatarStyle,
  type MandalaAvatar,
  type MarbleAvatar,
  type OrbAvatar,
} from '../generated-avatar.js'

const CENTER = AVATAR_SIZE / 2

/** Inline SVG rather than a raster data URL: crisp at any size and no encoding step. */
export const GeneratedAvatar = memo(function GeneratedAvatar(props: {
  name: string
  style?: AvatarStyle | undefined
  size?: number | undefined
  className?: string | undefined
}) {
  const avatar = useMemo(() => generatedAvatar(props.name, props.style), [props.name, props.style])
  const id = useId()
  return (
    <svg
      className={`generated-avatar${props.className ? ` ${props.className}` : ''}`}
      viewBox={`0 0 ${AVATAR_SIZE} ${AVATAR_SIZE}`}
      width={props.size ?? '100%'}
      height={props.size ?? '100%'}
      aria-hidden
    >
      <rect width={AVATAR_SIZE} height={AVATAR_SIZE} fill={avatar.ground} />
      {avatar.style === 'mandala' ? <Mandala avatar={avatar} /> : null}
      {avatar.style === 'orb' ? <Orb avatar={avatar} id={id} /> : null}
      {avatar.style === 'marble' ? <Marble avatar={avatar} /> : null}
    </svg>
  )
})

// Ring bands from the outside in, leaving a hairline between rings and a
// small angular gap between tiles so they read as set stones, not a pie.
const RING_BANDS = [
  [38, 48],
  [26, 35],
  [14, 23],
] as const
const CORE_RADIUS = 10
const TILE_GAP_DEGREES = 3

function Mandala({ avatar }: { avatar: MandalaAvatar }) {
  const span = 360 / avatar.sectors
  const fill = (cell: number) => (cell === CELL.glint ? avatar.inks[1] : avatar.inks[0])
  return (
    <>
      {avatar.rings.map((ring, index) => {
        const [inner, outer] = RING_BANDS[index]!
        return ring.map((cell, sector) =>
          cell === CELL.ground ? null : (
            <path
              key={`${index}-${sector}`}
              d={annularSector(
                inner,
                outer,
                sector * span + TILE_GAP_DEGREES / 2,
                (sector + 1) * span - TILE_GAP_DEGREES / 2,
              )}
              fill={fill(cell)}
            />
          ),
        )
      })}
      {avatar.core === CELL.ground ? null : (
        <circle cx={CENTER} cy={CENTER} r={CORE_RADIUS} fill={fill(avatar.core)} />
      )}
    </>
  )
}

/** Angles in degrees, clockwise from twelve o'clock. */
function annularSector(r0: number, r1: number, a0: number, a1: number): string {
  const point = (r: number, degrees: number) => {
    const radians = (degrees * Math.PI) / 180
    return `${(CENTER + r * Math.sin(radians)).toFixed(2)} ${(CENTER - r * Math.cos(radians)).toFixed(2)}`
  }
  return [
    `M ${point(r1, a0)}`,
    `A ${r1} ${r1} 0 0 1 ${point(r1, a1)}`,
    `L ${point(r0, a1)}`,
    `A ${r0} ${r0} 0 0 0 ${point(r0, a0)}`,
    'Z',
  ].join(' ')
}

function Orb({ avatar, id }: { avatar: OrbAvatar; id: string }) {
  const gradient = `${id}-g`
  const glow = `${id}-h`
  return (
    <>
      <defs>
        <linearGradient
          id={gradient}
          gradientUnits="userSpaceOnUse"
          gradientTransform={`rotate(${avatar.angle} ${CENTER} ${CENTER})`}
          x1={0}
          y1={0}
          x2={0}
          y2={AVATAR_SIZE}
        >
          <stop offset="0" stopColor={avatar.stops[0]} />
          <stop offset="0.55" stopColor={avatar.stops[1]} />
          <stop offset="1" stopColor={avatar.stops[2]} />
        </linearGradient>
        <radialGradient id={glow}>
          <stop offset="0" stopColor="#fff" stopOpacity={avatar.dark ? 0.22 : 0.5} />
          <stop offset="1" stopColor="#fff" stopOpacity={0} />
        </radialGradient>
      </defs>
      <rect width={AVATAR_SIZE} height={AVATAR_SIZE} fill={`url(#${gradient})`} />
      <circle cx={avatar.glow.x} cy={avatar.glow.y} r={avatar.glow.r} fill={`url(#${glow})`} />
    </>
  )
}

function Marble({ avatar }: { avatar: MarbleAvatar }) {
  return (
    <>
      {avatar.drops.map((drop, index) => (
        <circle key={index} cx={drop.x} cy={drop.y} r={drop.r} fill={drop.color} opacity={0.86} />
      ))}
    </>
  )
}
