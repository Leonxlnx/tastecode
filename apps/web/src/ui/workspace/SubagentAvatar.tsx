import { memo, type CSSProperties, type ReactElement } from 'react'

/**
 * A sub-agent's own mark: a small two-tone sigil drawn from its id, so the
 * same sub-agent keeps the same mark in the list, its detail and every reload,
 * and two sub-agents of one chat rarely look alike. Five families (bloom,
 * orbit, tide, lattice, kite) times their variants and a curated hue each.
 * Pure SVG on two colour tokens, so both themes and high contrast follow CSS.
 */

/** Hues that stay clear on both themes; muddy greens and browns are left out. */
const HUES = [8, 28, 46, 152, 172, 192, 212, 232, 258, 282, 304, 328] as const

export type SigilFamily = 'bloom' | 'orbit' | 'tide' | 'lattice' | 'kite'
const FAMILIES: readonly SigilFamily[] = ['bloom', 'orbit', 'tide', 'lattice', 'kite']

export type Sigil = { family: SigilFamily; hue: number; variant: number }

/** FNV-1a, 32 bit: stable across runs and platforms, cheap for short ids. */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    h ^= text.charCodeAt(index)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function sigilFor(seed: string): Sigil {
  const h = hash(seed)
  return {
    family: FAMILIES[h % FAMILIES.length]!,
    hue: HUES[(h >>> 4) % HUES.length]!,
    variant: (h >>> 12) & 0xff,
  }
}

const A = 'var(--sigil-a)'
const B = 'var(--sigil-b)'

function bloom(variant: number): ReactElement[] {
  const petals = 3 + (variant % 4)
  const turn = (variant >> 2) % 2 ? 360 / petals / 2 : 0
  const shapes: ReactElement[] = []
  for (let index = 0; index < petals; index += 1) {
    shapes.push(
      <ellipse
        key={index}
        cx="12"
        cy="7"
        rx={petals > 4 ? 2.6 : 3.3}
        ry="4.6"
        fill={index % 2 ? B : A}
        transform={`rotate(${turn + (index * 360) / petals} 12 12)`}
      />,
    )
  }
  shapes.push(<circle key="core" cx="12" cy="12" r="2.1" fill={B} />)
  return shapes
}

function orbit(variant: number): ReactElement[] {
  const angle = (variant % 8) * 45
  const sweep = variant & 0x10 ? 38 : 30
  return [
    <circle key="core" cx="12" cy="12" r="4.4" fill={A} />,
    <circle
      key="ring"
      cx="12"
      cy="12"
      r="8.6"
      fill="none"
      stroke={B}
      strokeWidth="2"
      strokeLinecap="round"
      strokeDasharray={`${sweep} 60`}
      transform={`rotate(${angle} 12 12)`}
    />,
    <circle
      key="moon"
      cx="20.6"
      cy="12"
      r="2.2"
      fill={A}
      transform={`rotate(${angle - 40} 12 12)`}
    />,
  ]
}

function tide(variant: number): ReactElement[] {
  const angle = (variant % 6) * 30
  return [
    <circle key="disc" cx="12" cy="12" r="9" fill={B} />,
    <path
      key="half"
      d="M12 3a9 9 0 0 1 0 18a4.5 4.5 0 0 1 0-9a4.5 4.5 0 0 0 0-9z"
      fill={A}
      transform={`rotate(${angle} 12 12)`}
    />,
    <circle key="eye" cx="12" cy="7.5" r="1.6" fill={B} transform={`rotate(${angle} 12 12)`} />,
  ]
}

function lattice(variant: number): ReactElement[] {
  // A left-right mirrored 3×3 grid of six free cells. The top corners and the
  // centre are always on, so even a sparse one reads as a mark at 22 px.
  let bits = variant | 0b001001
  const shapes: ReactElement[] = []
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 2; column += 1) {
      const on = bits & 1
      const accent = (variant >> (row * 2 + column + 3)) & 1
      bits >>= 1
      if (!on) continue
      const fill = accent ? B : A
      const y = 2.4 + row * 6.8
      for (const x of column === 0 ? [2.4, 16.0] : [9.2]) {
        shapes.push(
          <rect key={`${row}-${x}`} x={x} y={y} width="5.6" height="5.6" rx="1.8" fill={fill} />,
        )
      }
    }
  }
  return shapes
}

function kite(variant: number): ReactElement[] {
  const inner = variant % 3
  return [
    <rect
      key="outer"
      x="5"
      y="5"
      width="14"
      height="14"
      rx="3.4"
      fill={A}
      transform="rotate(45 12 12)"
    />,
    inner === 0 ? (
      <circle key="inner" cx="12" cy="12" r="3.2" fill={B} />
    ) : (
      <rect
        key="inner"
        x="9"
        y="9"
        width="6"
        height="6"
        rx={inner === 1 ? 1.4 : 3}
        fill={B}
        transform={inner === 1 ? 'rotate(45 12 12)' : undefined}
      />
    ),
  ]
}

const DRAW = {
  bloom,
  orbit,
  tide,
  lattice,
  kite,
} satisfies Record<SigilFamily, (variant: number) => ReactElement[]>

/**
 * `seed` is the sub-agent's row id. A running sub-agent gets a slow ring that
 * turns on the compositor, so a long run costs no layout or paint per frame.
 */
export const SubagentAvatar = memo(function SubagentAvatar({
  seed,
  running = false,
  size = 22,
}: {
  seed: string
  running?: boolean
  size?: number
}) {
  const sigil = sigilFor(seed)
  return (
    <span
      className="subagent-avatar"
      data-family={sigil.family}
      data-running={running ? '' : undefined}
      style={{ '--sigil-hue': sigil.hue, width: size, height: size } as CSSProperties}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" width={size} height={size} focusable="false">
        {DRAW[sigil.family](sigil.variant)}
      </svg>
    </span>
  )
})
