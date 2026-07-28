/**
 * Compact custom title bar.
 *
 * Height is kept in one place (--titlebar-h) because Electron's native window
 * controls are sized by the same number from the main process — they drift
 * apart the moment the two are written separately.
 */
export function TitleBar({ subtitle }: { subtitle?: string | undefined }) {
  return (
    <header className="titlebar">
      <span className="titlebar__mark" aria-hidden />
      <span className="titlebar__name">Personal Harness</span>
      {subtitle ? (
        <>
          <span className="titlebar__sep" aria-hidden>
            /
          </span>
          <span className="titlebar__ctx">{subtitle}</span>
        </>
      ) : null}
    </header>
  )
}
