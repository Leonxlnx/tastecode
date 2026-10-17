import type { CSSProperties } from 'react'
import { readSeal } from '../generated-avatar.js'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'
const WHEEL_TICKS = ['a', 'm', 'z'] as const
const SYMMETRY_TEXT = {
  quad: 'four slices',
  mirror: 'mirrored',
  triple: 'three slices',
} as const

const SYMMETRY_CASES = [
  { symmetry: 'quad', counts: '3, 6, 9' },
  { symmetry: 'mirror', counts: '4, 7, 10' },
  { symmetry: 'triple', counts: '5, 8, 11' },
] as const

type AtStyle = CSSProperties & { '--at': number }
type InkStyle = CSSProperties & { '--ink': string }

function at(letter: string): AtStyle {
  return { '--at': ALPHABET.indexOf(letter) / (ALPHABET.length - 1) }
}

function ink(color: string): InkStyle {
  return { '--ink': color }
}

/** The colour wheel as a seal reads it: A at red, each letter 1/26 further round. */
const WHEEL: CSSProperties = {
  backgroundImage: `linear-gradient(90deg, ${Array.from({ length: 14 }, (_, stop) => {
    const share = stop / 13
    return `hsl(${Math.round((share * 25 * 360) / 26)} 28% 58%) ${(share * 100).toFixed(1)}%`
  }).join(', ')})`,
}

const BEAD_COUNT = 20

/**
 * The "?" in the corner while a word is tried: a small coin of its own, rim
 * and beads around the question mark.
 */
export function SealGuideToggle(props: {
  open: boolean
  pinned: boolean
  notesId: string
  onHover: (hovering: boolean) => void
  onPin: (pinned: boolean) => void
}) {
  return (
    <button
      className="seal-guide"
      type="button"
      aria-label="How a seal is struck"
      aria-expanded={props.open}
      aria-pressed={props.pinned}
      aria-controls={props.notesId}
      data-open={props.open || undefined}
      onPointerEnter={() => props.onHover(true)}
      onPointerLeave={() => props.onHover(false)}
      onFocus={() => props.onHover(true)}
      onBlur={() => props.onHover(false)}
      onClick={() => props.onPin(!props.pinned)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !props.open) return
        // Close the notes, not Settings.
        event.preventDefault()
        props.onHover(false)
        props.onPin(false)
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden>
        <circle className="seal-guide__rim" cx={12} cy={12} r={11.5} />
        {Array.from({ length: BEAD_COUNT }, (_, bead) => {
          const angle = (bead / BEAD_COUNT) * Math.PI * 2
          return (
            <circle
              key={bead}
              className="seal-guide__bead"
              cx={(12 + Math.sin(angle) * 9.4).toFixed(2)}
              cy={(12 - Math.cos(angle) * 9.4).toFixed(2)}
              r={0.55}
            />
          )
        })}
      </svg>
      <span className="seal-guide__mark" aria-hidden>
        ?
      </span>
    </button>
  )
}

/**
 * Four notes under the coin that read the struck word: what picked the
 * colour, the ground and the symmetry, and how the letters lay the tiles,
 * which the coin itself shows letter by letter.
 */
export function SealNotes(props: { id: string; word: string }) {
  const reading = readSeal(props.word)
  if (!reading) {
    return (
      <div className="seal-notes" id={props.id}>
        <p className="seal-note">
          No letters to read, so this seal is hashed. The same word always gives the same seal.
        </p>
      </div>
    )
  }
  const { avatar } = reading
  return (
    <div className="seal-notes" id={props.id}>
      <div className="seal-note">
        <p>
          <span className="seal-note__value">{reading.colourLetter}</span> picks the colour
        </p>
        <span className="seal-note__wheel" aria-hidden>
          <span className="seal-note__strip" style={WHEEL} />
          <span className="seal-note__pin" style={at(reading.colourLetter)} />
          {WHEEL_TICKS.map((letter) => (
            <span key={letter} className="seal-note__tick" style={at(letter)}>
              {letter}
            </span>
          ))}
        </span>
      </div>
      <div className="seal-note">
        <p>
          ends in <span className="seal-note__value">{reading.groundLetter}</span>, so{' '}
          {avatar.dark ? 'dark' : 'light'}
        </p>
        <p className="seal-note__rule">
          {avatar.dark ? 'end on a vowel for a light one' : 'end on any other letter for dark'}
        </p>
      </div>
      <div className="seal-note">
        <p>
          <span className="seal-note__value">{reading.letters}</span> letters,{' '}
          {SYMMETRY_TEXT[avatar.symmetry]}
        </p>
        <p className="seal-note__rule seal-note__cases">
          {SYMMETRY_CASES.map(({ symmetry, counts }) => (
            <span key={symmetry} data-current={avatar.symmetry === symmetry || undefined}>
              {counts}: {SYMMETRY_TEXT[symmetry]}
            </span>
          ))}
        </p>
      </div>
      <div className="seal-note">
        <p>each letter lays a tile, from the top, outside in</p>
        <p className="seal-note__rule seal-note__key">
          <span>
            <i style={ink(avatar.inks[1])} />
            vowels
          </span>
          <span>
            <i style={ink(avatar.inks[0])} />
            a–m
          </span>
          <span>
            <i data-gap />
            n–z
          </span>
        </p>
      </div>
    </div>
  )
}
