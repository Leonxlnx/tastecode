import { Component, Suspense, type KeyboardEvent, type ReactNode } from 'react'
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react'
import { reportRendererError } from '../bridge.js'
import { SurfaceLoadError } from '../surface-load-error.js'
import '../styles/renderer-recovery.css'

type Props = {
  /** Names the surface in the fallback, e.g. "Settings". */
  name: string
  onClose: () => void
  reload?: () => void
  /** Shown in the surface's place while its chunk loads. */
  fallback?: ReactNode
  children: ReactNode
}
type State = { failure: 'none' | 'render' | 'load' }

/**
 * Keeps one full-window surface's failure inside that surface, so the app
 * behind it keeps running instead of falling through to the root recovery
 * screen. It is also the surface's Suspense boundary, so a lazy surface needs
 * only this one wrapper. Closing the surface unmounts it, so reopening the
 * surface starts clean.
 */
export class SurfaceErrorBoundary extends Component<Props, State> {
  override state: State = { failure: 'none' }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failure: error instanceof SurfaceLoadError ? 'load' : 'render' }
  }

  override componentDidCatch(error: unknown): void {
    try {
      reportRendererError(error instanceof SurfaceLoadError ? error.cause : error)
    } catch {
      // A diagnostic bridge failure must not take down recovery too.
    }
  }

  #focusPrimary = (button: HTMLButtonElement | null) => {
    button?.focus()
  }

  #onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      this.props.onClose()
      return
    }
    if (event.key !== 'Tab' || event.defaultPrevented) return
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button')
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
      event.preventDefault()
      ;(event.shiftKey ? last : first)?.focus()
    }
  }

  override render(): ReactNode {
    const { failure } = this.state
    if (failure === 'none') {
      return <Suspense fallback={this.props.fallback ?? null}>{this.props.children}</Suspense>
    }
    const { name } = this.props
    return (
      <div
        className="renderer-recovery surface-recovery"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="surface-recovery-title"
        onKeyDown={this.#onKeyDown}
      >
        <section className="renderer-recovery__card">
          <span className="renderer-recovery__mark" aria-hidden="true">
            <IconAlertTriangle size={18} stroke={1.75} />
          </span>
          <h1 id="surface-recovery-title" className="renderer-recovery__title">
            {failure === 'load' ? `${name} couldn’t load` : `${name} ran into a problem`}
          </h1>
          <p className="renderer-recovery__body">
            {failure === 'load'
              ? 'Reload the window to try again.'
              : 'The rest of TasteCode is still running.'}
          </p>
          <div className="renderer-recovery-actions">
            <button
              type="button"
              className="renderer-recovery__secondary"
              onClick={this.props.onClose}
            >
              Back to app
            </button>
            {failure === 'load' ? (
              <button
                type="button"
                className="renderer-recovery__primary"
                ref={this.#focusPrimary}
                onClick={() => (this.props.reload ?? (() => window.location.reload()))()}
              >
                <IconRefresh size={15} stroke={2} aria-hidden="true" />
                Reload window
              </button>
            ) : (
              <button
                type="button"
                className="renderer-recovery__primary"
                ref={this.#focusPrimary}
                onClick={() => this.setState({ failure: 'none' })}
              >
                Try again
              </button>
            )}
          </div>
        </section>
      </div>
    )
  }
}
