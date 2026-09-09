import type { ProviderId, ProviderStatus } from '@harness/contracts'
import { IconFolderOpen as FolderOpen, IconSettings2 as Settings2 } from '@tabler/icons-react'
import '../styles/welcome.css'
import { providerMark } from '../model-catalog.js'
import { ProviderIcon } from './ProviderIcon.js'
import { useDialogFocus } from './dialog-focus.js'

const providers = [
  { id: 'codex', name: 'Codex' },
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'grok', name: 'Grok' },
] as const satisfies ReadonlyArray<{ id: ProviderId; name: string }>

export function WelcomeDialog(props: {
  providerStatuses: ProviderStatus[]
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
            Choose a folder. TasteCode finds the coding agents already on this machine.
          </p>
        </header>
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
          Projects and chats stay on this machine. Sign-in stays with each provider.
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
