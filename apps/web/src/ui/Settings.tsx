import type { Account, ProviderId } from '@harness/contracts'
import { isDesktop } from '../bridge.js'

/**
 * Settings. Small on purpose — every option here is a decision the user has to
 * make, so anything the app can decide correctly on its own does not appear.
 */
export function Settings(props: {
  provider: ProviderId
  providerName: string
  account: Account | undefined
  projectCount: number
  onSignOut: () => void
  onReset: () => void
  onClose: () => void
}) {
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Settings">
      <button className="sheet__scrim" onClick={props.onClose} aria-label="Close settings" />
      <div className="sheet__panel">
        <header className="sheet__head">
          <h2 className="sheet__title">Settings</h2>
          <button className="icon-btn icon-btn--always" onClick={props.onClose} title="Close">
            <XGlyph />
          </button>
        </header>

        <section className="sheet__section">
          <h3 className="sheet__label">Account</h3>
          <div className="row-between">
            <div>
              <p className="row__title">{props.providerName}</p>
              <p className="row__note">
                {props.account?.signedIn
                  ? [props.account.email, props.account.plan].filter(Boolean).join(' · ') ||
                    'Signed in'
                  : 'Not signed in'}
              </p>
            </div>
            {props.account?.signedIn ? (
              <button className="ghost" onClick={props.onSignOut}>
                Sign out
              </button>
            ) : null}
          </div>
          <p className="sheet__note">
            Signing out is handled by {props.providerName} itself. Personal Harness holds no
            credential to discard.
          </p>
        </section>

        <section className="sheet__section">
          <h3 className="sheet__label">Data</h3>
          <div className="row-between">
            <div>
              <p className="row__title">{props.projectCount} project(s) on this machine</p>
              <p className="row__note">
                Stored locally. Nothing is uploaded anywhere, by us or on your behalf.
              </p>
            </div>
            <button className="ghost" onClick={props.onReset}>
              Reset app
            </button>
          </div>
        </section>

        <section className="sheet__section">
          <h3 className="sheet__label">About</h3>
          <p className="sheet__note">
            Personal Harness · {isDesktop ? 'desktop' : 'browser'} · pre-release. Open source, and
            built to be forked.
          </p>
        </section>
      </div>
    </div>
  )
}

function XGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
