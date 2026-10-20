import { useState } from 'react'
import { IconEye as Eye, IconEyeOff as EyeOff } from '@tabler/icons-react'
import { IconMorph } from './IconMorph.js'

/** Preview on hover or focus, then let a click keep the address visible. */
export function AccountEmail(props: { email: string }) {
  const [pinned, setPinned] = useState(false)
  const [previewed, setPreviewed] = useState(false)
  const revealed = pinned || previewed

  const togglePinned = () => {
    setPreviewed(false)
    setPinned((current) => !current)
  }

  return (
    <span className="settings__email" data-revealed={revealed} data-pinned={pinned}>
      <button
        className="settings__email-toggle"
        type="button"
        aria-label={pinned ? 'Hide account email' : 'Show account email'}
        aria-pressed={pinned}
        title={pinned ? 'Click to hide email' : 'Hover to preview or click to keep visible'}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'touch') setPreviewed(true)
        }}
        onPointerLeave={() => setPreviewed(false)}
        onFocus={() => setPreviewed(true)}
        onBlur={() => setPreviewed(false)}
        onClick={togglePinned}
      >
        <IconMorph active={revealed ? 1 : 0}>
          <Eye className="settings__email-eye--show" size={15} aria-hidden />
          <EyeOff className="settings__email-eye--hide" size={15} aria-hidden />
        </IconMorph>
      </button>
      <span className="settings__email-clip">
        <span className="settings__email-value">{props.email}</span>
      </span>
    </span>
  )
}
