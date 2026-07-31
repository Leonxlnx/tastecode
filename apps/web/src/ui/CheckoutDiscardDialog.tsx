import { GitBranch, X } from 'lucide-react'

export function CheckoutDiscardDialog(props: {
  title: string
  branch: string
  busy: boolean
  onDiscard: () => void
  onClose: () => void
}) {
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Discard isolated checkout">
      <button className="sheet__scrim" onClick={props.onClose} aria-label="Keep session" />
      <div className="sheet__panel checkout-discard">
        <header className="sheet__head">
          <div>
            <h2 className="sheet__title">This checkout has uncommitted work</h2>
            <p className="checkout-discard__branch">
              <GitBranch size={12} aria-hidden />
              {props.branch}
            </p>
          </div>
          <button className="icon-btn icon-btn--always" onClick={props.onClose} title="Close">
            <X size={13} aria-hidden />
          </button>
        </header>
        <section className="sheet__section">
          <p className="checkout-discard__copy">
            Archiving “{props.title}” now would discard changes the agent has not committed.
          </p>
          <div className="checkout-discard__actions">
            <button className="ghost" onClick={props.onClose} disabled={props.busy}>
              Keep session
            </button>
            <button className="btn btn--danger" onClick={props.onDiscard} disabled={props.busy}>
              {props.busy ? 'Discarding…' : 'Discard changes and archive'}
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
