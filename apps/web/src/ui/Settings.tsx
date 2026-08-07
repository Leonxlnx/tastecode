import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type {
  Account,
  ConnectionAddress,
  ConnectionsStatus,
  ModelConnection,
  ModelConnectionPreset,
  ModelTransport,
  ProviderId,
  ProviderSetup,
  ProviderStatus,
  PairedDevice,
  ResultOf,
  SidebarSettings,
} from '@harness/contracts'
import {
  ArrowLeft,
  CircleAlert,
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
  Smartphone,
  UserRound,
} from 'lucide-react'
import {
  agentMark,
  connectionMark,
  filterModelChoicesByQuery,
  providerMark,
  type ModelChoice,
  type ProviderMark,
} from '../model-catalog.js'
import { isDesktop } from '../bridge.js'
import {
  beginInstall,
  beginLogin,
  clearInstall,
  deviceCode,
  installKey,
  installState,
  loginKey,
  subscribeInstalls,
  type InstallTarget,
} from '../provider-install.js'
import type { Transport } from '../transport.js'
import type {
  AccentPreference,
  BackdropPreference,
  FontPreference,
  ThemePreference,
} from '../theme.js'
import { McpSettings } from './McpSettings.js'
import { Menu, MenuItem } from './Menu.js'
import { ModelSearchField } from './ModelSearchField.js'
import { SkillsSettings } from './SkillsSettings.js'
import { ProviderIcon } from './ProviderIcon.js'
import { renderQrSvg } from './qr-code.js'

const InstallTerminal = lazy(() =>
  import('./InstallTerminal.js').then((module) => ({ default: module.InstallTerminal })),
)

type SettingsSection =
  | 'providers'
  | 'models'
  | 'mcp'
  | 'skills'
  | 'workflows'
  | 'mobile'
  | 'appearance'
  | 'data'
  | 'about'

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

/** Stepped, not a raw range: four honest strengths beat 13 near-identical
 *  stops, and the picker matches the other appearance choices. */
const GLASS_OPTIONS = [
  { value: 0, label: 'Off' },
  { value: 20, label: 'Subtle' },
  { value: 35, label: 'Medium' },
  { value: 50, label: 'Strong' },
] as const satisfies ReadonlyArray<{ value: number; label: string }>

const BACKDROP_OPTIONS = [
  { value: 'default', label: 'Graphite' },
  { value: 'slate', label: 'Slate' },
  { value: 'mocha', label: 'Mocha' },
  { value: 'forest', label: 'Forest' },
  { value: 'midnight', label: 'Midnight' },
  { value: 'plum', label: 'Plum' },
] as const satisfies ReadonlyArray<{ value: BackdropPreference; label: string }>

/**
 * Settings stays intentionally small: the sidebar reorganizes the decisions
 * the app already exposes without inventing preferences for their own sake.
 */
function SettingsComponent(props: {
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
  backdropPreference: BackdropPreference
  onBackdropPreferenceChange: (backdrop: BackdropPreference) => void
  sidebarGlass: number
  onSidebarGlassChange: (glass: number) => void
  showMacOSFontSmoothing: boolean
  macOSFontSmoothing: boolean
  onMacOSFontSmoothingChange: (enabled: boolean) => void
  onAccountChange: (provider: ProviderId, account: Account) => void
  onReset: () => void
  onClose: () => void
}) {
  const [section, setSection] = useState<SettingsSection>('providers')

  // A dialog owns the keyboard: focus moves into it on open (Tab must not
  // walk the app hidden underneath), and Escape closes it.
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    panel.current?.focus()
  }, [])
  const { onClose } = props
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="settings"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      ref={panel}
      tabIndex={-1}
    >
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
            active={section === 'mobile'}
            icon={<Smartphone size={15} aria-hidden />}
            label="Mobile access"
            onClick={() => setSection('mobile')}
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
          {section === 'mobile' ? <MobileAccessSettings transport={props.transport} /> : null}
          {section === 'appearance' ? <AppearanceSettings {...props} /> : null}
          {section === 'data' ? <DataSettings {...props} /> : null}
          {section === 'about' ? <AboutSettings transport={props.transport} /> : null}
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
    <SettingsPanel title="Workflows">
      <SettingsRow title="Sidebar version">
        <div className="settings__sidebar-switcher" role="radiogroup" aria-label="Sidebar version">
          <button
            className={!inbox ? 'is-selected' : ''}
            type="button"
            role="radio"
            aria-checked={!inbox}
            onClick={() => props.onSidebarSettingsChange({ mode: 'classic' })}
          >
            V1 Classic
          </button>
          <button
            className={inbox ? 'is-selected' : ''}
            type="button"
            role="radio"
            aria-checked={inbox}
            onClick={() => props.onSidebarSettingsChange({ mode: 'inbox' })}
          >
            V2 Inbox
          </button>
        </div>
      </SettingsRow>
      <SettingsRow title="Settle inactive threads">
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
  const [agentAccounts, setAgentAccounts] = useState<Record<string, Account>>({})
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

  const refreshAgentAccount = useCallback(
    async (agentId: string) => {
      const account = await props.transport.request('auth.status', {
        provider: 'acp',
        agent: agentId,
      })
      setAgentAccounts((current) => ({ ...current, [agentId]: account }))
    },
    [props.transport],
  )

  useEffect(() => {
    for (const status of props.providerStatuses) {
      if (status.installed && status.id !== 'acp') {
        void refreshAccount(status.id).catch(() =>
          setAccounts((current) => ({ ...current, [status.id]: { signedIn: false } })),
        )
      }
    }
    for (const agent of props.acpAgents) {
      if (agent.installed) void refreshAgentAccount(agent.id).catch(() => {})
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
  }, [
    props.transport,
    props.providerStatuses,
    props.acpAgents,
    refreshAccount,
    refreshAgentAccount,
  ])

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

  const renderProviderRow = (status: ProviderStatus) => {
    const account =
      accounts[status.id] ?? (status.id === props.provider ? props.account : undefined)
    if (!status.installed && !account?.signedIn) {
      return (
        <InstallableRow
          key={status.id}
          title={status.displayName}
          idleNote={status.problem}
          icon={<ProviderIcon mark={providerMark(status.id)} size={17} />}
          target={{ provider: status.id }}
          setup={status.setup}
          transport={props.transport}
          onInstalled={props.onConnectionsChanged}
        />
      )
    }
    if (!account?.signedIn && status.setup?.login === 'provider') {
      return (
        <CliSignInRow
          key={status.id}
          title={status.displayName}
          icon={<ProviderIcon mark={providerMark(status.id)} size={17} />}
          target={{ provider: status.id }}
          transport={props.transport}
          onSignedIn={() => void refreshAccount(status.id).catch(() => undefined)}
        />
      )
    }
    const accountStatus = account?.signedIn ? (
      account.email || account.plan ? (
        <>
          {account.email ? <AccountEmail email={account.email} /> : null}
          {account.email && account.plan ? ' · ' : null}
          {account.plan}
        </>
      ) : (
        'Signed in'
      )
    ) : (
      'Not signed in'
    )
    const busy = authBusy === status.id
    return (
      <SettingsRow key={status.id} title={status.displayName}>
        <div className="provider-settings__actions">
          <span className="settings__status">{accountStatus}</span>
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
  }

  const direct = props.providerStatuses.filter((status) => status.id !== 'acp')
  const byId = (id: ProviderId) => direct.filter((status) => status.id === id)
  const agentById = (id: string) => props.acpAgents.filter((agent) => agent.id === id)
  // 'gemini' stays in this set although it has no row: it is retired (the
  // server no longer lists it), and the set keeps an older server's listing
  // out of the unknown-agents catch-all below.
  const knownAgents = new Set(['gemini', 'kimi', 'qwen'])

  return (
    <SettingsPanel title="Providers">
      {authError ? (
        <p className="provider-form__error" role="alert">
          {authError}
        </p>
      ) : null}
      {byId('codex').map(renderProviderRow)}
      {byId('claude-code').map(renderProviderRow)}
      {byId('grok').map(renderProviderRow)}
      {byId('cursor').map(renderProviderRow)}
      {byId('opencode').map(renderProviderRow)}
      {direct
        .filter(
          (status) => !['codex', 'claude-code', 'grok', 'cursor', 'opencode'].includes(status.id),
        )
        .map(renderProviderRow)}

      <PlannedRow title="Pi" mark="pi" />
      {[
        ...agentById('kimi'),
        ...agentById('qwen'),
        ...props.acpAgents.filter((agent) => !knownAgents.has(agent.id)),
      ].map((agent) =>
        // A signed-in CLI must not keep offering "Sign in" — that ran the
        // whole login flow against an already-authenticated binary. Signing
        // out removes the credential the login left behind, so the row works
        // like every direct provider's.
        agent.installed && agentAccounts[agent.id]?.signedIn ? (
          <SettingsRow key={agent.id} title={agent.name}>
            <div className="provider-settings__actions">
              <span className="settings__status">Signed in</span>
              <ProviderIcon mark={agentMark(agent.id)} size={17} />
              <button
                className="settings__action"
                type="button"
                onClick={() => {
                  void props.transport
                    .request('auth.signOut', { provider: 'acp', agent: agent.id })
                    .then(() => refreshAgentAccount(agent.id))
                    .catch((cause) =>
                      setAuthError(cause instanceof Error ? cause.message : String(cause)),
                    )
                }}
              >
                <LogOut size={13} aria-hidden />
                Sign out
              </button>
            </div>
          </SettingsRow>
        ) : agent.installed ? (
          <CliSignInRow
            key={agent.id}
            title={agent.name}
            idleNote={agent.problem}
            icon={<ProviderIcon mark={agentMark(agent.id)} size={17} />}
            target={{ provider: 'acp', agent: agent.id }}
            transport={props.transport}
            onSignedIn={() => {
              props.onConnectionsChanged()
              void refreshAgentAccount(agent.id).catch(() => {})
            }}
          />
        ) : (
          <InstallableRow
            key={agent.id}
            title={agent.name}
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
        <SettingsRow key={connection.id} title={connection.displayName}>
          <div className="provider-settings__actions">
            <span
              className={`settings__status${connection.credentialConfigured ? '' : ' is-warning'}`}
            >
              {connection.credentialConfigured
                ? CONNECTION_PRESETS[connection.preset].label
                : 'Key missing'}
            </span>
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
  const visibleModelCount = props.models.filter(
    (choice) => !props.hiddenModels.has(choice.key),
  ).length

  return (
    <SettingsPanel title="Models" groupClassName="settings__group--plain model-settings">
      {props.models.length > 0 ? (
        <div className="model-settings__summary">
          <span>
            {visibleModelCount} of {props.models.length} visible
          </span>
        </div>
      ) : null}

      {sources.size > 0 ? (
        <div className="model-settings__sources">
          {[...sources.entries()].map(([source, choices]) => (
            <ModelVisibilityGroup
              key={source}
              source={source}
              choices={choices}
              hiddenModels={props.hiddenModels}
              onModelVisibilityChange={props.onModelVisibilityChange}
            />
          ))}
        </div>
      ) : (
        <div className="model-settings__empty">
          <Boxes size={18} aria-hidden />
          <p>No models are available from your connected providers yet.</p>
        </div>
      )}
    </SettingsPanel>
  )
}

function ModelVisibilityGroup(props: {
  source: string
  choices: ModelChoice[]
  hiddenModels: Set<string>
  onModelVisibilityChange: (key: string, visible: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const visibleCount = props.choices.filter((choice) => !props.hiddenModels.has(choice.key)).length
  const anyVisible = visibleCount > 0
  const filteredChoices = filterModelChoicesByQuery(props.choices, deferredQuery)

  return (
    <section className="model-visibility" aria-label={props.source}>
      <header className="model-visibility__source">
        <div className="model-visibility__source-copy">
          {props.choices[0] ? <ProviderIcon mark={props.choices[0].mark} size={18} /> : null}
          <h3>{props.source}</h3>
          <span className="settings__status">
            {visibleCount}/{props.choices.length}
          </span>
        </div>
        <ModelSearchField
          className="model-visibility__search"
          value={query}
          label={`Search ${props.source} models`}
          onChange={setQuery}
        />
        <button
          className={`switch switch--source${anyVisible ? ' is-on' : ''}`}
          type="button"
          role="switch"
          aria-label={`Show any models from ${props.source}`}
          aria-checked={anyVisible}
          onClick={() => {
            // One master switch per provider: off hides every model, on
            // brings them all back — "deselect a provider" without
            // disconnecting it.
            for (const choice of props.choices)
              props.onModelVisibilityChange(choice.key, !anyVisible)
          }}
        >
          <span className="switch__thumb" />
        </button>
      </header>

      <div className="model-visibility__models">
        {filteredChoices.length > 0 ? (
          filteredChoices.map((choice) => {
            const visible = !props.hiddenModels.has(choice.key)
            return (
              <SettingsRow
                className={`model-visibility__model${visible ? '' : ' is-hidden'}`}
                key={choice.key}
                title={choice.model.displayName}
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
          })
        ) : (
          <p className="model-visibility__empty" role="status">
            No matching models.
          </p>
        )}
      </div>
    </section>
  )
}

function MobileAccessSettings(props: { transport: Transport }) {
  const [status, setStatus] = useState<ConnectionsStatus>()
  const [pairing, setPairing] = useState<ResultOf<'connections.startPairing'>>()
  const [qrSvg, setQrSvg] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<'pair' | 'stop' | string>()
  const [now, setNow] = useState(Date.now)

  const refresh = useCallback(async () => {
    try {
      setStatus(await props.transport.request('connections.status', {}))
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [props.transport])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => {
      setNow(Date.now())
      void refresh()
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    if (!pairing || pairing.expiresAt <= Date.now()) {
      setQrSvg(undefined)
      return
    }
    let cancelled = false
    void renderQrSvg(pairing.pairingUri)
      .then((svg) => {
        if (!cancelled) setQrSvg(svg)
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [pairing])

  const startPairing = async () => {
    setBusy('pair')
    try {
      const offer = await props.transport.request('connections.startPairing', {})
      setStatus(offer)
      setPairing(offer)
      setNow(Date.now())
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const stop = async () => {
    setBusy('stop')
    try {
      await props.transport.request('connections.stop', {})
      setPairing(undefined)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const disconnectDevice = async (deviceId: string) => {
    setBusy(deviceId)
    try {
      await props.transport.request('connections.revoke', { deviceId })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const activePairing = pairing && pairing.expiresAt > now ? pairing : undefined

  return (
    <SettingsPanel title="Mobile access">
      <SettingsRow
        title={status?.enabled ? 'Available to paired devices' : 'Not accepting mobile connections'}
        note={
          status?.enabled
            ? `${status.serverName} is listening on port ${status.port}.`
            : 'Generate a one-time code to start the private listener and pair a device.'
        }
      >
        <span className={`settings__status${status?.enabled ? ' is-on' : ''}`}>
          {status?.enabled ? 'On' : 'Off'}
        </span>
      </SettingsRow>

      {status?.addresses.length ? (
        <div className="settings__mobile-block">
          <p className="settings__row-title">Reachable addresses</p>
          <p className="settings__row-note">
            Prefer Tailscale. Use a LAN route only on a private network you trust.
          </p>
          <div className="settings__mobile-routes">
            {status.addresses.map((address) => (
              <AddressPill address={address} key={`${address.kind}-${address.url}`} />
            ))}
          </div>
        </div>
      ) : null}

      <div className="settings__mobile-actions">
        <button
          className="settings__action"
          type="button"
          disabled={busy !== undefined}
          onClick={() => void startPairing()}
        >
          {busy === 'pair' ? 'Generating...' : 'Generate pairing code'}
        </button>
        {status?.enabled ? (
          <button
            className="settings__action is-danger"
            type="button"
            disabled={busy !== undefined}
            onClick={() => void stop()}
          >
            {busy === 'stop' ? 'Stopping...' : 'Stop mobile access'}
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="settings__mobile-error" role="alert">
          {error}
        </p>
      ) : null}

      {activePairing ? (
        <div className="settings__pairing">
          <div className="settings__qr">
            {qrSvg ? (
              <div
                role="img"
                aria-label="Pairing QR code"
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
            ) : (
              <span>Generating QR...</span>
            )}
          </div>
          <div>
            <p className="settings__row-title">Scan from Harness Mobile</p>
            <p className="settings__row-note">
              Expires in {formatCountdown(activePairing.expiresAt - now)} and works once.
            </p>
            <button
              className="settings__action"
              type="button"
              onClick={() => void navigator.clipboard?.writeText(activePairing.pairingUri)}
            >
              Copy pairing link
            </button>
          </div>
        </div>
      ) : null}

      <h2 className="settings__group-title settings__group-title--inside">Paired devices</h2>
      {status?.devices.length ? (
        status.devices.map((device) => (
          <SettingsRow key={device.id} title={device.name} note={formatDeviceNote(device, now)}>
            <button
              className="settings__action is-danger"
              type="button"
              disabled={busy !== undefined}
              onClick={() => void disconnectDevice(device.id)}
            >
              {busy === device.id ? 'Disconnecting...' : 'Disconnect'}
            </button>
          </SettingsRow>
        ))
      ) : (
        <p className="settings__mobile-empty">No paired devices.</p>
      )}
    </SettingsPanel>
  )
}

function AddressPill(props: { address: ConnectionAddress }) {
  return (
    <span className="settings__mobile-route" title={props.address.url}>
      <strong>{props.address.kind === 'tailscale' ? 'Tailscale' : 'LAN'}</strong>
      {props.address.label}
    </span>
  )
}

function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1_000))
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
}

function formatDeviceNote(device: PairedDevice, now: number): string {
  const minutes = Math.max(0, Math.floor((now - device.lastSeenAt) / 60_000))
  return minutes === 0 ? 'Seen just now' : `Seen ${minutes}m ago`
}

function AppearanceSettings(props: {
  themePreference: ThemePreference
  onThemePreferenceChange: (theme: ThemePreference) => void
  fontPreference: FontPreference
  onFontPreferenceChange: (font: FontPreference) => void
  accentPreference: AccentPreference
  onAccentPreferenceChange: (accent: AccentPreference) => void
  backdropPreference: BackdropPreference
  onBackdropPreferenceChange: (backdrop: BackdropPreference) => void
  sidebarGlass: number
  onSidebarGlassChange: (glass: number) => void
  showMacOSFontSmoothing: boolean
  macOSFontSmoothing: boolean
  onMacOSFontSmoothingChange: (enabled: boolean) => void
}) {
  return (
    <SettingsPanel title="Appearance" groupClassName="settings__group--plain">
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
        <h2 className="settings__group-title">Background</h2>
        <fieldset
          className="appearance-picker appearance-picker--accent"
          aria-label="Background palette"
        >
          {BACKDROP_OPTIONS.map((option) => (
            <button
              className={`appearance-choice${props.backdropPreference === option.value ? ' is-selected' : ''}`}
              type="button"
              aria-pressed={props.backdropPreference === option.value}
              onClick={() => props.onBackdropPreferenceChange(option.value)}
              key={option.value}
            >
              <span
                className="appearance-choice__swatch"
                data-backdrop-preview={option.value}
                aria-hidden
              />
              <span>{option.label}</span>
            </button>
          ))}
        </fieldset>
      </div>
      <div className="appearance__text">
        <h2 className="settings__group-title">Sidebar translucency</h2>
        <fieldset className="appearance-picker" aria-label="Sidebar translucency">
          {GLASS_OPTIONS.map((option) => {
            // Legacy values from the old 0–60 range snap to the nearest stop.
            const selected = GLASS_OPTIONS.reduce((best, candidate) =>
              Math.abs(candidate.value - props.sidebarGlass) <
              Math.abs(best.value - props.sidebarGlass)
                ? candidate
                : best,
            )
            return (
              <button
                className={`appearance-choice${selected.value === option.value ? ' is-selected' : ''}`}
                type="button"
                aria-pressed={selected.value === option.value}
                onClick={() => props.onSidebarGlassChange(option.value)}
                key={option.value}
              >
                <span
                  className="appearance-choice__swatch"
                  data-glass-preview={option.value}
                  aria-hidden
                />
                <span>{option.label}</span>
              </button>
            )
          })}
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
            <SettingsRow title="Font smoothing">
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
    <SettingsPanel title="Data">
      <SettingsRow title={projectLabel}>
        <button className="settings__action" type="button" onClick={props.onReset}>
          <RotateCcw size={13} aria-hidden />
          <span>Reset app</span>
        </button>
      </SettingsRow>
    </SettingsPanel>
  )
}

function AboutSettings(props: { transport: Transport }) {
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<ResultOf<'system.updateCheck'>>()

  const check = async () => {
    setChecking(true)
    try {
      setResult(await props.transport.request('system.updateCheck', {}))
    } catch (cause) {
      setResult({ error: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setChecking(false)
    }
  }

  const short = (sha: string) => sha.slice(0, 7)
  // Verdicts stay on the row's one line; a failure goes behind the red dot.
  const updateStatus = !result
    ? undefined
    : result.error
      ? undefined
      : result.upToDate
        ? `Up to date · ${short(result.remote?.sha ?? '')}`
        : result.remote
          ? `Newer: ${short(result.remote.sha)} — pull and restart`
          : 'No verdict'

  return (
    <SettingsPanel title="About">
      <SettingsRow title="Personal Harness">
        <span className="settings__status">
          {`${isDesktop ? 'Desktop' : 'Browser'} · pre-release${result?.localCommit ? ` · ${short(result.localCommit)}` : ''}`}
        </span>
      </SettingsRow>
      <SettingsRow title="Updates">
        {result?.error ? (
          <RowIssue message={result.error} tip="Check your network or GitHub access, then retry." />
        ) : null}
        {updateStatus ? <span className="settings__status">{updateStatus}</span> : null}
        <button
          className="settings__action"
          type="button"
          disabled={checking}
          onClick={() => void check()}
        >
          <RotateCcw size={13} aria-hidden />
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
      </SettingsRow>
      <SettingsRow title="Source">
        <button
          className="settings__action"
          type="button"
          onClick={() =>
            window.open(
              'https://github.com/Leonxlnx/personalharness',
              '_blank',
              'noopener,noreferrer',
            )
          }
        >
          GitHub
        </button>
      </SettingsRow>
    </SettingsPanel>
  )
}

// No group subtitle between the title and the card: one heading carries a
// panel, and the removed line was repeating it in smaller type.
function SettingsPanel(props: { title: string; groupClassName?: string; children: ReactNode }) {
  return (
    <section className="settings__panel" aria-labelledby={`settings-${props.title.toLowerCase()}`}>
      <h1 className="settings__title" id={`settings-${props.title.toLowerCase()}`}>
        {props.title}
      </h1>
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
  idleNote?: string | undefined
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

  // Latched: the succeeded state persists across renders (see the unmount
  // cleanup below), and onInstalled may get a new identity from any parent
  // render. Without the latch those two combine into an infinite refresh
  // loop — notify → parent renders → new identity → effect refires — which
  // once held ~170 concurrent `opencode serve` processes alive.
  const notifiedInstall = useRef(false)
  useEffect(() => {
    if (install?.phase === 'failed') setShowTerminal(true)
    if (install?.phase === 'succeeded') {
      if (!notifiedInstall.current) {
        notifiedInstall.current = true
        onInstalled()
      }
    } else {
      notifiedInstall.current = false
    }
  }, [install?.phase, onInstalled])

  // The succeeded entry stays until this row leaves the page — re-detecting
  // the provider takes a moment, and clearing early would flash the idle
  // "Install" button in between. The row unmounting is the confirmation.
  useEffect(
    () => () => {
      if (installState(key)?.phase === 'succeeded') clearInstall(key)
    },
    [key],
  )

  const start = () => {
    setStartError(undefined)
    void beginInstall(props.transport, props.target).catch((cause: unknown) =>
      setStartError(cause instanceof Error ? cause.message : String(cause)),
    )
  }

  const status =
    install?.phase === 'running'
      ? install.lastLine || 'Installing…'
      : install?.phase === 'succeeded'
        ? 'Installed · refreshing…'
        : undefined
  const issue =
    install?.phase === 'failed'
      ? {
          message: `Install failed${install.exitCode === null ? '' : ` (exit ${install.exitCode})`}.`,
          tip: 'Open the terminal below for the log, then retry.',
        }
      : startError
        ? { message: startError, tip: 'Retry, or install it from the terminal yourself.' }
        : props.idleNote
          ? { message: props.idleNote, tip: 'Install it here, then come back to sign in.' }
          : undefined

  return (
    <>
      <SettingsRow title={props.title}>
        <div className="provider-settings__actions">
          {issue ? <RowIssue message={issue.message} tip={issue.tip} /> : null}
          {status ? <span className="settings__status">{status}</span> : null}
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
          ) : install?.phase === 'succeeded' ? (
            <button className="settings__action" type="button" disabled>
              Installed
            </button>
          ) : (
            <button className="settings__action" type="button" onClick={start}>
              {install?.phase === 'failed' ? 'Retry install' : 'Install'}
            </button>
          )}
        </div>
      </SettingsRow>
      {install && showTerminal ? (
        <ProviderTerminal transport={props.transport} installKey={key} />
      ) : null}
    </>
  )
}

/**
 * Sign-in for a provider whose login lives inside its own CLI. The button
 * launches that CLI in a server-side pty and hands the user the terminal
 * right away — the OAuth flow happens in there, not on a docs page. A clean
 * exit means the user finished and quit, so the row refreshes; a dirty exit
 * keeps the log around for reading before a retry.
 */
function CliSignInRow(props: {
  title: string
  idleNote?: string | undefined
  icon: ReactNode
  target: InstallTarget
  transport: Transport
  onSignedIn: () => void
}) {
  const key = loginKey(props.target)
  const login = useSyncExternalStore(subscribeInstalls, () => installState(key))
  // The terminal is the fallback, not the flow: it stays hidden until asked
  // for, and opens itself only when a failure makes it the evidence.
  const [showTerminal, setShowTerminal] = useState(false)
  const [startError, setStartError] = useState<string>()
  const [copied, setCopied] = useState(false)
  const { onSignedIn } = props

  // Latched like InstallableRow: onSignedIn may get a new identity from any
  // parent render, and firing more than once per success is the seed of the
  // refresh loop fixed there.
  const notifiedLogin = useRef(false)
  useEffect(() => {
    if (login?.phase === 'succeeded') {
      if (!notifiedLogin.current) {
        notifiedLogin.current = true
        clearInstall(key)
        onSignedIn()
      }
    } else {
      notifiedLogin.current = false
    }
  }, [login?.phase, key, onSignedIn])

  useEffect(() => {
    if (login?.phase === 'failed') setShowTerminal(true)
  }, [login?.phase])

  const start = () => {
    setStartError(undefined)
    setShowTerminal(false)
    setCopied(false)
    void beginLogin(props.transport, props.target).catch((cause: unknown) =>
      setStartError(cause instanceof Error ? cause.message : String(cause)),
    )
  }

  const running = login?.phase === 'running'
  const code = running ? deviceCode(login.log) : undefined
  const issue =
    login?.phase === 'failed'
      ? {
          message: `The CLI exited${login.exitCode === null ? '' : ` (exit ${login.exitCode})`}.`,
          tip: 'Check the terminal below for what happened, then retry.',
        }
      : startError
        ? { message: startError, tip: 'Retry, or run the login in your own terminal.' }
        : props.idleNote
          ? { message: props.idleNote, tip: undefined }
          : undefined

  return (
    <>
      <SettingsRow title={props.title}>
        <div className="provider-settings__actions">
          {issue ? <RowIssue message={issue.message} tip={issue.tip} /> : null}
          {running ? <span className="settings__status">Signing in…</span> : null}
          {props.icon}
          {running ? (
            <button
              className="settings__action"
              type="button"
              onClick={() => setShowTerminal((visible) => !visible)}
            >
              {showTerminal ? 'Hide details' : 'Details'}
            </button>
          ) : (
            <button className="settings__action" type="button" onClick={start}>
              {login?.phase === 'failed' ? 'Retry sign-in' : 'Sign in'}
            </button>
          )}
        </div>
      </SettingsRow>
      {running ? (
        <div className="signin-card">
          {code ? (
            <div className="signin-card__code-row">
              <span className="signin-card__hint">Confirm this code in your browser</span>
              <code className="signin-card__code">{code}</code>
              <button
                className="settings__action"
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(code).then(() => setCopied(true))
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          ) : (
            <span className="signin-card__hint">
              {login.openedAuthUrl
                ? 'Your browser opened — approve the sign-in there'
                : 'Starting the provider sign-in…'}
            </span>
          )}
          {login.openedAuthUrl ? (
            <button
              className="settings__action"
              type="button"
              onClick={() => window.open(login.openedAuthUrl, '_blank', 'noopener,noreferrer')}
            >
              Open link again
            </button>
          ) : null}
          {!showTerminal && login.lastLine ? (
            <span className="signin-card__live" aria-live="polite">
              {login.lastLine}
            </span>
          ) : null}
        </div>
      ) : null}
      {login && showTerminal ? (
        <ProviderTerminal transport={props.transport} installKey={key} />
      ) : null}
    </>
  )
}

function ProviderTerminal(props: { transport: Transport; installKey: string }) {
  return (
    <Suspense fallback={<div className="install-terminal" aria-label="Install terminal" />}>
      <InstallTerminal {...props} />
    </Suspense>
  )
}

/**
 * A provider we intend to support but have not built. Listing it beats
 * omitting it — "not supported yet" and "not installed" must stay
 * distinguishable, and the roadmap belongs in the product, not a doc.
 */
function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 1) return email
  return `${email[0]}…${email.slice(at)}`
}

/**
 * Privacy by default: the address shows masked until pointed at or focused.
 * Both forms render stacked in one grid cell so the row never shifts when
 * the longer full address appears.
 */
function AccountEmail(props: { email: string }) {
  return (
    <span className="settings__email" tabIndex={0} aria-label={'Account email, hover to reveal'}>
      <span className="settings__email-masked" aria-hidden>
        {maskEmail(props.email)}
      </span>
      <span className="settings__email-full">{props.email}</span>
    </span>
  )
}

function PlannedRow(props: { title: string; mark?: ProviderMark }) {
  return (
    <SettingsRow title={props.title}>
      <div className="provider-settings__actions">
        <ProviderIcon mark={props.mark ?? 'custom'} size={17} />
        <button className="settings__action" type="button" disabled>
          Planned
        </button>
      </div>
    </SettingsRow>
  )
}

/**
 * Errors never grow a second line: every row keeps one height, and problems
 * live behind a red dot whose bubble carries the message plus a tip. Hover
 * or focus opens it — it is a real button so keyboards reach it too.
 */
function RowIssue(props: { message: string; tip?: string | undefined }) {
  return (
    <span className="row-issue">
      <button type="button" className="row-issue__dot" aria-label={'Problem: ' + props.message}>
        <CircleAlert size={14} aria-hidden />
      </button>
      <span role="tooltip" className="row-issue__bubble">
        {props.message}
        {props.tip ? <span className="row-issue__tip">{props.tip}</span> : null}
      </span>
    </span>
  )
}

function SettingsRow(props: {
  title: string
  note?: string | undefined
  className?: string
  children?: ReactNode
}) {
  return (
    <div className={`settings__row${props.className ? ` ${props.className}` : ''}`}>
      <div className="settings__row-copy">
        <p className="settings__row-title">{props.title}</p>
        {props.note ? <p className="settings__row-note">{props.note}</p> : null}
      </div>
      {props.children ? <div className="settings__row-control">{props.children}</div> : null}
    </div>
  )
}

export const Settings = memo(SettingsComponent)
