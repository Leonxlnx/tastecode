/**
 * The new design. Light and dark.
 * A sidebar (modules, then the chat list) and the dashboard, divided by
 * etched separators. Styles live in new-design.css and chat-list.css.
 */
import { useRef, useState, type ComponentType } from 'react'
import '../styles/new-design.css'
import { ChatList } from './ChatList'
import { bezier, reducedMotion, tween } from './motion'
import { CloseSidebarIcon, NewProjectIcon, PullRequestIcon, ScanSearchIcon } from './NavIcons'
import { NewChatIcon } from './NewChatIcon'
import logo from '../assets/logo.png'

/**
 * The sidebar's curve is mirror-symmetric (x2 = 1 - x1, y2 = 1 - y1), so
 * opening is exactly closing played backwards and both feel the same
 * speed. An ease-out made closing feel quick (its slow tail happened at the
 * window's edge after the toggle had parked) and opening feel slow (the
 * same tail was the sidebar and toggle creeping into place in full view).
 */
const easeDrawer = bezier(0.35, 0, 0.65, 1)
/** A full open or close; shorter slides (reversed mid-way) scale down. */
const DRAWER_MS = 360

/**
 * Where the sidebar toggle sits for a given sidebar width: 40px in from the
 * sidebar's right edge (its place in the top bar) while there's room, then
 * parked 10px from the window's left edge, in the header. A soft clamp
 * rather than a hard one, so it eases to a stop instead of halting
 * mid-stride.
 */
function toggleX(width: number) {
  const soft = 8
  return 10 + soft * Math.log1p(Math.exp((width - 50) / soft))
}

type Module = { id: string; label: string; Icon: ComponentType<{ size?: number }> }

const modules: Module[] = [
  { id: 'new-chat', label: 'New chat', Icon: NewChatIcon },
  { id: 'new-project', label: 'New project', Icon: NewProjectIcon },
  { id: 'pull-requests', label: 'Pull requests', Icon: PullRequestIcon },
]

export function NewDesign() {
  const [active, setActive] = useState('new-chat')
  const [railOpen, setRailOpen] = useState(true)
  const shell = useRef<HTMLDivElement>(null)
  const rail = useRef<HTMLElement>(null)
  const sliding = useRef<(() => void) | null>(null)

  /**
   * Slides the sidebar shut or open. Its column narrows (or widens) in
   * whole-pixel steps while its content, pinned to the right edge, slides
   * out of view, so text stays crisp the whole way. The toggle button rides
   * the sidebar's edge and eases to a stop at the top left of the header
   * (toggleX). A click mid-slide turns it around from wherever it is.
   */
  const setRail = (open: boolean) => {
    setRailOpen(open)
    const root = shell.current
    const aside = rail.current
    if (!root || !aside) return
    sliding.current?.()
    const full = parseFloat(getComputedStyle(root).getPropertyValue('--nd-rail-w')) || 240
    const from = aside.getBoundingClientRect().width
    const to = open ? full : 0
    const frame = (w: number) => {
      root.style.setProperty('--nd-rail-now', `${Math.round(w)}px`)
      root.style.setProperty('--nd-toggle-x', `${Math.round(toggleX(w))}px`)
    }
    const done = () => {
      sliding.current = null
      if (open) {
        root.style.removeProperty('--nd-rail-now')
        root.style.removeProperty('--nd-toggle-x')
      }
    }
    if (reducedMotion()) {
      frame(to)
      done()
      return
    }
    const duration = Math.max(140, (DRAWER_MS * Math.abs(to - from)) / full)
    sliding.current = tween(from, to, duration, easeDrawer, frame, done)
  }

  return (
    <div className="nd" ref={shell} data-rail={railOpen ? 'open' : 'closed'}>
      <aside className="nd-rail" aria-label="Sidebar" ref={rail} inert={!railOpen}>
        {/* Fixed at full width and pinned to the right edge, so it slides
            out of view as the column narrows instead of squashing. */}
        <div className="nd-rail__inner">
        {/* Top bar: the account switcher, then search and close sidebar. */}
        <div className="nd-top">
          <button className="nd-workspace" aria-label="Switch account">
            <span className="nd-workspace__avatar" style={{ backgroundImage: `url(${logo})` }} aria-hidden />
            <span className="nd-workspace__name">TasteCode</span>
            <svg className="nd-workspace__chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M2.5 4 5 6.5 7.5 4" />
            </svg>
          </button>
          <div className="nd-top__actions">
            <button className="nd-top__icon" aria-label="Search">
              <ScanSearchIcon />
            </button>
            {/* The sidebar toggle's spot; the button itself floats over the
                whole layout so it can ride the edge (see .nd-toggle). */}
            <span className="nd-top__slot" aria-hidden />
          </div>
        </div>
        <nav className="nd-nav">
          {modules.map(({ id, label, Icon }) => (
            // aria-current marks the module you're on: it gets the card, and
            // its bar grows in on the left, pushing the icon and label right.
            <button
              key={id}
              className="nd-nav__item"
              aria-current={active === id ? 'page' : undefined}
              onClick={() => setActive(id)}
            >
              <span className="nd-nav__bar" aria-hidden />
              {/* Icon and label move together, by transform only. */}
              <span className="nd-nav__content">
                <Icon />
                <span className="nd-nav__label">{label}</span>
              </span>
            </button>
          ))}
        </nav>
        {/* Modules and chats share one selection: open a chat and the card
            moves to it. */}
        <ChatList active={active} onSelect={setActive} />
        </div>
      </aside>
      <main className="nd-main">
        <header className="nd-head" />
        <div className="nd-body" />
      </main>
      {/* One toggle for both states: it rides the sidebar's edge as it slides
          and parks in the header, turning round to point the way back. */}
      <button
        className="nd-top__icon nd-toggle"
        aria-label={railOpen ? 'Close sidebar' : 'Open sidebar'}
        aria-expanded={railOpen}
        onClick={() => setRail(!railOpen)}
      >
        <CloseSidebarIcon />
      </button>
    </div>
  )
}
