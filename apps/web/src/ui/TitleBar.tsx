/**
 * Title bar. Holds the window-level controls — the sidebar toggle belongs here
 * rather than inside the sidebar it hides, so its position never moves.
 *
 * There is deliberately no product name in the rail below. Labelling the rail
 * with the app's own name is like writing "Browser" at the top of a browser;
 * the window already says what this is.
 *
 * Height comes from --titlebar-h, which the main process also uses for the
 * native caption buttons.
 */
export function TitleBar(props: { collapsed: boolean; onToggleRail: () => void }) {
  return (
    <header className="titlebar">
      <button
        className="icon-btn icon-btn--always titlebar__toggle"
        onClick={props.onToggleRail}
        title={props.collapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-pressed={!props.collapsed}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
          <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M6.5 3v10" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
      <span className="titlebar__name">Personal Harness</span>
    </header>
  )
}
