import { useId } from 'react'

/**
 * Sidebar icons for the new design, in the same normal filled style as the
 * New chat icon: one colour (currentColor), solid shapes, details cut out
 * rather than drawn in a second tone. Each has a hover animation, defined
 * in new-design.css.
 */

function useMaskId(name: string) {
  return `nd-${name}-${useId().replace(/:/g, '')}`
}

/**
 * A solid folder with a plus cut out.
 * Hover: the cut-out closes up inside the folder while a solid plus badge
 * springs out of its top-right corner, and the folder dips under it, as if
 * a new item just popped out.
 */
export function NewProjectIcon({ size = 16 }: { size?: number }) {
  const mask = useMaskId('new-project')
  return (
    <svg className="nd-icon nd-icon--new-project" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="-4" y="-4" width="24" height="24">
          <rect x="-4" y="-4" width="24" height="24" fill="#fff" />
          <g className="nd-icon__cut">
            <rect x="5.4" y="7.9" width="5.2" height="1.6" rx="0.8" fill="#000" />
            <rect x="7.2" y="6.1" width="1.6" height="5.2" rx="0.8" fill="#000" />
          </g>
          {/* A ring of clearance around the badge, so it reads apart from the folder. */}
          <circle className="nd-folder__clearance" cx="13" cy="3" r="3.6" fill="#000" />
        </mask>
      </defs>
      <path
        className="nd-icon__front"
        mask={`url(#${mask})`}
        d="M1.5 4.25a2 2 0 0 1 2-2h2.59a1.5 1.5 0 0 1 1.06.44l.91.9h4.44a2 2 0 0 1 2 2v6.16a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2Z"
      />
      {/* The badge: a solid plus, hidden in the folder at rest. */}
      <g className="nd-folder__badge">
        <rect x="10.6" y="2.3" width="4.8" height="1.4" rx="0.7" />
        <rect x="12.3" y="0.6" width="1.4" height="4.8" rx="0.7" />
      </g>
    </svg>
  )
}

/**
 * Pull requests: an inbox tray (things waiting for your review) with a card
 * floating above it. Solid shapes, details cut out, like the other icons.
 * Hover (instant): the card drops into the tray, its lower half vanishing
 * behind the dipped lip, and the tray squashes as it lands. Held while
 * hovered; the card springs back out on leave.
 */
export function PullRequestIcon({ size = 16 }: { size?: number }) {
  const clip = useMaskId('pr-clip')
  const lines = useMaskId('pr-lines')
  return (
    <svg className="nd-icon nd-icon--pr" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <defs>
        {/* Everything above the tray's lip, kept an even ~1.1 units clear of
            it all the way round the dip: the card only ever shows here, so it
            reads as tucked behind the lip without ever touching it. */}
        <clipPath id={clip}>
          <path d="M-4-4H20V7.4H10.1L9.07 8.57 8.62 9.41H7.38L6.93 8.57 5.9 7.4H-4Z" />
        </clipPath>
        {/* A line of "text" cut out of the card. */}
        <mask id={lines} maskUnits="userSpaceOnUse" x="-4" y="-4" width="24" height="24">
          <rect x="-4" y="-4" width="24" height="24" fill="#fff" />
          <rect x="5.9" y="3.3" width="4.2" height="1.15" rx="0.575" fill="#000" />
        </mask>
      </defs>
      {/* The whole icon squashes as one, so the card's visible area and the
          lip always stay lined up. */}
      <g className="nd-inbox">
        {/* The card: clipped by the outer group, moved by the inner one. */}
        <g clipPath={`url(#${clip})`}>
          <g className="nd-inbox__card">
            <rect mask={`url(#${lines})`} x="4.3" y="1.5" width="7.4" height="5.6" rx="1.3" />
          </g>
        </g>
        {/* The tray: two side walls and a slab with a dipped front lip. */}
        <rect x="1.5" y="4.6" width="1.6" height="5" rx="0.8" />
        <rect x="12.9" y="4.6" width="1.6" height="5" rx="0.8" />
        <path d="M1.5 8.5h3.55a1 1 0 0 1 .9.56l.45.9a1 1 0 0 0 .9.55h1.4a1 1 0 0 0 .9-.55l.45-.9a1 1 0 0 1 .9-.56H14.5v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2Z" />
      </g>
    </svg>
  )
}


/**
 * Header icons: the shapes from the reference set, in one colour
 * (currentColor) instead of two tones. Hover motions are plain transitions,
 * one per element, so nothing can jump when they finish.
 */

/**
 * Search, in the same solid one-colour style as the close icon: a frame of
 * four corner brackets around a solid magnifier (ring + handle). Every part
 * moves on its own for the "autofocus" hover (styles in new-design.css).
 */
export function ScanSearchIcon({ size = 16 }: { size?: number }) {
  const corner = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  return (
    <svg className="nd-hicon nd-hicon--search" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <g className="nd-frame">
        <path className="nd-frame__c nd-frame__c--tl" d="M1.4 4.8V3.8a2.4 2.4 0 0 1 2.4-2.4h1" {...corner} />
        <path className="nd-frame__c nd-frame__c--tr" d="M11.2 1.4h1a2.4 2.4 0 0 1 2.4 2.4v1" {...corner} />
        <path className="nd-frame__c nd-frame__c--br" d="M14.6 11.2v1a2.4 2.4 0 0 1-2.4 2.4h-1" {...corner} />
        <path className="nd-frame__c nd-frame__c--bl" d="M4.8 14.6h-1a2.4 2.4 0 0 1-2.4-2.4v-1" {...corner} />
      </g>
      {/* Outer group: the held hover state. Inner group: the one-shot twist. */}
      <g className="nd-hicon__glass">
        <g className="nd-lens">
          <path
            fillRule="evenodd"
            d="M7.6 4.1a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Zm0 1.6a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8Z"
          />
          {/* A plain rounded stroke, so no built-in transform for CSS to fight. */}
          <path
            className="nd-lens__handle"
            d="M10.25 10.25 12.2 12.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </g>
      </g>
    </svg>
  )
}

/* ---------- Chat list ---------- */

const FOLDER =
  'M1.5 4.25a2 2 0 0 1 2-2h2.59a1.5 1.5 0 0 1 1.06.44l.91.9h4.44a2 2 0 0 1 2 2v6.16a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2Z'

/** A solid folder, the New project icon without its plus. */
export function FolderIcon({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <svg className={`nd-icon ${className}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d={FOLDER} />
    </svg>
  )
}

/** A rounded chevron pointing down; rotate it for the other directions. */
export function ChevronIcon({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <svg className={`nd-chevron ${className}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path
        d="M4.75 6.4 8 9.6l3.25-3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Organize: three solid bars, long to short. Hover (or open): the top and
 * bottom bars trade lengths, as if the list just re-sorted.
 */
export function SortIcon({ size = 16 }: { size?: number }) {
  return (
    <svg className="nd-icon nd-sort" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect className="nd-sort__bar nd-sort__bar--1" x="2" y="3.15" width="12" height="1.7" rx="0.85" />
      <rect className="nd-sort__bar nd-sort__bar--2" x="2" y="7.15" width="8.5" height="1.7" rx="0.85" />
      <rect className="nd-sort__bar nd-sort__bar--3" x="2" y="11.15" width="5" height="1.7" rx="0.85" />
    </svg>
  )
}

/** More (…): three solid dots. Hover: they hop one after another. */
export function DotsIcon({ size = 16 }: { size?: number }) {
  return (
    <svg className="nd-icon nd-dots" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <circle className="nd-dots__dot" cx="3.5" cy="8" r="1.45" />
      <circle className="nd-dots__dot" cx="8" cy="8" r="1.45" />
      <circle className="nd-dots__dot" cx="12.5" cy="8" r="1.45" />
    </svg>
  )
}

/** A rounded check mark. */
export function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg className="nd-check" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path
        d="m3.6 8.4 2.9 2.9 5.9-6.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Working: a faint ring with a short arc running round it. */
export function SpinnerIcon({ size = 12 }: { size?: number }) {
  return (
    <svg className="nd-spinner" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <circle className="nd-spinner__track" cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle
        cx="8"
        cy="8"
        r="5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="9 40"
      />
    </svg>
  )
}

/**
 * Close sidebar: a solid rounded square with its bar cut out.
 * Hover: the bar slides to the left edge and a cut-out chevron slides into
 * the space it leaves, pointing left. Reverses on leave.
 */
export function CloseSidebarIcon({ size = 16 }: { size?: number }) {
  const mask = useMaskId('close-sidebar')
  return (
    <svg className="nd-hicon nd-hicon--panel" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="-4" y="-4" width="24" height="24">
          <rect x="-4" y="-4" width="24" height="24" fill="#fff" />
          <rect className="nd-hicon__strip" x="9.6" y="4.5" width="1.7" height="7" rx="0.85" fill="#000" />
          {/* Centred in the room the bar leaves: between x 6.3 and 14.5. */}
          <path
            className="nd-hicon__chevron"
            d="M11.4 5.6 9.4 8l2 2.4"
            fill="none"
            stroke="#000"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </mask>
      </defs>
      <rect mask={`url(#${mask})`} x="1.5" y="1.5" width="13" height="13" rx="3.6" />
    </svg>
  )
}
