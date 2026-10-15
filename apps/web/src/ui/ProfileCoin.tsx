import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  AVATAR_SIZE,
  CELL,
  generatedAvatar,
  readSeal,
  type MandalaAvatar,
  type SealReading,
} from '../generated-avatar.js'
import {
  CORE_RADIUS,
  GeneratedAvatar,
  RING_BANDS,
  TILE_GAP_DEGREES,
  annularSector,
} from './GeneratedAvatar.js'

const CENTER = AVATAR_SIZE / 2
/** Typing waits for a pause before the seal is struck again, so it lands once per word, not per key. */
export const STRIKE_DELAY_MS = 220

/** Which face of the coin is up: the seal struck from the name, or the photo. */
export type CoinSide = 'seal' | 'photo'

type FillStyle = CSSProperties & { fill: string }

function point(r: number, degrees: number): [number, number] {
  const radians = (degrees * Math.PI) / 180
  return [CENTER + r * Math.sin(radians), CENTER - r * Math.cos(radians)]
}

/** The word the seal shows: it follows what is typed once typing pauses. */
export function useStruckName(name: string): string {
  const [struck, setStruck] = useState(name)
  useEffect(() => {
    if (name === struck) return
    const timer = window.setTimeout(() => setStruck(name), STRIKE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [name, struck])
  return struck
}

/**
 * A coin with the two pictures on its two faces: the seal struck from the
 * name, and the photo. Turning it over is how the picture changes.
 */
export function ProfileCoin(props: {
  /** Already settled with `useStruckName`. */
  name: string
  photo: string | undefined
  side: CoinSide
  dropping: boolean
  /** Shows how the seal was read: letters on the tiles of the slice that repeats. */
  explain: boolean
  label: string
  onTurn: () => void
}) {
  const avatar = useMemo(() => generatedAvatar(props.name), [props.name])
  const reading = useMemo(() => readSeal(props.name), [props.name])
  const mandala = avatar.style === 'mandala' ? avatar : undefined
  const body = useRef<HTMLSpanElement>(null)
  const lastSide = useRef(props.side)

  // The seal starts blank and is struck a frame later, so opening the page
  // mints the coin the way a new name strikes it.
  const [minted, setMinted] = useState(false)
  useLayoutEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setMinted(true))
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  // A turn is thrown, not swapped: the coin lifts towards you and tips back
  // a little on the way over, runs past its new face and rocks back to rest.
  // The face leaving darkens as it goes edge-on and the arriving one catches
  // the light as it comes round. Turning back keeps going the same way.
  const flight = useRef<Animation[]>([])
  useEffect(() => {
    if (lastSide.current === props.side) return
    const from = lastSide.current === 'seal' ? 0 : 180
    lastSide.current = props.side
    const coin = body.current
    if (!coin?.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    for (const running of flight.current) running.finish()
    const face = (side: CoinSide) => coin.querySelector<HTMLElement>(`.profile-coin__face--${side}`)
    const leaving = face(from === 0 ? 'seal' : 'photo')
    const arriving = face(from === 0 ? 'photo' : 'seal')
    const shadow = coin
      .closest('.profile-coin')
      ?.querySelector<HTMLElement>('.profile-coin__shadow')
    flight.current = [
      coin.animate(turnFrames(from), { duration: TURN_MS }),
      ...(shadow?.animate ? [shadow.animate(SHADOW_FRAMES, { duration: TURN_MS })] : []),
      ...lightFrames(leaving, 'leaving'),
      ...lightFrames(arriving, 'arriving'),
    ]
  }, [props.side])

  const tilt = useCoinNudge()

  return (
    // A pointer shortcut for the text action under it, which is the control
    // keyboards and screen readers use.
    <button
      className="profile-coin"
      type="button"
      tabIndex={-1}
      aria-hidden
      title={props.label}
      data-side={props.side}
      data-dropping={props.dropping || undefined}
      data-explaining={(props.explain && props.side === 'seal' && reading) || undefined}
      onClick={props.onTurn}
    >
      <span className="profile-coin__shadow" aria-hidden />
      <span className="profile-coin__tilt" ref={tilt}>
        <span className="profile-coin__body" ref={body}>
          {EDGE_LAYERS.map((layer) => (
            <span key={layer.index} className="profile-coin__edge" style={layer.style} />
          ))}
          <span className="profile-coin__face profile-coin__face--seal">
            <Light />
            <Beads />
            <span className="profile-coin__picture">
              {mandala ? (
                <StruckMandala avatar={mandala} blank={!minted} reading={reading} />
              ) : (
                <GeneratedAvatar name={props.name} />
              )}
            </span>
          </span>
          <span className="profile-coin__face profile-coin__face--photo">
            <Light />
            <Beads />
            <span className="profile-coin__picture">
              {props.photo ? (
                // Keyed by the photo so a new one settles in again.
                <img
                  key={`${props.photo.length}:${props.photo.slice(-24)}`}
                  src={props.photo}
                  alt=""
                />
              ) : (
                <span className="profile-coin__blank">Drop a photo</span>
              )}
            </span>
          </span>
        </span>
      </span>
    </button>
  )
}

const TURN_MS = 960

// Brushing the cursor across the coin nudges it like a finger would: the
// coin swings the way it was brushed, rocks on a damped spring and comes back
// to rest. It answers movement, not position, so a still cursor leaves it be.
const NUDGE_STIFFNESS = 120
const NUDGE_DAMPING = 9
/** Degrees per second of swing for each pixel the cursor travels over the coin. */
const NUDGE_GRIP = { x: 1.8, y: 2.8 }
const NUDGE_LIMIT = 36

function useCoinNudge() {
  const tilt = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const element = tilt.current
    const coin = element?.closest<HTMLElement>('.profile-coin')
    if (!element || !coin) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const angle = { x: 0, y: 0 }
    const speed = { x: 0, y: 0 }
    let pointer: { x: number; y: number; at: number } | undefined
    let frame = 0
    let last = 0
    const step = (now: number) => {
      const dt = Math.min(0.032, Math.max(0.001, (now - last) / 1000))
      last = now
      let moving = false
      for (const axis of ['x', 'y'] as const) {
        speed[axis] += (-angle[axis] * NUDGE_STIFFNESS - speed[axis] * NUDGE_DAMPING) * dt
        angle[axis] = Math.max(-NUDGE_LIMIT, Math.min(NUDGE_LIMIT, angle[axis] + speed[axis] * dt))
        if (Math.abs(angle[axis]) > 0.02 || Math.abs(speed[axis]) > 0.05) moving = true
        else angle[axis] = speed[axis] = 0
      }
      element.style.setProperty('--nudge-x', angle.x.toFixed(3))
      element.style.setProperty('--nudge-y', angle.y.toFixed(3))
      frame = moving ? requestAnimationFrame(step) : 0
    }
    const brush = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      const now = event.timeStamp
      // A pause, or a fresh entry, is not a push.
      if (pointer && now - pointer.at < 90) {
        // Dragging the face right swings its right side back, as on a pivot.
        speed.y += (event.clientX - pointer.x) * NUDGE_GRIP.y
        speed.x -= (event.clientY - pointer.y) * NUDGE_GRIP.x
        if (!frame) {
          last = performance.now()
          frame = requestAnimationFrame(step)
        }
      }
      pointer = { x: event.clientX, y: event.clientY, at: now }
    }
    const leave = () => {
      pointer = undefined
    }
    coin.addEventListener('pointermove', brush)
    coin.addEventListener('pointerleave', leave)
    return () => {
      cancelAnimationFrame(frame)
      coin.removeEventListener('pointermove', brush)
      coin.removeEventListener('pointerleave', leave)
    }
  }, [])
  return tilt
}

function turnFrames(from: number): Keyframe[] {
  const at = (z: number, tip: number, turn: number) =>
    `translateZ(${z}px) rotateX(${tip}deg) rotateY(${from + turn}deg)`
  return [
    { transform: at(0, 0, 0), easing: 'cubic-bezier(0.55, 0, 0.8, 0.5)' },
    { offset: 0.4, transform: at(48, -8, 92), easing: 'cubic-bezier(0.2, 0.5, 0.35, 1)' },
    { offset: 0.72, transform: at(8, -2, 192), easing: 'cubic-bezier(0.45, 0, 0.55, 1)' },
    { offset: 0.87, transform: at(0, 0.5, 176), easing: 'cubic-bezier(0.45, 0, 0.55, 1)' },
    { transform: at(0, 0, 180) },
  ]
}

/** The shadow the coin throws on the page grows softer and wider as it lifts. */
const SHADOW_FRAMES: Keyframe[] = [
  {
    opacity: 0,
    transform: 'translateY(4px) scale(0.96)',
    easing: 'cubic-bezier(0.55, 0, 0.8, 0.5)',
  },
  {
    offset: 0.4,
    opacity: 1,
    transform: 'translateY(18px) scale(1.06)',
    easing: 'cubic-bezier(0.2, 0.5, 0.35, 1)',
  },
  { offset: 0.8, opacity: 0.2, transform: 'translateY(6px) scale(0.98)' },
  { opacity: 0, transform: 'translateY(4px) scale(0.96)' },
]

/** The face leaving darkens as it goes edge-on; the arriving one comes up out of it. */
function lightFrames(face: HTMLElement | null, role: 'leaving' | 'arriving'): Animation[] {
  const shade = face?.querySelector<HTMLElement>('.profile-coin__shade')
  if (!shade?.animate) return []
  const timing = { duration: TURN_MS }
  // Darkness follows the angle: barely any while the face still looks at you.
  return role === 'leaving'
    ? [
        shade.animate(
          [
            { opacity: 0 },
            { offset: 0.22, opacity: 0.06 },
            { offset: 0.32, opacity: 0.24 },
            { offset: 0.4, opacity: 0.6 },
            { opacity: 0.6 },
          ],
          timing,
        ),
      ]
    : [
        shade.animate(
          [
            { opacity: 0.6 },
            { offset: 0.4, opacity: 0.6 },
            { offset: 0.5, opacity: 0.22 },
            { offset: 0.62, opacity: 0.05 },
            { offset: 0.74, opacity: 0 },
            { opacity: 0 },
          ],
          timing,
        ),
      ]
}

// The coin's thickness: discs stacked between the two faces, lighter towards
// the middle so the edge reads as rounded metal when it turns side-on.
const EDGE_COUNT = 12
type EdgeStyle = CSSProperties & { '--depth': number; '--sheen': string }
const EDGE_LAYERS = Array.from({ length: EDGE_COUNT }, (_, index) => {
  const depth = index / (EDGE_COUNT - 1) - 0.5
  const style: EdgeStyle = {
    '--depth': depth,
    '--sheen': `${Math.round(16 + 22 * (1 - Math.abs(depth) * 2))}%`,
  }
  return { index, style }
})

function Light() {
  return <span className="profile-coin__shade" aria-hidden />
}

// The beaded border struck coins carry between the face and the rim.
const BEADS = 96
const BEAD_RADIUS = 53.4

function Beads() {
  return (
    <svg className="profile-coin__beads" viewBox="-10 -10 120 120" aria-hidden>
      {Array.from({ length: BEADS }, (_, bead) => {
        const [cx, cy] = point(BEAD_RADIUS, (bead * 360) / BEADS)
        return <circle key={bead} cx={cx.toFixed(2)} cy={cy.toFixed(2)} r={0.5} />
      })}
    </svg>
  )
}

/** Every tile is always drawn, ground ones invisible, so a new name can fade each tile into its next ink. */
function StruckMandala({
  avatar,
  blank,
  reading,
}: {
  avatar: MandalaAvatar
  blank: boolean
  reading: SealReading | undefined
}) {
  const span = 360 / avatar.sectors
  // The slice every other one repeats: the first `unique` sectors of each ring.
  const unique =
    avatar.sectors / (avatar.symmetry === 'mirror' ? 2 : avatar.symmetry === 'triple' ? 3 : 4)
  const ground = blank ? 'var(--surface)' : avatar.ground
  const shown = (cell: number) => !blank && cell !== CELL.ground
  const ink = (cell: number): FillStyle => ({
    fill: !shown(cell) ? ground : cell === CELL.glint ? avatar.inks[1] : avatar.inks[0],
  })
  return (
    <svg
      className="profile-coin__mandala"
      viewBox={`0 0 ${AVATAR_SIZE} ${AVATAR_SIZE}`}
      data-minted={!blank || undefined}
      aria-hidden
    >
      <rect
        className="profile-coin__ground"
        width={AVATAR_SIZE}
        height={AVATAR_SIZE}
        style={{ fill: ground }}
      />
      {avatar.rings.map((ring, index) => {
        const [inner, outer] = RING_BANDS[index]!
        return ring.map((cell, sector) => (
          <path
            key={`${index}-${sector}`}
            className="profile-coin__tile"
            data-ring={index}
            data-ground={!shown(cell) || undefined}
            data-repeat={sector >= unique || undefined}
            d={annularSector(
              inner,
              outer,
              sector * span + TILE_GAP_DEGREES / 2,
              (sector + 1) * span - TILE_GAP_DEGREES / 2,
            )}
            style={ink(cell)}
          />
        ))
      })}
      <circle
        className="profile-coin__tile"
        data-ring={RING_BANDS.length}
        data-ground={!shown(avatar.core) || undefined}
        cx={CENTER}
        cy={CENTER}
        r={CORE_RADIUS}
        style={ink(avatar.core)}
      />
      {reading && !blank ? (
        <g className="profile-coin__letters">
          {RING_BANDS.flatMap(([inner, outer], ring) =>
            Array.from({ length: unique }, (_, sector) => {
              const index = (ring * unique + sector) % reading.characters.length
              const character = reading.characters[index]!
              const [x, y] = point((inner + outer) / 2, (sector + 0.5) * span)
              const laid = reading.laid[index] !== CELL.ground
              return (
                <text
                  key={`${ring}-${sector}`}
                  x={x.toFixed(2)}
                  y={y.toFixed(2)}
                  data-gap={!laid || undefined}
                  style={{ fill: laid ? avatar.ground : avatar.inks[0] }}
                >
                  {character === ' ' ? '\u00b7' : character}
                </text>
              )
            }),
          )}
        </g>
      ) : null}
    </svg>
  )
}
