import { useId } from 'react'

const BUBBLE =
  'M5 1.75h6a3.5 3.5 0 0 1 3.5 3.5v3.5a3.5 3.5 0 0 1-3.5 3.5H7.4l-2.62 2.04A.75.75 0 0 1 3.6 13.7v-1.53A3.5 3.5 0 0 1 1.5 8.75v-3.5A3.5 3.5 0 0 1 5 1.75Z'

/**
 * Custom New chat icon, in a normal filled style: one colour (currentColor),
 * a solid speech bubble with the plus cut out of it.
 *
 * A second, solid bubble waits hidden behind the first. On hover of its row
 * (new-design.css) it slides out to the top right with a cut gap separating
 * it from the front bubble (no transparency, so it stays crisp), the front
 * bubble tilts back and the cut-out plus turns a quarter. Everything springs
 * back on leave.
 */
export function NewChatIcon({ size = 16 }: { size?: number }) {
  const id = useId().replace(/:/g, '')
  const cut = `nd-new-chat-cut-${id}`
  const gap = `nd-new-chat-gap-${id}`

  return (
    <svg className="nd-icon nd-icon--new-chat" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <defs>
        {/* White keeps the front bubble, black cuts the plus out of it. */}
        <mask id={cut} maskUnits="userSpaceOnUse" x="-4" y="-4" width="24" height="24">
          <rect x="-4" y="-4" width="24" height="24" fill="#fff" />
          <g className="nd-icon__cut">
            <rect x="5.4" y="6.2" width="5.2" height="1.6" rx="0.8" fill="#000" />
            <rect x="7.2" y="4.4" width="1.6" height="5.2" rx="0.8" fill="#000" />
          </g>
        </mask>
        {/* The back bubble is cut wherever the front bubble is, plus a ring of
            clearance. The ghost copy shares the front bubble's class, so it
            tilts in step with it. */}
        <mask id={gap} maskUnits="userSpaceOnUse" x="-4" y="-4" width="24" height="24">
          <rect x="-4" y="-4" width="24" height="24" fill="#fff" />
          <path className="nd-icon__front" d={BUBBLE} fill="#000" stroke="#000" strokeWidth="2.2" strokeLinejoin="round" />
        </mask>
      </defs>
      {/* The bubble behind: smaller and solid, revealed on hover. */}
      <g mask={`url(#${gap})`}>
        <rect className="nd-icon__back" x="6.5" y="0.5" width="9" height="7.5" rx="2.6" />
      </g>
      {/* Front bubble: a rounded body with a short tail at the bottom left. */}
      <path className="nd-icon__front" mask={`url(#${cut})`} d={BUBBLE} />
    </svg>
  )
}
