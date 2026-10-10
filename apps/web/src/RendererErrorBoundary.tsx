import { Component, type ReactNode } from 'react'
import { IconAlertTriangle, IconCheck, IconCopy, IconRefresh } from '@tabler/icons-react'
import { isDesktop, reportRendererError, writeClipboardText } from './bridge.js'
import './styles/renderer-recovery.css'

type Props = { children: ReactNode; reload?: () => void }
type CopyState = 'idle' | 'copied' | 'failed'
type State = { failed: boolean; copy: CopyState; diagnostics: string }

const COPY_STATUS = {
  idle: '',
  copied: 'Diagnostics copied.',
  failed: 'Could not copy diagnostics. Please try again.',
} satisfies Record<CopyState, string>

/** Recovery must not depend on the stores or UI subtree that just failed. */
export class RendererErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false, copy: 'idle', diagnostics: '' }

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
      this.setState({ copy: 'copied' })
    } catch {
      this.setState({ copy: 'failed' })
    }
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    const { copy } = this.state
    return (
      <main className="renderer-recovery" aria-labelledby="renderer-recovery-title">
        <section className="renderer-recovery__card">
          <span className="renderer-recovery__mark" aria-hidden="true">
            <IconAlertTriangle size={18} stroke={1.75} />
          </span>
          <h1 id="renderer-recovery-title" className="renderer-recovery__title">
            TasteCode couldn’t display this window
          </h1>
          <p className="renderer-recovery__body">
            Something went wrong while drawing the interface. Running agents and saved chats aren’t
            affected, so reloading picks up where you left off.
          </p>
          <p role="status" className="renderer-recovery__status" data-state={copy}>
            {COPY_STATUS[copy]}
          </p>
          <div className="renderer-recovery-actions">
            {this.state.diagnostics ? (
              <button type="button" className="renderer-recovery__secondary" onClick={this.#copy}>
                {copy === 'copied' ? (
                  <IconCheck size={15} stroke={2} aria-hidden="true" />
                ) : (
                  <IconCopy size={15} stroke={1.75} aria-hidden="true" />
                )}
                Copy diagnostics
              </button>
            ) : null}
            <button
              type="button"
              className="renderer-recovery__primary"
              ref={this.#focusReload}
              onClick={() => (this.props.reload ?? (() => window.location.reload()))()}
            >
              <IconRefresh size={15} stroke={2} aria-hidden="true" />
              Reload window
            </button>
          </div>
        </section>
      </main>
    )
  }
}
