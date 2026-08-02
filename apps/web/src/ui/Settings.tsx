import { useEffect, useState, type ReactNode } from 'react'
import type {
  Account,
  ConnectionAddress,
  ConnectionsStatus,
  PairedDevice,
  ProviderId,
  ResultOf,
  SidebarSettings,
} from '@harness/contracts'
import {
  ArrowLeft,
  Blocks,
  Database,
  Info,
  LogOut,
  Network,
  Palette,
  PanelLeft,
  RotateCcw,
  Smartphone,
  UserRound,
} from 'lucide-react'
import { isDesktop } from '../bridge.js'
import type { Transport } from '../transport.js'
import type { ThemePreference } from '../theme.js'
import { McpSettings } from './McpSettings.js'
import { SkillsSettings } from './SkillsSettings.js'
import { renderQrSvg } from './qr-code.js'

type SettingsSection =
  'account' | 'mcp' | 'skills' | 'workflows' | 'connections' | 'appearance' | 'data' | 'about'
type ConnectionsPairing = Pick<ResultOf<'connections.startPairing'>, 'pairingUri' | 'expiresAt'>

const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const satisfies ReadonlyArray<{ value: ThemePreference; label: string }>

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

/**
 * Settings stays intentionally small: the sidebar reorganizes the decisions
 * the app already exposes without inventing preferences for their own sake.
 */
export function Settings(props: {
  provider: ProviderId
  providerName: string
  transport: Transport
  projectPath: string | undefined
  projectName: string | undefined
  account: Account | undefined
  connectionsStatus: ConnectionsStatus | undefined
  connectionsLoading: boolean
  connectionsError: string | undefined
  connectionsPairing: ConnectionsPairing | undefined
  pairingBusy: boolean
  stoppingConnections: boolean
  revokingDeviceId: string | undefined
  projectCount: number
  sidebarSettings: SidebarSettings
  onSidebarSettingsChange: (settings: Partial<SidebarSettings>) => void
  themePreference: ThemePreference
  onThemePreferenceChange: (theme: ThemePreference) => void
  showMacOSFontSmoothing: boolean
  macOSFontSmoothing: boolean
  onMacOSFontSmoothingChange: (enabled: boolean) => void
  onGeneratePairing: () => void
  onStopConnections: () => void
  onRevokeDevice: (deviceId: string) => void
  onSignOut: () => void
  onReset: () => void
  onClose: () => void
}) {
  const [section, setSection] = useState<SettingsSection>('account')

  return (
    <div className="settings" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings__titlebar" aria-hidden />

      <aside className="settings__sidebar">
        <button className="settings__back" type="button" onClick={props.onClose}>
          <ArrowLeft size={14} aria-hidden />
          <span>Back to app</span>
        </button>

        <p className="settings__nav-label">Settings</p>
        <nav className="settings__nav" aria-label="Settings categories">
          <SettingsNavItem
            active={section === 'account'}
            icon={<UserRound size={15} aria-hidden />}
            label="Account"
            onClick={() => setSection('account')}
          />
          <SettingsNavItem
            active={section === 'mcp'}
            icon={<Network size={15} aria-hidden />}
            label="MCP"
            onClick={() => setSection('mcp')}
          />
          <SettingsNavItem
            active={section === 'skills'}
            icon={<Blocks size={15} aria-hidden />}
            label="Skills"
            onClick={() => setSection('skills')}
          />
          <SettingsNavItem
            active={section === 'workflows'}
            icon={<PanelLeft size={15} aria-hidden />}
            label="Workflows"
            onClick={() => setSection('workflows')}
          />
          <SettingsNavItem
            active={section === 'connections'}
            icon={<Smartphone size={15} aria-hidden />}
            label="Connections"
            onClick={() => setSection('connections')}
          />
          <SettingsNavItem
            active={section === 'appearance'}
            icon={<Palette size={15} aria-hidden />}
            label="Appearance"
            onClick={() => setSection('appearance')}
          />
          <SettingsNavItem
            active={section === 'data'}
            icon={<Database size={15} aria-hidden />}
            label="Data"
            onClick={() => setSection('data')}
          />
          <SettingsNavItem
            active={section === 'about'}
            icon={<Info size={15} aria-hidden />}
            label="About"
            onClick={() => setSection('about')}
          />
        </nav>
      </aside>

      <main className="settings__main">
        <div className="settings__content">
          {section === 'account' ? <AccountSettings {...props} /> : null}
          {section === 'mcp' ? <McpSettings {...props} /> : null}
          {section === 'skills' ? <SkillsSettings {...props} /> : null}
          {section === 'workflows' ? <WorkflowSettings {...props} /> : null}
          {section === 'connections' ? <ConnectionsSettings {...props} /> : null}
          {section === 'appearance' ? <AppearanceSettings {...props} /> : null}
          {section === 'data' ? <DataSettings {...props} /> : null}
          {section === 'about' ? <AboutSettings /> : null}
        </div>
      </main>
    </div>
  )
}

function WorkflowSettings(props: {
  sidebarSettings: SidebarSettings
  onSidebarSettingsChange: (settings: Partial<SidebarSettings>) => void
}) {
  const inbox = props.sidebarSettings.mode === 'inbox'
  const autoSettle = props.sidebarSettings.autoSettleDays !== null

  return (
    <SettingsPanel title="Workflows" groupTitle="Sidebar">
      <SettingsRow
        title="Inbox sidebar"
        note="Show one work queue across projects, with snoozed and settled shelves."
      >
        <button
          className={`switch${inbox ? ' is-on' : ''}`}
          type="button"
          role="switch"
          aria-label="Inbox sidebar"
          aria-checked={inbox}
          onClick={() => props.onSidebarSettingsChange({ mode: inbox ? 'classic' : 'inbox' })}
        >
          <span className="switch__thumb" />
        </button>
      </SettingsRow>
      <SettingsRow
        title="Settle inactive chats"
        note="Move eligible inactive work out of the queue after this many days."
      >
        <div className="settings__inline-controls">
          <input
            className="settings__number"
            type="number"
            aria-label="Auto-settle days"
            min={1}
            max={90}
            disabled={!autoSettle}
            value={props.sidebarSettings.autoSettleDays ?? 3}
            onChange={(event) => {
              const days = event.currentTarget.valueAsNumber
              if (Number.isInteger(days) && days >= 1 && days <= 90) {
                props.onSidebarSettingsChange({ autoSettleDays: days })
              }
            }}
          />
          <button
            className={`switch${autoSettle ? ' is-on' : ''}`}
            type="button"
            role="switch"
            aria-label="Automatic settling"
            aria-checked={autoSettle}
            onClick={() => props.onSidebarSettingsChange({ autoSettleDays: autoSettle ? null : 3 })}
          >
            <span className="switch__thumb" />
          </button>
        </div>
      </SettingsRow>
    </SettingsPanel>
  )
}

function SettingsNavItem(props: {
  active: boolean
  icon: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      className={`settings__nav-item${props.active ? ' is-active' : ''}`}
      type="button"
      aria-current={props.active ? 'page' : undefined}
      onClick={props.onClick}
    >
      {props.icon}
      <span>{props.label}</span>
    </button>
  )
}

function AccountSettings(props: {
  providerName: string
  account: Account | undefined
  onSignOut: () => void
}) {
  const accountStatus = props.account?.signedIn
    ? [props.account.email, props.account.plan].filter(Boolean).join(' · ') || 'Signed in'
    : 'Not signed in'

  return (
    <SettingsPanel title="Account" groupTitle="Provider">
      <SettingsRow title={props.providerName} note={accountStatus}>
        {props.account?.signedIn ? (
          <button className="settings__action" type="button" onClick={props.onSignOut}>
            <LogOut size={13} aria-hidden />
            <span>Sign out</span>
          </button>
        ) : null}
      </SettingsRow>
      <p className="settings__group-note">
        Signing out is handled by {props.providerName} itself. Personal Harness holds no credential
        to discard.
      </p>
    </SettingsPanel>
  )
}

function ConnectionsSettings(props: {
  connectionsStatus: ConnectionsStatus | undefined
  connectionsLoading: boolean
  connectionsError: string | undefined
  connectionsPairing: ConnectionsPairing | undefined
  pairingBusy: boolean
  stoppingConnections: boolean
  revokingDeviceId: string | undefined
  onGeneratePairing: () => void
  onStopConnections: () => void
  onRevokeDevice: (deviceId: string) => void
}) {
  const [qrSvg, setQrSvg] = useState<string | undefined>()
  const [qrError, setQrError] = useState<string | undefined>()
  const [pairingCopied, setPairingCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setNow(Date.now())
    if (!props.connectionsPairing) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [props.connectionsPairing])

  const pairingExpired =
    props.connectionsPairing !== undefined && props.connectionsPairing.expiresAt <= now
  const activePairing = pairingExpired ? undefined : props.connectionsPairing

  useEffect(() => {
    if (!activePairing) {
      setQrSvg(undefined)
      setQrError(undefined)
      return
    }
    let cancelled = false
    setQrSvg(undefined)
    setQrError(undefined)
    setPairingCopied(false)
    void renderQrSvg(activePairing.pairingUri)
      .then((svg) => {
        if (!cancelled) setQrSvg(svg)
      })
      .catch((error) => {
        if (!cancelled) setQrError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [activePairing])

  const statusState = readConnectionsState(
    props.connectionsStatus,
    props.connectionsLoading,
    props.connectionsError,
  )
  const statusTitle = statusTitleFor(props.connectionsStatus, statusState)
  const statusNote = statusNoteFor(props.connectionsStatus, statusState)

  return (
    <section className="settings__panel" aria-labelledby="settings-connections">
      <h1 className="settings__title" id="settings-connections">
        Connections
      </h1>

      <div className="settings__stack">
        <div>
          <h2 className="settings__group-title">Mobile access</h2>
          <div className="settings__group">
            <SettingsRow title={statusTitle} note={statusNote}>
              <SettingsStatusBadge state={statusState} />
            </SettingsRow>

            {props.connectionsStatus?.addresses.length ? (
              <div className="settings__subsection">
                <p className="settings__row-title">Reachable addresses</p>
                <p className="settings__row-note">
                  Tailscale is preferred and stays encrypted across networks. Use the LAN route only
                  on a private network you trust.
                </p>
                <div className="settings__pills" aria-label="Reachable addresses">
                  {props.connectionsStatus.addresses.map((address) => (
                    <AddressPill address={address} key={`${address.kind}-${address.url}`} />
                  ))}
                </div>
              </div>
            ) : null}

            <div className="settings__subsection">
              <div className="settings__actions">
                <button
                  className="settings__action"
                  type="button"
                  onClick={props.onGeneratePairing}
                  disabled={props.pairingBusy}
                >
                  <span>{props.pairingBusy ? 'Generating QR...' : 'Generate QR'}</span>
                </button>

                {props.connectionsStatus?.enabled ? (
                  <button
                    className="settings__action settings__action--danger"
                    type="button"
                    onClick={props.onStopConnections}
                    disabled={props.stoppingConnections}
                  >
                    <span>{props.stoppingConnections ? 'Stopping...' : 'Stop mobile access'}</span>
                  </button>
                ) : null}
              </div>
            </div>

            {props.connectionsError ? (
              <p className="settings__inline-error" role="alert">
                {props.connectionsError}
              </p>
            ) : null}
          </div>
        </div>

        <div>
          <h2 className="settings__group-title">Pairing code</h2>
          <div className="settings__group">
            {activePairing ? (
              <div className="settings__qr-card">
                <div className="settings__qr-frame">
                  {qrSvg ? (
                    <div
                      className="settings__qr-art"
                      role="img"
                      aria-label="Pairing QR code"
                      dangerouslySetInnerHTML={{ __html: qrSvg }}
                    />
                  ) : (
                    <p className="settings__empty-state">Generating the QR image...</p>
                  )}
                </div>
                <div className="settings__qr-copy">
                  <p className="settings__row-title">Scan from the mobile app</p>
                  <p className="settings__row-note" aria-live="polite">
                    Expires in {formatCountdown(activePairing.expiresAt - now)}. The ticket works
                    once, then the phone keeps its own device token.
                  </p>
                  <button
                    className="settings__action"
                    type="button"
                    onClick={() => {
                      const clipboard = navigator.clipboard
                      if (!clipboard) {
                        setQrError('Clipboard access is unavailable in this window')
                        return
                      }
                      void clipboard
                        .writeText(activePairing.pairingUri)
                        .then(() => setPairingCopied(true))
                        .catch((error) =>
                          setQrError(error instanceof Error ? error.message : String(error)),
                        )
                    }}
                  >
                    <span>{pairingCopied ? 'Pairing link copied' : 'Copy pairing link'}</span>
                  </button>
                  {qrError ? (
                    <p
                      className="settings__inline-error settings__inline-error--quiet"
                      role="alert"
                    >
                      {qrError}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="settings__empty-state">
                {pairingExpired
                  ? 'The last QR code expired. Generate a fresh one when the phone is ready.'
                  : 'Generate a one-time QR code here, then scan it from the mobile app.'}
              </p>
            )}
          </div>
        </div>

        <div>
          <h2 className="settings__group-title">Paired devices</h2>
          <div className="settings__group">
            {props.connectionsStatus?.devices.length ? (
              props.connectionsStatus.devices.map((device) => (
                <SettingsRow
                  key={device.id}
                  title={device.name}
                  note={formatDeviceNote(device, now)}
                >
                  <button
                    className="settings__action"
                    type="button"
                    aria-label={`Revoke ${device.name}`}
                    onClick={() => props.onRevokeDevice(device.id)}
                    disabled={props.revokingDeviceId === device.id}
                  >
                    <span>{props.revokingDeviceId === device.id ? 'Revoking...' : 'Revoke'}</span>
                  </button>
                </SettingsRow>
              ))
            ) : (
              <p className="settings__empty-state">
                {props.connectionsLoading
                  ? 'Loading paired devices...'
                  : 'No phones have been paired with this machine yet.'}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

function AppearanceSettings(props: {
  themePreference: ThemePreference
  onThemePreferenceChange: (theme: ThemePreference) => void
  showMacOSFontSmoothing: boolean
  macOSFontSmoothing: boolean
  onMacOSFontSmoothingChange: (enabled: boolean) => void
}) {
  return (
    <SettingsPanel title="Appearance" groupTitle="Theme" groupClassName="settings__group--plain">
      <ThemePicker value={props.themePreference} onChange={props.onThemePreferenceChange} />
      {props.showMacOSFontSmoothing ? (
        <div className="appearance__text">
          <h2 className="settings__group-title">Text</h2>
          <div className="settings__group">
            <SettingsRow
              title="Font smoothing"
              note="Use macOS antialiasing for lighter, crisper text."
            >
              <button
                className={`switch${props.macOSFontSmoothing ? ' is-on' : ''}`}
                type="button"
                role="switch"
                aria-label="Font smoothing"
                aria-checked={props.macOSFontSmoothing}
                onClick={() => props.onMacOSFontSmoothingChange(!props.macOSFontSmoothing)}
              >
                <span className="switch__thumb" />
              </button>
            </SettingsRow>
          </div>
        </div>
      ) : null}
    </SettingsPanel>
  )
}

function ThemePicker(props: {
  value: ThemePreference
  onChange: (theme: ThemePreference) => void
}) {
  return (
    <fieldset className="theme-picker">
      <legend className="visually-hidden">Theme</legend>
      {THEME_OPTIONS.map((option) => {
        const selected = props.value === option.value

        return (
          <label className={`theme-option${selected ? ' is-selected' : ''}`} key={option.value}>
            <input
              type="radio"
              name="theme"
              value={option.value}
              checked={selected}
              onChange={() => props.onChange(option.value)}
            />
            <span className={`theme-preview theme-preview--${option.value}`} aria-hidden>
              <span className="theme-preview__header" />
              <span className="theme-preview__subhead" />
              <span className="theme-preview__panel">
                <span className="theme-preview__row">
                  <span className="theme-preview__row-title" />
                  <span className="theme-preview__row-copy" />
                </span>
                <span className="theme-preview__row">
                  <span className="theme-preview__row-title" />
                  <span className="theme-preview__row-copy" />
                </span>
              </span>
            </span>
            <span className="theme-option__label">{option.label}</span>
          </label>
        )
      })}
    </fieldset>
  )
}

function DataSettings(props: { projectCount: number; onReset: () => void }) {
  const projectLabel = `${props.projectCount} ${props.projectCount === 1 ? 'project' : 'projects'} on this machine`

  return (
    <SettingsPanel title="Data" groupTitle="Local data">
      <SettingsRow
        title={projectLabel}
        note="Stored locally. Nothing is uploaded anywhere, by us or on your behalf."
      >
        <button className="settings__action" type="button" onClick={props.onReset}>
          <RotateCcw size={13} aria-hidden />
          <span>Reset app</span>
        </button>
      </SettingsRow>
    </SettingsPanel>
  )
}

function AboutSettings() {
  return (
    <SettingsPanel title="About" groupTitle="Personal Harness">
      <SettingsRow
        title="Personal Harness"
        note={`${isDesktop ? 'Desktop' : 'Browser'} · pre-release`}
      />
      <p className="settings__group-note">Open source, and built to be forked.</p>
    </SettingsPanel>
  )
}

function SettingsPanel(props: {
  title: string
  groupTitle: string
  groupClassName?: string
  children: ReactNode
}) {
  return (
    <section className="settings__panel" aria-labelledby={`settings-${props.title.toLowerCase()}`}>
      <h1 className="settings__title" id={`settings-${props.title.toLowerCase()}`}>
        {props.title}
      </h1>
      <h2 className="settings__group-title">{props.groupTitle}</h2>
      <div className={`settings__group${props.groupClassName ? ` ${props.groupClassName}` : ''}`}>
        {props.children}
      </div>
    </section>
  )
}

function SettingsRow(props: { title: string; note: string; children?: ReactNode }) {
  return (
    <div className="settings__row">
      <div className="settings__row-copy">
        <p className="settings__row-title">{props.title}</p>
        <p className="settings__row-note">{props.note}</p>
      </div>
      {props.children ? <div className="settings__row-control">{props.children}</div> : null}
    </div>
  )
}

function SettingsStatusBadge(props: { state: 'on' | 'off' | 'loading' | 'unavailable' }) {
  const label =
    props.state === 'on'
      ? 'On'
      : props.state === 'off'
        ? 'Off'
        : props.state === 'loading'
          ? 'Loading'
          : 'Unavailable'

  return <span className={`settings__status-badge is-${props.state}`}>{label}</span>
}

function AddressPill(props: { address: ConnectionAddress }) {
  return (
    <span className="settings__pill" title={props.address.url}>
      <span className="settings__pill-kind">{addressKindLabel(props.address.kind)}</span>
      <span className="settings__pill-label">{props.address.label}</span>
    </span>
  )
}

function addressKindLabel(kind: ConnectionAddress['kind']): string {
  return kind === 'tailscale' ? 'Tailscale' : 'LAN'
}

function readConnectionsState(
  status: ConnectionsStatus | undefined,
  loading: boolean,
  error: string | undefined,
): 'on' | 'off' | 'loading' | 'unavailable' {
  if (status) return status.enabled ? 'on' : 'off'
  if (loading || !error) return 'loading'
  return 'unavailable'
}

function statusTitleFor(
  status: ConnectionsStatus | undefined,
  state: 'on' | 'off' | 'loading' | 'unavailable',
): string {
  if (state === 'on') return 'Mobile access is on'
  if (state === 'off') return 'Mobile access is off'
  if (state === 'loading') return 'Checking mobile access'
  return status ? `${status.serverName} is unavailable` : 'Mobile access is unavailable'
}

function statusNoteFor(
  status: ConnectionsStatus | undefined,
  state: 'on' | 'off' | 'loading' | 'unavailable',
): string {
  if (state === 'loading') {
    return 'Reading the listener state and any reachable addresses from the local server.'
  }
  if (state === 'unavailable') {
    return 'The settings surface could not read the current listener state from the server.'
  }
  if (!status) return 'The local server did not return a connections status yet.'
  if (state === 'on') {
    return `${status.serverName} is listening on port ${status.port}. Generate a fresh QR code whenever a phone is ready to claim access.`
  }
  return `${status.serverName} is not listening for mobile clients right now. Generate a QR code to turn access on and mint a short-lived pairing ticket.`
}

function formatCountdown(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.ceil(msRemaining / 1000))
  if (totalSeconds >= 3600) {
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  if (totalSeconds >= 60) {
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  }
  return `${totalSeconds}s`
}

function formatDeviceNote(device: PairedDevice, now: number): string {
  return `Seen ${formatAge(device.lastSeenAt, now)} · paired ${DATE_FORMAT.format(device.createdAt)}`
}

function formatAge(timestamp: number, now: number): string {
  const diff = Math.max(0, now - timestamp)
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}
