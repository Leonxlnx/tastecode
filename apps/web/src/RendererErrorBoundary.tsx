import { Component, type ReactNode } from 'react'
import { isDesktop, reportRendererError, writeClipboardText } from './bridge.js'
import './styles/renderer-recovery.css'

type Props = { children: ReactNode; reload?: () => void }
type State = { failed: boolean; copyStatus: string; diagnostics: string }

/** Recovery must not depend on the stores or UI subtree that just failed. */
export class RendererErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false, copyStatus: '', diagnostics: '' }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    // Detailed errors go through the desktop's existing opt-in, redacted sink.
    // Clipboard diagnostics use an allowlist: exception text can contain secrets
    // and arbitrary project paths that pattern-based redaction cannot recognize.
    const diagnostics = [
      'TasteCode renderer recovery',
      `Time: ${new Date().toISOString()}`,
      `Client: ${isDesktop ? 'desktop' : 'web'}`,
      'Failure: application render exception',
    ].join('\n')
    this.setState({ diagnostics })
    try {
      reportRendererError(error)
    } catch {
      // A diagnostic bridge failure must not take down recovery too.
    }
  }

  #focusReload = (button: HTMLButtonElement | null) => {
    button?.focus()
  }

  #copy = async () => {
    try {
      await writeClipboardText(this.state.diagnostics)
      this.setState({ copyStatus: 'Diagnostics copied.' })
    } catch {
      this.setState({ copyStatus: 'Could not copy diagnostics. Please try again.' })
    }
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <main className="renderer-recovery" aria-labelledby="renderer-recovery-title">
        <section>
          <h1 id="renderer-recovery-title">TasteCode couldn’t display this window</h1>
          <p>Reload the window to try again.</p>
          <div className="renderer-recovery-actions">
            <button
              type="button"
              ref={this.#focusReload}
              onClick={() => (this.props.reload ?? (() => window.location.reload()))()}
            >
              Reload window
            </button>
            {this.state.diagnostics ? (
              <button type="button" onClick={this.#copy}>
                Copy diagnostics
              </button>
            ) : null}
          </div>
          <p role="status">{this.state.copyStatus}</p>
        </section>
      </main>
    )
  }
}
