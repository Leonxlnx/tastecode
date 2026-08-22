import type { ProviderId, ProviderStatus } from '@harness/contracts'
import { FolderOpen, Settings2 } from 'lucide-react'
import { providerMark } from '../model-catalog.js'
import { ProviderIcon } from './ProviderIcon.js'
import { useDialogFocus } from './dialog-focus.js'
import '../styles/welcome.css'

const providers = [
  { id: 'codex', name: 'Codex' },
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'grok', name: 'Grok' },
] as const satisfies ReadonlyArray<{ id: ProviderId; name: string }>

export function WelcomeDialog(props: {
  providerStatuses: ProviderStatus[]
  displayName: string
  onDisplayNameChange: (displayName: string) => void
  onAddProject: () => void
  onOpenProviders: () => void
  onDismiss: () => void
}) {
  const dialog = useDialogFocus<HTMLDivElement>(props.onDismiss)

  return (
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-title"
      onKeyDown={dialog.onKeyDown}
    >
      <div className="sheet__scrim" aria-hidden />
      <div className="sheet__panel welcome" ref={dialog.panel} tabIndex={-1}>
        <header className="welcome__head">
          <p className="welcome__eyebrow">Welcome to TasteCode</p>
          <h1 className="welcome__title" id="welcome-title">
            Start your first project
          </h1>
          <p className="welcome__copy">
            Add your name, then choose a folder. TasteCode finds the coding agents already on this
            machine.
          </p>
        </header>
        <div className="welcome__name">
          <label htmlFor="welcome-display-name">What should we call you?</label>
          <input
            id="welcome-display-name"
            type="text"
            autoComplete="name"
            autoFocus
            maxLength={64}
            value={props.displayName}
            placeholder="Your name"
            onChange={(event) => props.onDisplayNameChange(event.target.value)}
          />
          <p>You can change this later in Profile.</p>
        </div>
        <div className="welcome__providers" aria-label="Supported beta plans">
          {providers.map((provider) => {
            const status = props.providerStatuses.find((entry) => entry.id === provider.id)
            return (
              <div className="welcome__provider" key={provider.id}>
                <ProviderIcon mark={providerMark(provider.id)} />
                <span>{provider.name}</span>
                <small className={status?.installed ? 'is-ready' : undefined}>
                  {status ? (status.installed ? 'Installed' : 'Setup needed') : 'Checking…'}
                </small>
              </div>
            )
          })}
        </div>
        <p className="welcome__privacy">
          Your name, projects, and chats stay on this machine. Sign-in stays with each provider.
        </p>
        <footer className="welcome__actions">
          <button className="ghost" type="button" onClick={props.onDismiss}>
            Skip for now
          </button>
          <button className="ghost" type="button" onClick={props.onOpenProviders}>
            <Settings2 size={14} aria-hidden />
            Set up providers
          </button>
          <button className="btn" type="button" onClick={props.onAddProject}>
            <FolderOpen size={14} aria-hidden />
            Choose a project
          </button>
        </footer>
      </div>
    </div>
  )
}
