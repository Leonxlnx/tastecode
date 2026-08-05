import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type {
  Account,
  ModelConnection,
  ModelConnectionPreset,
  ModelTransport,
  ProviderId,
  ProviderSetup,
  ProviderStatus,
  ResultOf,
  SidebarSettings,
} from '@harness/contracts'
import {
  ArrowLeft,
  Blocks,
  ChevronDown,
  Database,
  Info,
  LogOut,
  Boxes,
  KeyRound,
  Network,
  Palette,
  PanelLeft,
  RotateCcw,
  UserRound,
} from 'lucide-react'
import { agentMark, connectionMark, providerMark, type ModelChoice } from '../model-catalog.js'
import { isDesktop } from '../bridge.js'
import {
  beginInstall,
  clearInstall,
  installKey,
  installState,
  subscribeInstalls,
  type InstallTarget,
} from '../provider-install.js'
import type { Transport } from '../transport.js'
import { InstallTerminal } from './InstallTerminal.js'
import type { AccentPreference, FontPreference, ThemePreference } from '../theme.js'
import { McpSettings } from './McpSettings.js'
import { Menu, MenuItem } from './Menu.js'
import { SkillsSettings } from './SkillsSettings.js'
import { ProviderIcon } from './ProviderIcon.js'

type SettingsSection =
  'providers' | 'models' | 'mcp' | 'skills' | 'workflows' | 'appearance' | 'data' | 'about'

const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const satisfies ReadonlyArray<{ value: ThemePreference; label: string }>

const FONT_OPTIONS = [
  { value: 'geist', label: 'Geist' },
  { value: 'system', label: 'System' },
  { value: 'humanist', label: 'Humanist' },
  { value: 'rounded', label: 'Rounded' },
  { value: 'serif', label: 'Editorial' },
  { value: 'mono', label: 'Mono' },
] as const satisfies ReadonlyArray<{ value: FontPreference; label: string }>

const ACCENT_OPTIONS = [
  { value: 'neutral', label: 'Neutral' },
  { value: 'ocean', label: 'Ocean' },
  { value: 'forest', label: 'Forest' },
  { value: 'sunset', label: 'Sunset' },
  { value: 'amber', label: 'Amber' },
  { value: 'rose', label: 'Rose' },
  { value: 'lavender', label: 'Lavender' },
] as const satisfies ReadonlyArray<{ value: AccentPreference; label: string }>

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
  providerStatuses: ProviderStatus[]
  acpAgents: ResultOf<'acp.agents'>['agents']
  modelConnections: ModelConnection[]
  models: ModelChoice[]
  hiddenModels: Set<string>
  onModelVisibilityChange: (key: string, visible: boolean) => void
  onConnectionsChanged: () => void
  projectCount: number
  sidebarSettings: SidebarSettings
  onSidebarSettingsChange: (settings: Partial<SidebarSettings>) => void
  themePreference: ThemePreference
  onThemePreferenceChange: (theme: ThemePreference) => void
  fontPreference: FontPreference
  onFontPreferenceChange: (font: FontPreference) => void
  accentPreference: AccentPreference
  onAccentPreferenceChange: (accent: AccentPreference) => void
  showMacOSFontSmoothing: boolean
  macOSFontSmoothing: boolean
  onMacOSFontSmoothingChange: (enabled: boolean) => void
  onAccountChange: (provider: ProviderId, account: Account) => void
  onReset: () => void
  onClose: () => void
}) {
  const [section, setSection] = useState<SettingsSection>('providers')

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
            active={section === 'providers'}
            icon={<UserRound size={15} aria-hidden />}
            label="Providers"
            onClick={() => setSection('providers')}
          />
          <SettingsNavItem
            active={section === 'models'}
            icon={<Boxes size={15} aria-hidden />}
            label="Models"
            onClick={() => setSection('models')}
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
          {section === 'providers' ? <ProviderSettings {...props} /> : null}
          {section === 'models' ? <ModelSettings {...props} /> : null}
          {section === 'mcp' ? <McpSettings {...props} /> : null}
          {section === 'skills' ? <SkillsSettings {...props} /> : null}
          {section === 'workflows' ? <WorkflowSettings {...props} /> : null}
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

const CONNECTION_PRESETS: Record<
  ModelConnectionPreset,
  { label: string; transport: ModelTransport; baseUrl: string; placeholder: string }
> = {
  openai: {
    label: 'OpenAI API',
    transport: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    placeholder: 'gpt-5.6',
  },
  anthropic: {
    label: 'Anthropic API',
    transport: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com/v1',
    placeholder: 'claude-sonnet-4-6',
  },
  openrouter: {
    label: 'OpenRouter',
    transport: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    placeholder: 'anthropic/claude-sonnet-4.6',
  },
  kimi: {
    label: 'Kimi API',
    transport: 'openai-compatible',
    baseUrl: 'https://api.moonshot.ai/v1',
    placeholder: 'kimi-k2.5',
  },
  zai: {
    label: 'Z.ai API',
    transport: 'openai-compatible',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    placeholder: 'glm-5',
  },
  custom: {
    label: 'Custom endpoint',
    transport: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    placeholder: 'model-id',
  },
}

function ProviderSettings(props: {
  provider: ProviderId
  providerName: string
  account: Account | undefined
  providerStatuses: ProviderStatus[]
  acpAgents: ResultOf<'acp.agents'>['agents']
  modelConnections: ModelConnection[]
  transport: Transport
  onConnectionsChanged: () => void
  onAccountChange: (provider: ProviderId, account: Account) => void
}) {
  const [adding, setAdding] = useState(false)
  const [preset, setPreset] = useState<ModelConnectionPreset>('openai')
  const [name, setName] = useState('OpenAI API')
  const [baseUrl, setBaseUrl] = useState(CONNECTION_PRESETS.openai.baseUrl)
  const [defaultModel, setDefaultModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [accounts, setAccounts] = useState<Partial<Record<ProviderId, Account>>>({})
  const [authBusy, setAuthBusy] = useState<ProviderId>()
  const [authError, setAuthError] = useState<string>()

  const refreshAccount = useCallback(
    async (provider: ProviderId) => {
      const account = await props.transport.request('auth.status', { provider })
      setAccounts((current) => ({ ...current, [provider]: account }))
      props.onAccountChange(provider, account)
    },
    [props.transport, props.onAccountChange],
  )

  useEffect(() => {
    for (const status of props.providerStatuses) {
      if (status.installed && status.id !== 'acp') {
        void refreshAccount(status.id).catch(() =>
          setAccounts((current) => ({ ...current, [status.id]: { signedIn: false } })),
        )
      }
    }
    return props.transport.on('auth.event', (event) => {
      if (event.agent) return
      setAuthBusy((current) => (current === event.provider ? undefined : current))
      if (event.success) {
        setAuthError(undefined)
        void refreshAccount(event.provider).catch((cause) =>
          setAuthError(cause instanceof Error ? cause.message : String(cause)),
        )
      } else {
        setAuthError(event.error ?? 'Sign-in was cancelled.')
      }
    })
  }, [props.transport, props.providerStatuses, refreshAccount])

  const signIn = async (provider: ProviderId) => {
    setAuthBusy(provider)
    setAuthError(undefined)
    try {
      const result = await props.transport.request('auth.startLogin', { provider })
      if (result.authUrl) window.open(result.authUrl, '_blank', 'noopener,noreferrer')
    } catch (cause) {
      setAuthBusy(undefined)
      setAuthError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const signOut = async (provider: ProviderId) => {
    setAuthBusy(provider)
    setAuthError(undefined)
    try {
      await props.transport.request('auth.signOut', { provider })
      const account = { signedIn: false }
      setAccounts((current) => ({ ...current, [provider]: account }))
      props.onAccountChange(provider, account)
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAuthBusy(undefined)
    }
  }

  const choosePreset = (next: ModelConnectionPreset) => {
    const config = CONNECTION_PRESETS[next]
    setPreset(next)
    setName(config.label)
    setBaseUrl(config.baseUrl)
    setDefaultModel('')
  }

  const addConnection = async () => {
    setSaving(true)
    setError(undefined)
    try {
      const id = `${preset}-${crypto.randomUUID()}`
      await props.transport.request('connections.upsert', {
        id,
        displayName: name.trim(),
        preset,
        transport: CONNECTION_PRESETS[preset].transport,
        baseUrl: baseUrl.trim(),
        ...(defaultModel.trim() ? { defaultModel: defaultModel.trim() } : {}),
        enabled: true,
      })
      await props.transport.request('connections.setCredential', {
        connectionId: id,
        apiKey: apiKey.trim(),
      })
      setAdding(false)
      setApiKey('')
      props.onConnectionsChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsPanel title="Providers" groupTitle="Agent subscriptions">
      {authError ? (
        <p className="provider-form__error" role="alert">
          {authError}
        </p>
      ) : null}
      {props.providerStatuses
        .filter((status) => status.id !== 'acp')
        .map((status) => {
          const account =
            accounts[status.id] ?? (status.id === props.provider ? props.account : undefined)
          if (!status.installed && !account?.signedIn) {
            return (
              <InstallableRow
                key={status.id}
                title={status.displayName}
                idleNote={
                  status.setup?.installCommand ?? status.problem ?? 'Provider CLI is not installed.'
                }
                icon={<ProviderIcon mark={providerMark(status.id)} size={17} />}
                target={{ provider: status.id }}
                setup={status.setup}
                transport={props.transport}
                onInstalled={props.onConnectionsChanged}
              />
            )
          }
          const accountStatus = account?.signedIn
            ? [account.email, account.plan].filter(Boolean).join(' · ') || 'Signed in'
            : status.setup?.login === 'provider'
              ? 'Finish sign-in in the provider CLI.'
              : 'Not signed in'
          const busy = authBusy === status.id
          return (
            <SettingsRow key={status.id} title={status.displayName} note={accountStatus}>
              <div className="provider-settings__actions">
                <ProviderIcon mark={providerMark(status.id)} size={17} />
                {account?.signedIn ? (
                  <button
                    className="settings__action"
                    type="button"
                    disabled={busy}
                    onClick={() => void signOut(status.id)}
                  >
                    <LogOut size={13} aria-hidden />
                    {busy ? 'Signing out…' : 'Sign out'}
                  </button>
                ) : status.setup?.login === 'provider' ? (
                  <button
                    className="settings__action"
                    type="button"
                    onClick={() =>
                      window.open(status.setup!.installUrl, '_blank', 'noopener,noreferrer')
                    }
                  >
                    Sign in
                  </button>
                ) : (
                  <button
                    className="settings__action"
                    type="button"
                    disabled={busy}
                    onClick={() => void signIn(status.id)}
                  >
                    {busy ? 'Signing in…' : 'Sign in'}
                  </button>
                )}
              </div>
            </SettingsRow>
          )
        })}

      {props.acpAgents.map((agent) =>
        agent.installed ? (
          <SettingsRow
            key={agent.id}
            title={agent.name}
            note="Installed · sign-in is managed by the provider CLI."
          >
            <div className="provider-settings__actions">
              <ProviderIcon mark={agentMark(agent.id)} size={17} />
              <button
                className="settings__action"
                type="button"
                onClick={() => window.open(agent.setup.installUrl, '_blank', 'noopener,noreferrer')}
              >
                Sign in
              </button>
            </div>
          </SettingsRow>
        ) : (
          <InstallableRow
            key={agent.id}
            title={agent.name}
            idleNote={agent.setup.installCommand ?? 'Provider CLI is not installed.'}
            icon={<ProviderIcon mark={agentMark(agent.id)} size={17} />}
            target={{ provider: 'acp', agent: agent.id }}
            setup={agent.setup}
            transport={props.transport}
            onInstalled={props.onConnectionsChanged}
          />
        ),
      )}

      <h2 className="settings__group-title settings__group-title--inside">API connections</h2>
      {props.modelConnections.map((connection) => (
        <SettingsRow
          key={connection.id}
          title={connection.displayName}
          note={`${CONNECTION_PRESETS[connection.preset].label} · ${connection.credentialConfigured ? 'Key stored securely' : 'Key missing'}`}
        >
          <div className="provider-settings__actions">
            <ProviderIcon mark={connectionMark(connection.preset)} size={17} />
            <button
              className="settings__action is-danger"
              type="button"
              onClick={() => {
                void props.transport
                  .request('connections.remove', { connectionId: connection.id })
                  .then(props.onConnectionsChanged)
              }}
            >
              Remove
            </button>
          </div>
        </SettingsRow>
      ))}
      {adding ? (
        <div className="provider-form">
          <div className="provider-form__field">
            <span>Provider</span>
            <Menu
              align="left"
              drop="down"
              label={`Provider, ${CONNECTION_PRESETS[preset].label}`}
              panelLabel="API provider"
              panelClassName="provider-form__menu"
              triggerClassName="provider-form__select"
              trigger={(open) => (
                <>
                  <span className="provider-form__select-value">
                    <ProviderIcon mark={connectionMark(preset)} size={16} />
                    {CONNECTION_PRESETS[preset].label}
                  </span>
                  <ChevronDown className={open ? 'is-open' : undefined} size={14} aria-hidden />
                </>
              )}
            >
              {(close) =>
                Object.entries(CONNECTION_PRESETS).map(([value, config]) => (
                  <MenuItem
                    key={value}
                    title={config.label}
                    active={value === preset}
                    onClick={() => {
                      choosePreset(value as ModelConnectionPreset)
                      close()
                    }}
                  />
                ))
              }
            </Menu>
          </div>
          <label>
            <span>Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="provider-form__wide">
            <span>Base URL</span>
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              spellCheck={false}
            />
          </label>
          <label>
            <span>Default model</span>
            <input
              value={defaultModel}
              onChange={(event) => setDefaultModel(event.target.value)}
              placeholder={CONNECTION_PRESETS[preset].placeholder}
              spellCheck={false}
            />
          </label>
          <label className="provider-form__wide">
            <span>API key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
            />
          </label>
          {error ? <p className="provider-form__error">{error}</p> : null}
          <div className="provider-form__actions">
            <button className="ghost" type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button
              className="btn"
              type="button"
              disabled={saving || !name.trim() || !baseUrl.trim() || !apiKey.trim()}
              onClick={() => void addConnection()}
            >
              {saving ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </div>
      ) : (
        <button className="provider-settings__add" type="button" onClick={() => setAdding(true)}>
          <KeyRound size={15} aria-hidden />
          Connect another plan or API
        </button>
      )}
    </SettingsPanel>
  )
}

function ModelSettings(props: {
  models: ModelChoice[]
  hiddenModels: Set<string>
  onModelVisibilityChange: (key: string, visible: boolean) => void
}) {
  const sources = props.models.reduce((groups, choice) => {
    const group = groups.get(choice.sourceName) ?? []
    group.push(choice)
    groups.set(choice.sourceName, group)
    return groups
  }, new Map<string, ModelChoice[]>())
  return (
    <SettingsPanel title="Models" groupTitle="Composer model list">
      <p className="settings__group-note settings__group-note--top">
        Show only the models you actually use. This does not disconnect the provider.
      </p>
      {[...sources.entries()].map(([source, choices]) => (
        <div className="model-visibility" key={source}>
          <div className="model-visibility__source">
            {choices[0] ? <ProviderIcon mark={choices[0].mark} size={17} /> : null}
            <span>{source}</span>
          </div>
          {choices.map((choice) => {
            const visible = !props.hiddenModels.has(choice.key)
            return (
              <SettingsRow
                key={choice.key}
                title={choice.model.displayName}
                note={choice.model.description ?? 'Available from this provider'}
              >
                <button
                  className={`switch${visible ? ' is-on' : ''}`}
                  type="button"
                  role="switch"
                  aria-label={`Show ${choice.model.displayName}`}
                  aria-checked={visible}
                  onClick={() => props.onModelVisibilityChange(choice.key, !visible)}
                >
                  <span className="switch__thumb" />
                </button>
              </SettingsRow>
            )
          })}
        </div>
      ))}
    </SettingsPanel>
  )
}

function AppearanceSettings(props: {
  themePreference: ThemePreference
  onThemePreferenceChange: (theme: ThemePreference) => void
  fontPreference: FontPreference
  onFontPreferenceChange: (font: FontPreference) => void
  accentPreference: AccentPreference
  onAccentPreferenceChange: (accent: AccentPreference) => void
  showMacOSFontSmoothing: boolean
  macOSFontSmoothing: boolean
  onMacOSFontSmoothingChange: (enabled: boolean) => void
}) {
  return (
    <SettingsPanel title="Appearance" groupTitle="Theme" groupClassName="settings__group--plain">
      <ThemePicker value={props.themePreference} onChange={props.onThemePreferenceChange} />
      <div className="appearance__text">
        <h2 className="settings__group-title">Interface font</h2>
        <fieldset className="appearance-picker" aria-label="Interface font">
          {FONT_OPTIONS.map((option) => (
            <button
              className={`appearance-choice${props.fontPreference === option.value ? ' is-selected' : ''}`}
              type="button"
              aria-pressed={props.fontPreference === option.value}
              onClick={() => props.onFontPreferenceChange(option.value)}
              key={option.value}
            >
              <span
                className="appearance-choice__font"
                data-font-preview={option.value}
                aria-hidden
              >
                Ag
              </span>
              <span>{option.label}</span>
            </button>
          ))}
        </fieldset>
      </div>
      <div className="appearance__text">
        <h2 className="settings__group-title">Accent palette</h2>
        <fieldset
          className="appearance-picker appearance-picker--accent"
          aria-label="Accent palette"
        >
          {ACCENT_OPTIONS.map((option) => (
            <button
              className={`appearance-choice${props.accentPreference === option.value ? ' is-selected' : ''}`}
              type="button"
              aria-pressed={props.accentPreference === option.value}
              onClick={() => props.onAccentPreferenceChange(option.value)}
              key={option.value}
            >
              <span
                className="appearance-choice__swatch"
                data-accent-preview={option.value}
                aria-hidden
              />
              <span>{option.label}</span>
            </button>
          ))}
        </fieldset>
      </div>
      {props.showMacOSFontSmoothing ? (
        <div className="appearance__text">
          <h2 className="settings__group-title">Text rendering</h2>
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

/**
 * A provider that is not on this machine yet. When the server knows a real
 * install command the button runs it in the background — no docs page — and
 * the row narrates progress from the live output. The terminal itself stays
 * hidden until the user asks for it or the install fails and needs them.
 */
function InstallableRow(props: {
  title: string
  idleNote: string
  icon: ReactNode
  target: InstallTarget
  setup: ProviderSetup | undefined
  transport: Transport
  onInstalled: () => void
}) {
  const key = installKey(props.target)
  const install = useSyncExternalStore(subscribeInstalls, () => installState(key))
  const [showTerminal, setShowTerminal] = useState(false)
  const [startError, setStartError] = useState<string>()
  const { onInstalled } = props

  useEffect(() => {
    if (install?.phase === 'failed') setShowTerminal(true)
    if (install?.phase === 'succeeded') {
      clearInstall(key)
      onInstalled()
    }
  }, [install?.phase, key, onInstalled])

  const start = () => {
    setStartError(undefined)
    void beginInstall(props.transport, props.target).catch((cause: unknown) =>
      setStartError(cause instanceof Error ? cause.message : String(cause)),
    )
  }

  const note =
    install?.phase === 'running'
      ? install.lastLine || 'Installing…'
      : install?.phase === 'failed'
        ? `Install failed${install.exitCode === null ? '' : ` (exit ${install.exitCode})`} — finish it in the terminal below, or retry.`
        : install?.phase === 'succeeded'
          ? 'Installed · refreshing…'
          : (startError ?? props.idleNote)

  return (
    <>
      <SettingsRow title={props.title} note={note}>
        <div className="provider-settings__actions">
          {props.icon}
          {!props.setup?.installCommand ? (
            <button
              className="settings__action"
              type="button"
              disabled={!props.setup}
              onClick={() =>
                props.setup && window.open(props.setup.installUrl, '_blank', 'noopener,noreferrer')
              }
            >
              Install first
            </button>
          ) : install?.phase === 'running' ? (
            <button
              className="settings__action"
              type="button"
              onClick={() => setShowTerminal((visible) => !visible)}
            >
              {showTerminal ? 'Hide terminal' : 'Installing…'}
            </button>
          ) : (
            <button className="settings__action" type="button" onClick={start}>
              {install?.phase === 'failed' ? 'Retry install' : 'Install'}
            </button>
          )}
        </div>
      </SettingsRow>
      {install && showTerminal ? (
        <InstallTerminal transport={props.transport} installKey={key} />
      ) : null}
    </>
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
