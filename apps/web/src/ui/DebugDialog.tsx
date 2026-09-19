import { useDialogFocus } from './dialog-focus.js'

export function DebugDialog(props: { onClose: () => void; onForceOnboarding: () => void }) {
  const dialog = useDialogFocus<HTMLDivElement>(props.onClose)

  return (
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Debug"
      onKeyDown={dialog.onKeyDown}
    >
      <button className="sheet__scrim" onClick={props.onClose} aria-label="Close debug menu" />
      <div className="sheet__panel" ref={dialog.panel} tabIndex={-1}>
        <header className="sheet__head">
          <h2 className="sheet__title">Debug</h2>
          <button className="ghost" onClick={props.onClose}>
            Close
          </button>
        </header>
        <section className="sheet__section">
          <button className="btn" onClick={props.onForceOnboarding}>
            Force onboarding
          </button>
        </section>
      </div>
    </div>
  )
}
