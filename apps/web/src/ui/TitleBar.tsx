/**
 * Custom title bar. Deliberately almost empty — the project and session live in
 * the rail and the stage header, so repeating them here would be noise in the
 * one strip of the window that is always visible.
 *
 * Height comes from --titlebar-h, which the main process also uses for the
 * native caption buttons. Written in two places, so it is commented in both.
 */
export function TitleBar() {
  return (
    <header className="titlebar">
      <span className="titlebar__name">Personal Harness</span>
    </header>
  )
}
