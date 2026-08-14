import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type {
  Account,
  BackgroundModelSettings as BackgroundModelSettingsState,
  BackgroundModelSource,
  BackgroundModelTarget,
  DataOf,
  ModelConnection,
  ModelConnectionPreset,
  ModelTransport,
  ProviderId,
  ProviderStatus,
  ResultOf,
  SidebarSettings,
} from '@harness/contracts'
import {
  ArrowLeft,
  CircleAlert,
  CircleUserRound,
  Blocks,
  ChevronDown,
  Database,
  Info,
  Boxes,
  KeyRound,
  Network,
  Palette,
  PanelLeft,
  RotateCcw,
  UserRound,
} from 'lucide-react'
import {
  agentMark,
  connectionMark,
  isCustomModelChoice,
  providerMark,
  type ModelChoice,
  type ProviderMark,
} from '../model-catalog.js'
import {
  appUpdateState,
  checkForAppUpdates,
  installAppUpdate,
  isDesktop,
  localDiagnosticsEnabled,
  onAppUpdateState,
  openLocalDiagnostics,
  setLocalDiagnosticsEnabled,
  type AppUpdateState,
} from '../bridge.js'
import {
  beginInstall,
  beginLogin,
  clearInstall,
  deviceCode,
  installKey,
  installState,
  loginKey,
  signedInEmail,
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
import {
  readModelPickerLayout,
  subscribeModelPickerLayout,
  writeModelPickerLayout,
} from '../model-picker-layout.js'
import {
  performAppHaptic,
  prepareAppHaptics,
  readAppHaptics,
  subscribeAppHaptics,
  writeAppHaptics,
} from '../haptics.js'
import { AppSelect } from './AppSelect.js'
import { McpSettings } from './McpSettings.js'
import { Menu, MenuItem } from './Menu.js'
import { groupModelsBySource } from './ModelSelector.js'
import { SkillsSettings } from './SkillsSettings.js'
import { ProviderIcon } from './ProviderIcon.js'
import { ProviderRow, type ProviderAction } from './ProviderRow.js'
import { ProfileSettings } from './ProfileSettings.js'
import type { ProfileIdentityPreferences } from '../profile-preferences.js'
import { SourceIdentity } from './SourceIdentity.js'
import { SettingsMeta, StateLabel } from './SettingsStatus.js'

const InstallTerminal = lazy(() =>
  import('./InstallTerminal.js').then((module) => ({ default: module.InstallTerminal })),
)

export type SettingsSection =
  | 'profile'
  | 'providers'
  | 'models'
  | 'mcp'
  | 'skills'
  | 'workflows'
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

const MCP_PROVIDER_OPTIONS = [
  { provider: 'codex', providerName: 'Codex' },
  { provider: 'grok', providerName: 'Grok' },
] satisfies Array<{ provider: ProviderId; providerName: string }>

const FOCUSABLE_SELECTOR =
  'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

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
  profileIdentity?: ProfileIdentityPreferences | undefined
  onProfileIdentityChange?: ((updates: Partial<ProfileIdentityPreferences>) => void) | undefined
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
  showMacOSHaptics?: boolean | undefined
  onAccountChange: (provider: ProviderId, account: Account) => void
  initialSection?: SettingsSection | undefined
  onReset: () => void
  onClose: () => void
}) {
  const [section, setSection] = useState<SettingsSection>(props.initialSection ?? 'providers')

  useEffect(() => {
    setSection(props.initialSection ?? 'providers')
  }, [props.initialSection])

  const panel = useRef<HTMLDivElement>(null)
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose
  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        onClose.current()
        return
      }
      if (event.key !== 'Tab' || event.defaultPrevented || !panel.current) return

      const focusable = Array.from(
        panel.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => !element.closest('[hidden], [inert], [aria-hidden="true"]'))
      const first = focusable[0]
      const last = focusable.at(-1)
      const active = document.activeElement
      const atBoundary =
        !first ||
        !last ||
        active === panel.current ||
        !panel.current.contains(active) ||
        (event.shiftKey ? active === first : active === last)
      if (!atBoundary) return

      event.preventDefault()
      ;(event.shiftKey ? last : first)?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

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
            active={section === 'workflows'}
            icon={<PanelLeft size={15} aria-hidden />}
            label="General"
            onClick={() => setSection('workflows')}
          />
          <SettingsNavItem
            active={section === 'profile'}
            icon={<CircleUserRound size={15} aria-hidden />}
            label="Profile"
            onClick={() => setSection('profile')}
          />
          <SettingsNavItem
            active={section === 'appearance'}
            icon={<Palette size={15} aria-hidden />}
            label="Appearance"
            onClick={() => setSection('appearance')}
          />
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
            active={section === 'data'}
            icon={<Database size={15} aria-hidden />}
            label="Data & privacy"
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
        <div
          className={`settings__content${section === 'profile' ? ' settings__content--profile' : ''}`}
        >
          {section === 'profile' ? (
            <ProfileSettings
              account={props.account}
              providerName={props.providerName}
              identity={props.profileIdentity}
              onIdentityChange={props.onProfileIdentityChange}
            />
          ) : null}
          {section === 'providers' ? <ProviderSettings {...props} /> : null}
          {section === 'models' ? <ModelSettings {...props} /> : null}
          {section === 'mcp' ? <McpSettings {...props} providers={MCP_PROVIDER_OPTIONS} /> : null}
          {section === 'skills' ? <SkillsSettings {...props} /> : null}
          {section === 'workflows' ? <WorkflowSettings {...props} /> : null}
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
    <SettingsPanel title="General">
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
      <SettingsRow
        title="Model picker"
        note="Show providers in a compact rail instead of a single list."
      >
        <ModelPickerLayoutToggle />
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

type ProviderMap<T> = Partial<Record<ProviderId, T>>

export function ProviderSettings(props: {
  provider: ProviderId
  account: Account | undefined
  providerStatuses: ProviderStatus[]
  projectPath?: string | undefined
  transport: Transport
  onConnectionsChanged: () => void
  onAccountChange: (provider: ProviderId, account: Account) => void
}) {
  type AuthReadState =
    | { phase: 'loading' }
    | { phase: 'ready'; account: Account }
    | { phase: 'error'; message: string }
  type AuthOperation = {
    id: number
    kind: 'sign-in' | 'sign-out'
    transport: Transport
    loginId?: string
  }

  const [authStates, setAuthStates] = useState<ProviderMap<AuthReadState>>(() =>
    props.account ? { [props.provider]: { phase: 'ready', account: props.account } } : {},
  )
  const [authOperations, setAuthOperations] = useState<ProviderMap<AuthOperation>>({})
  const [authErrors, setAuthErrors] = useState<ProviderMap<string>>({})
  const sequence = useRef(0)
  const statusRequests = useRef<ProviderMap<{ id: number; transport: Transport }>>({})
  const operations = useRef<ProviderMap<AuthOperation>>({})
  const earlyEvents = useRef<
    ProviderMap<Map<string | null, { operationId: number; event: DataOf<'auth.event'> }>>
  >({})
  const currentTransport = useRef(props.transport)
  currentTransport.current = props.transport

  const updateOperation = useCallback((provider: ProviderId, operation?: AuthOperation) => {
    operations.current = { ...operations.current, [provider]: operation }
    setAuthOperations(operations.current)
  }, [])

  const operationIsCurrent = useCallback(
    (provider: ProviderId, operation: AuthOperation) =>
      operations.current[provider]?.id === operation.id &&
      currentTransport.current === operation.transport,
    [],
  )

  const beginOperation = (provider: ProviderId, kind: AuthOperation['kind']) => {
    const operation = { id: ++sequence.current, kind, transport: props.transport }
    delete statusRequests.current[provider]
    delete earlyEvents.current[provider]
    updateOperation(provider, operation)
    setAuthErrors((current) => ({ ...current, [provider]: undefined }))
    return operation
  }

  const refreshAccount = useCallback(
    async (provider: ProviderId, forceLoading = false) => {
      const request = { id: ++sequence.current, transport: props.transport }
      statusRequests.current = { ...statusRequests.current, [provider]: request }
      setAuthStates((current) =>
        !forceLoading && current[provider]?.phase === 'ready'
          ? current
          : { ...current, [provider]: { phase: 'loading' } },
      )
      try {
        const account = await props.transport.request('auth.status', { provider })
        if (
          statusRequests.current[provider] !== request ||
          currentTransport.current !== request.transport
        )
          return
        setAuthStates((current) => ({
          ...current,
          [provider]: { phase: 'ready', account },
        }))
        props.onAccountChange(provider, account)
      } catch (cause) {
        if (
          statusRequests.current[provider] !== request ||
          currentTransport.current !== request.transport
        )
          return
        setAuthStates((current) => ({
          ...current,
          [provider]: {
            phase: 'error',
            message: cause instanceof Error ? cause.message : String(cause),
          },
        }))
      }
    },
    [props.transport, props.onAccountChange],
  )

  const authProviderIds = props.providerStatuses
    .filter((status) => status.installed && status.id !== 'acp')
    .map((status) => status.id)
  const authProviderKey = authProviderIds.join('|')

  const completeLogin = useCallback(
    (event: DataOf<'auth.event'>) => {
      updateOperation(event.provider)
      setAuthErrors((current) => ({
        ...current,
        [event.provider]: event.success ? undefined : (event.error ?? 'Sign-in was cancelled.'),
      }))
      if (event.success) void refreshAccount(event.provider, true)
    },
    [refreshAccount, updateOperation],
  )

  useEffect(() => {
    for (const provider of authProviderIds) {
      void refreshAccount(provider)
    }
    const unsubscribe = props.transport.on('auth.event', (event) => {
      if (event.agent) return
      const operation = operations.current[event.provider]
      if (!operation) {
        if (event.success) void refreshAccount(event.provider, true)
        return
      }
      if (operation.kind !== 'sign-in' || operation.transport !== props.transport) return
      if (operation.loginId === undefined) {
        const events = earlyEvents.current[event.provider] ?? new Map()
        events.set(event.loginId, { operationId: operation.id, event })
        earlyEvents.current[event.provider] = events
        return
      }
      if (operation.loginId === event.loginId) completeLogin(event)
    })

    return () => {
      unsubscribe()
      for (const provider of authProviderIds) {
        delete statusRequests.current[provider]
      }
    }
  }, [props.transport, authProviderKey, completeLogin, refreshAccount])

  useEffect(() => {
    operations.current = {}
    setAuthOperations({})
    setAuthErrors({})
  }, [props.transport])

  const signIn = async (provider: ProviderId) => {
    const operation = beginOperation(provider, 'sign-in')
    try {
      const result = await props.transport.request('auth.startLogin', { provider })
      if (!operationIsCurrent(provider, operation)) return
      const early = earlyEvents.current[provider]?.get(result.loginId)
      delete earlyEvents.current[provider]
      if (early?.operationId === operation.id && early.event.loginId === result.loginId) {
        completeLogin(early.event)
        return
      }
      updateOperation(provider, { ...operation, loginId: result.loginId })
      if (result.authUrl) window.open(result.authUrl, '_blank', 'noopener,noreferrer')
    } catch (cause) {
      if (!operationIsCurrent(provider, operation)) return
      updateOperation(provider)
      setAuthErrors((current) => ({
        ...current,
        [provider]: cause instanceof Error ? cause.message : String(cause),
      }))
    }
  }

  const signOut = async (provider: ProviderId) => {
    const operation = beginOperation(provider, 'sign-out')
    try {
      await props.transport.request('auth.signOut', { provider })
      if (!operationIsCurrent(provider, operation)) return
      const account = { signedIn: false }
      localStorage.removeItem(providerEmailKey(provider))
      setAuthStates((current) => ({
        ...current,
        [provider]: { phase: 'ready', account },
      }))
      props.onAccountChange(provider, account)
      updateOperation(provider)
    } catch (cause) {
      if (!operationIsCurrent(provider, operation)) return
      updateOperation(provider)
      setAuthErrors((current) => ({
        ...current,
        [provider]: cause instanceof Error ? cause.message : String(cause),
      }))
    }
  }

  const renderProviderRow = (status: ProviderStatus) => {
    const authState =
      authStates[status.id] ??
      (status.id === props.provider && props.account
        ? { phase: 'ready' as const, account: props.account }
        : { phase: 'loading' as const })
    const account = authState.phase === 'ready' ? authState.account : undefined
    if (!status.installed && !account?.signedIn) {
      return (
        <InstallableRow
          key={status.id}
          provider={status}
          target={{ provider: status.id }}
          transport={props.transport}
          onInstalled={props.onConnectionsChanged}
        />
      )
    }
    if (authState.phase !== 'ready') {
      return (
        <ProviderRow
          key={status.id}
          provider={status}
          status={authState.phase === 'error' ? 'Account unavailable' : 'Checking account…'}
          live={authState.phase === 'loading'}
          issue={
            authState.phase === 'error'
              ? { message: authState.message, announce: true }
              : status.problem
                ? { message: status.problem }
                : undefined
          }
          primary={
            authState.phase === 'error'
              ? { label: 'Retry', onClick: () => void refreshAccount(status.id, true) }
              : undefined
          }
        />
      )
    }
    if (!account?.signedIn && status.setup?.login === 'provider') {
      return (
        <CliSignInRow
          key={status.id}
          provider={status}
          target={{ provider: status.id }}
          transport={props.transport}
          onSignedIn={() => void refreshAccount(status.id, true)}
        />
      )
    }
    const accountStatus = account?.signedIn ? (
      <AccountIdentity provider={status.id} account={account} />
    ) : (
      'Not signed in'
    )
    const operation = authOperations[status.id]
    const authError = authErrors[status.id]
    const operationStatus =
      operation?.kind === 'sign-in'
        ? 'Signing in…'
        : operation?.kind === 'sign-out'
          ? 'Signing out…'
          : accountStatus
    return (
      <ProviderRow
        key={status.id}
        provider={status}
        status={operationStatus}
        live={operation !== undefined}
        issue={
          authError
            ? {
                message: authError,
                announce: true,
              }
            : status.problem
              ? { message: status.problem }
              : undefined
        }
        primary={
          account?.signedIn
            ? undefined
            : {
                label: operation?.kind === 'sign-in' ? 'Signing in…' : 'Sign in',
                disabled: operation !== undefined,
                onClick: () => void signIn(status.id),
              }
        }
        secondary={
          account?.signedIn
            ? {
                label: operation?.kind === 'sign-out' ? 'Signing out…' : 'Sign out',
                disabled: operation !== undefined,
                danger: true,
                onClick: () => void signOut(status.id),
              }
            : undefined
        }
      />
    )
  }

  // Public beta scope: exactly the three subscription plans the server lists
  // (Codex, Claude Code, Grok). The ACP agents, Cursor, OpenCode, Antigravity
  // and API-connection surfaces are parked, not deleted — see AGENTS.md.
  const direct = props.providerStatuses.filter((status) => status.id !== 'acp')
  const byId = (id: ProviderId) => direct.filter((status) => status.id === id)

  return (
    <SettingsPanel title="Providers" groupClassName="settings__group--providers">
      {byId('codex').map(renderProviderRow)}
      {byId('claude-code').map(renderProviderRow)}
      {byId('grok').map(renderProviderRow)}
      {direct
        .filter((status) => !['codex', 'claude-code', 'grok'].includes(status.id))
        .map(renderProviderRow)}
    </SettingsPanel>
  )
}

function ModelSettings(props: {
  transport: Transport
  models: ModelChoice[]
  hiddenModels: Set<string>
  onModelVisibilityChange: (key: string, visible: boolean) => void
}) {
  // Existing stored custom choices remain usable in the composer, but raw
  // provider-id editing is intentionally absent from beta settings.
  const catalogModels = props.models.filter((choice) => !isCustomModelChoice(choice))
  const sources = groupModelsBySource(catalogModels)

  return (
    <SettingsPanel title="Models" groupClassName="settings__group--plain model-settings">
      <BackgroundModelSettings transport={props.transport} />
      {sources.length > 0 ? (
        <div className="model-settings__sources">
          {sources.map((group) => (
            <ModelVisibilityGroup
              key={group.key}
              source={group.name}
              choices={group.entries}
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

function BackgroundModelSettings(props: { transport: Transport }) {
  const [state, setState] = useState<BackgroundModelSettingsState>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    setError(undefined)
    void Promise.resolve(props.transport.request('backgroundModel.settings', {}))
      .then((settings) => {
        if (cancelled) return
        if (isBackgroundModelSettingsState(settings)) {
          setState(settings)
        } else {
          setError('Background model settings are unavailable.')
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [props.transport])

  const update = async (preference: BackgroundModelSettingsState['preference']) => {
    setBusy(true)
    setError(undefined)
    try {
      const settings = await props.transport.request('backgroundModel.updateSettings', preference)
      if (!isBackgroundModelSettingsState(settings)) {
        throw new Error('Background model settings are unavailable.')
      }
      setState(settings)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const manual = state?.preference.mode === 'manual' ? state.preference.target : undefined
  const selected = manual ? findBackgroundModel(state?.sources ?? [], manual) : undefined
  const selectedValue = selected
    ? backgroundModelValue(selected.source.id, selected.model.id)
    : manual
      ? 'unavailable'
      : 'automatic'
  const resolved = state?.resolved
  const resolvedChoice = resolved ? findBackgroundModel(state?.sources ?? [], resolved) : undefined
  const automaticNote =
    manual && !selected
      ? `${manual.model} is unavailable. Choose Automatic or another connected model.`
      : resolved
        ? `Currently ${resolvedChoice?.model.displayName ?? resolved.model} through ${resolved.sourceName}${resolved.effort ? ` at ${resolved.effort} effort` : ''}.`
        : 'Connect a provider with an available model to enable background writing.'
  const modelOptions = [
    { value: 'automatic', label: 'Automatic (recommended)' },
    ...(manual && !selected
      ? [{ value: 'unavailable', label: `${manual.model} (unavailable)`, disabled: true }]
      : []),
    ...(state?.sources ?? []).flatMap((source) =>
      source.models.map((model) => ({
        value: backgroundModelValue(source.id, model.id),
        label: model.displayName,
      })),
    ),
  ]
  const effortOptions =
    selected?.model.reasoningEfforts.map((effort) => ({ value: effort, label: effort })) ?? []
  const selectedEffort = manual?.effort ?? effortOptions[0]?.value ?? ''

  return (
    <section className="background-model-settings" aria-label="Background work">
      <header>
        <h2>Background work</h2>
        <p>
          Used for session titles, commit-message drafts, and other short writing. Automatic uses
          Luna at medium on a Codex subscription, or the newest cost-oriented model at its lowest
          effort elsewhere.
        </p>
      </header>
      <div className="settings__group">
        <SettingsRow title="Model" note={automaticNote}>
          <AppSelect
            className="settings__select settings__select--model"
            ariaLabel="Background model"
            align="right"
            value={selectedValue}
            options={modelOptions}
            disabled={!state || busy}
            onChange={(value) => {
              if (value === 'automatic') {
                void update({ mode: 'automatic' })
                return
              }
              const choice = backgroundModelFromValue(state?.sources ?? [], value)
              if (!choice) return
              void update({
                mode: 'manual',
                target: {
                  provider: choice.source.provider,
                  ...(choice.source.connectionId
                    ? { connectionId: choice.source.connectionId }
                    : {}),
                  ...(choice.source.agent ? { agent: choice.source.agent } : {}),
                  model: choice.model.id,
                  ...(choice.model.reasoningEfforts[0]
                    ? { effort: choice.model.reasoningEfforts[0] }
                    : {}),
                },
              })
            }}
          />
        </SettingsRow>
        {manual && selected && effortOptions.length > 0 ? (
          <SettingsRow
            title="Reasoning effort"
            note="Choose the effort used for background writing."
          >
            <AppSelect
              className="settings__select settings__select--effort"
              ariaLabel="Background reasoning effort"
              align="right"
              value={selectedEffort}
              options={effortOptions}
              disabled={busy}
              onChange={(effort) =>
                void update({
                  mode: 'manual',
                  target: { ...manual, effort },
                })
              }
            />
          </SettingsRow>
        ) : null}
      </div>
      {error ? (
        <p className="background-model-settings__error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}

function isBackgroundModelSettingsState(value: unknown): value is BackgroundModelSettingsState {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BackgroundModelSettingsState>
  return (
    Array.isArray(candidate.sources) &&
    (candidate.preference?.mode === 'automatic' || candidate.preference?.mode === 'manual')
  )
}

function findBackgroundModel(sources: BackgroundModelSource[], target: BackgroundModelTarget) {
  const source = sources.find(
    (candidate) =>
      candidate.provider === target.provider &&
      candidate.connectionId === target.connectionId &&
      candidate.agent === target.agent,
  )
  const model = source?.models.find((candidate) => candidate.id === target.model)
  return source && model ? { source, model } : undefined
}

function backgroundModelValue(sourceId: string, modelId: string): string {
  return JSON.stringify([sourceId, modelId])
}

function backgroundModelFromValue(sources: BackgroundModelSource[], value: string) {
  try {
    const [sourceId, modelId] = JSON.parse(value) as [string, string]
    const source = sources.find((candidate) => candidate.id === sourceId)
    const model = source?.models.find((candidate) => candidate.id === modelId)
    return source && model ? { source, model } : undefined
  } catch {
    return undefined
  }
}

function ModelVisibilityGroup(props: {
  source: string
  choices: ModelChoice[]
  hiddenModels: Set<string>
  onModelVisibilityChange: (key: string, visible: boolean) => void
}) {
  const visibleCount = props.choices.filter((choice) => !props.hiddenModels.has(choice.key)).length
  const allVisible = visibleCount === props.choices.length
  const mixedVisibility = visibleCount > 0 && !allVisible

  return (
    <section className="model-visibility" aria-label={props.source}>
      <header className="model-visibility__source">
        {props.choices[0] ? (
          <h3>
            <SourceIdentity presentation={{ label: props.source, mark: props.choices[0].mark }} />
          </h3>
        ) : null}
        <button
          className={`switch model-visibility__source-switch${allVisible ? ' is-on' : ''}${mixedVisibility ? ' is-mixed' : ''}`}
          type="button"
          role="checkbox"
          aria-label={`Include models from ${props.source} in model picker`}
          aria-checked={mixedVisibility ? 'mixed' : allVisible}
          onClick={() => {
            const visible = !allVisible
            for (const choice of props.choices) {
              const currentlyVisible = !props.hiddenModels.has(choice.key)
              if (currentlyVisible !== visible) {
                props.onModelVisibilityChange(choice.key, visible)
              }
            }
          }}
        >
          <span className="switch__thumb" />
        </button>
      </header>

      <div className="model-visibility__models">
        <div>
          {props.choices.map((choice) => {
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
                  aria-label={`Include ${choice.model.displayName} in model picker`}
                  aria-checked={visible}
                  onClick={() => props.onModelVisibilityChange(choice.key, !visible)}
                >
                  <span className="switch__thumb" />
                </button>
              </SettingsRow>
            )
          })}
        </div>
      </div>
    </section>
  )
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
  showMacOSHaptics?: boolean | undefined
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
      {props.showMacOSHaptics ? <SidebarHapticsSetting /> : null}
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

function SidebarHapticsSetting() {
  const enabled = useSyncExternalStore(subscribeAppHaptics, readAppHaptics, readAppHaptics)
  return (
    <div className="appearance__text">
      <h2 className="settings__group-title">Interaction</h2>
      <div className="settings__group">
        <SettingsRow
          title="Trackpad haptics"
          note="Feel responsive detents while resizing, choosing effort, and placing dragged chats."
        >
          <button
            className={`switch${enabled ? ' is-on' : ''}`}
            type="button"
            role="switch"
            aria-label="Trackpad haptics"
            aria-checked={enabled}
            onClick={() => {
              const next = !enabled
              writeAppHaptics(next)
              if (next) {
                prepareAppHaptics()
                performAppHaptic('generic')
              }
            }}
          >
            <span className="switch__thumb" />
          </button>
        </SettingsRow>
      </div>
    </div>
  )
}

/** Self-contained: Settings and the open picker subscribe to the same layout
 *  preference, including its in-memory fallback when storage is unavailable. */
function ModelPickerLayoutToggle() {
  const layout = useSyncExternalStore(subscribeModelPickerLayout, readModelPickerLayout)
  const railOn = layout === 'rail'
  return (
    <button
      className={`switch${railOn ? ' is-on' : ''}`}
      type="button"
      role="switch"
      aria-label="Provider rail layout"
      aria-checked={railOn}
      onClick={() => writeModelPickerLayout(railOn ? 'list' : 'rail')}
    >
      <span className="switch__thumb" />
    </button>
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
  const [confirming, setConfirming] = useState(false)
  const [diagnosticsEnabled, setDiagnosticsEnabled] = useState(false)
  const [diagnosticsError, setDiagnosticsError] = useState<string>()
  const projectLabel = `${props.projectCount} ${props.projectCount === 1 ? 'project' : 'projects'} on this machine`

  useEffect(() => {
    void localDiagnosticsEnabled().then(setDiagnosticsEnabled)
  }, [])

  const toggleDiagnostics = async () => {
    setDiagnosticsError(undefined)
    try {
      setDiagnosticsEnabled(await setLocalDiagnosticsEnabled(!diagnosticsEnabled))
    } catch (cause) {
      setDiagnosticsError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <SettingsPanel title="Data & privacy">
      {isDesktop ? (
        <SettingsRow
          title="Local diagnostics"
          note="Off by default. Stores app errors and crash dumps only on this device. Nothing is uploaded. Turning it off fully applies after restart."
          className="settings__row--roomy"
        >
          {diagnosticsError ? <RowIssue message={diagnosticsError} /> : null}
          {diagnosticsEnabled ? (
            <button
              className="settings__action"
              type="button"
              onClick={() => void openLocalDiagnostics()}
            >
              Open folder
            </button>
          ) : null}
          <button
            className={`switch${diagnosticsEnabled ? ' is-on' : ''}`}
            type="button"
            role="switch"
            aria-label="Local diagnostics"
            aria-checked={diagnosticsEnabled}
            onClick={() => void toggleDiagnostics()}
          >
            <span className="switch__thumb" />
          </button>
        </SettingsRow>
      ) : null}
      <SettingsRow
        title={projectLabel}
        note="Reset only clears this renderer’s preferences. It does not delete projects, workspaces, files, chat history, or provider credentials."
        className="settings__row--roomy"
      >
        <button
          className="settings__action is-danger"
          type="button"
          onClick={() => setConfirming(true)}
        >
          <RotateCcw size={13} aria-hidden />
          <span>Reset app preferences</span>
        </button>
      </SettingsRow>
      {confirming ? (
        <ResetConfirmation
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            props.onReset()
          }}
        />
      ) : null}
    </SettingsPanel>
  )
}

function ResetConfirmation(props: { onCancel: () => void; onConfirm: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.querySelector<HTMLButtonElement>('[data-reset-cancel]')?.focus()
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      props.onCancel()
      return
    }
    if (event.key !== 'Tab' || event.defaultPrevented || !panel.current) return
    const focusable = Array.from(
      panel.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((element) => !element.hasAttribute('disabled'))
    if (focusable.length === 0) return
    const current = focusable.indexOf(document.activeElement as HTMLElement)
    const next =
      current < 0
        ? event.shiftKey
          ? focusable.length - 1
          : 0
        : event.shiftKey
          ? (current - 1 + focusable.length) % focusable.length
          : (current + 1) % focusable.length
    event.preventDefault()
    focusable[next]?.focus()
  }

  return createPortal(
    <div className="sheet" role="presentation">
      <button
        className="sheet__scrim"
        type="button"
        tabIndex={-1}
        aria-label="Cancel reset"
        onClick={props.onCancel}
      />
      <div
        className="sheet__panel checkout-discard"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        ref={panel}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="sheet__head">
          <h2 className="sheet__title" id={titleId}>
            Reset app preferences?
          </h2>
        </header>
        <section className="sheet__section">
          <p className="checkout-discard__copy" id={descriptionId}>
            This clears renderer-local preferences, including appearance, model choices, hidden
            models, layout, and recent UI selections, then reloads TasteCode. Projects, workspaces,
            files, chat history, and provider credentials are not deleted.
          </p>
          <div className="checkout-discard__actions">
            <button className="ghost" type="button" data-reset-cancel onClick={props.onCancel}>
              Cancel
            </button>
            <button className="btn btn--danger" type="button" onClick={props.onConfirm}>
              Reset and reload
            </button>
          </div>
        </section>
      </div>
    </div>,
    document.body,
  )
}

function AboutSettings(props: { transport: Transport }) {
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<ResultOf<'system.updateCheck'>>()
  const [nativeUpdate, setNativeUpdate] = useState<AppUpdateState>()

  useEffect(() => {
    void appUpdateState().then(setNativeUpdate)
    return onAppUpdateState(setNativeUpdate)
  }, [])

  const check = async () => {
    setChecking(true)
    try {
      const native = await appUpdateState()
      if (native.status !== 'unsupported') {
        setNativeUpdate(await checkForAppUpdates())
      } else {
        setResult(await props.transport.request('system.updateCheck', {}))
      }
    } catch (cause) {
      setResult({ error: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setChecking(false)
    }
  }

  const short = (sha: string) => sha.slice(0, 7)
  const nativeChecking = nativeUpdate?.status === 'checking'
  const nativeDownloading = nativeUpdate?.status === 'downloading'
  const nativeReady = nativeUpdate?.status === 'ready'
  // Verdicts stay on the row's one line; a failure goes behind the red dot.
  const updateStatus = !result
    ? undefined
    : result.error
      ? undefined
      : result.upToDate
        ? {
            state: 'ready' as const,
            detail: result.remote ? `Up to date · ${short(result.remote.sha)}` : 'Up to date',
          }
        : result.remote
          ? {
              state: 'setup-needed' as const,
              detail: `Newer: ${short(result.remote.sha)} — pull and restart`,
            }
          : { state: 'unavailable' as const, detail: 'No verdict' }
  const nativeStatus =
    nativeUpdate?.status === 'current'
      ? { state: 'ready' as const, detail: 'Up to date' }
      : nativeDownloading
        ? {
            state: 'checking' as const,
            detail: `Downloading${nativeUpdate.version ? ` ${nativeUpdate.version}` : ''}${nativeUpdate.progress === undefined ? '' : ` · ${nativeUpdate.progress}%`}`,
          }
        : nativeReady
          ? {
              state: 'ready' as const,
              detail: `${nativeUpdate.version ?? 'Update'} ready`,
            }
          : undefined

  return (
    <SettingsPanel title="About">
      <SettingsRow title="TasteCode">
        <SettingsMeta>
          {`${isDesktop ? 'Desktop' : 'Browser'} · ${nativeUpdate && nativeUpdate.status !== 'unsupported' ? nativeUpdate.currentVersion : 'pre-release'}${result?.localCommit ? ` · ${short(result.localCommit)}` : ''}`}
        </SettingsMeta>
      </SettingsRow>
      <SettingsRow title="Updates">
        {nativeUpdate?.status === 'error' ? (
          <RowIssue
            message={nativeUpdate.error ?? 'Update check failed'}
            tip="Check your connection, then retry."
          />
        ) : result?.error ? (
          <RowIssue message={result.error} tip="Check your network or GitHub access, then retry." />
        ) : null}
        {checking || nativeChecking ? <StateLabel state="checking" live /> : null}
        {!checking && !nativeChecking && nativeStatus ? (
          <StateLabel {...nativeStatus} live />
        ) : null}
        {!checking && !nativeChecking && !nativeStatus && updateStatus ? (
          <StateLabel {...updateStatus} live />
        ) : null}
        <button
          className="settings__action"
          type="button"
          disabled={checking || nativeChecking || nativeDownloading}
          onClick={() => void (nativeReady ? installAppUpdate() : check())}
        >
          <RotateCcw size={13} aria-hidden />
          {nativeReady
            ? 'Restart to update'
            : nativeDownloading
              ? 'Downloading…'
              : checking || nativeChecking
                ? 'Checking…'
                : 'Check for updates'}
        </button>
      </SettingsRow>
      <SettingsRow title="Source">
        <button
          className="settings__action"
          type="button"
          onClick={() =>
            window.open('https://github.com/Leonxlnx/tastecode', '_blank', 'noopener,noreferrer')
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
  provider: ProviderStatus
  target: InstallTarget
  transport: Transport
  onInstalled: () => void
}) {
  const key = installKey(props.target)
  const detailsId = useId()
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
    setShowTerminal(false)
    void beginInstall(props.transport, props.target).catch((cause: unknown) =>
      setStartError(cause instanceof Error ? cause.message : String(cause)),
    )
  }

  const status =
    install?.phase === 'running'
      ? 'Installing…'
      : install?.phase === 'succeeded'
        ? 'Installed · refreshing…'
        : install?.phase === 'failed' || startError
          ? 'Install failed'
          : 'Not installed'
  const issue =
    install?.phase === 'failed'
      ? {
          message: `Install failed${install.exitCode === null ? '' : ` (exit ${install.exitCode})`}.`,
          announce: true,
        }
      : startError
        ? {
            message: startError,
            announce: true,
          }
        : undefined
  const setup = props.provider.setup
  const details: ProviderAction | undefined =
    install?.phase === 'running' || install?.phase === 'failed' || install?.phase === 'succeeded'
      ? {
          label: showTerminal ? 'Hide details' : 'Details',
          expanded: showTerminal,
          controls: detailsId,
          onClick: () => setShowTerminal((visible) => !visible),
        }
      : undefined
  const primary: ProviderAction | undefined = !setup?.installCommand
    ? setup
      ? { label: 'Open setup guide', href: setup.installUrl }
      : undefined
    : install?.phase === 'running'
      ? { label: 'Installing…', disabled: true }
      : install?.phase === 'succeeded'
        ? { label: 'Installed', disabled: true }
        : {
            label: install?.phase === 'failed' ? 'Retry install' : 'Install',
            onClick: start,
          }

  return (
    <>
      <ProviderRow
        provider={props.provider}
        status={status}
        live={install?.phase === 'running' || install?.phase === 'succeeded'}
        issue={issue}
        primary={primary}
        secondary={details}
      />
      {install ? (
        <div id={detailsId} className="provider-terminal" hidden={!showTerminal}>
          {showTerminal ? <ProviderTerminal transport={props.transport} installKey={key} /> : null}
        </div>
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
  provider: ProviderStatus
  target: InstallTarget
  transport: Transport
  onSignedIn: () => void
}) {
  const key = loginKey(props.target)
  const detailsId = useId()
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
  const confirmedEmail = signedInEmail(login?.log ?? '')
  useEffect(() => {
    if (confirmedEmail) localStorage.setItem(providerEmailKey(props.provider.id), confirmedEmail)
  }, [confirmedEmail, props.provider.id])

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
          announce: true,
        }
      : startError
        ? {
            message: startError,
            announce: true,
          }
        : props.provider.problem
          ? { message: props.provider.problem }
          : undefined
  const status = running ? 'Signing in…' : issue?.announce ? 'Sign-in failed' : 'Not signed in'
  const details: ProviderAction | undefined =
    login && (running || login.phase === 'failed')
      ? {
          label: showTerminal ? 'Hide details' : 'Details',
          expanded: showTerminal,
          controls: detailsId,
          onClick: () => setShowTerminal((visible) => !visible),
        }
      : undefined

  return (
    <>
      <ProviderRow
        provider={props.provider}
        status={status}
        live={running}
        issue={issue}
        primary={{
          label: running ? 'Signing in…' : login?.phase === 'failed' ? 'Retry sign-in' : 'Sign in',
          disabled: running,
          onClick: start,
        }}
        secondary={details}
      />
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
            <span className="signin-card__live">{login.lastLine}</span>
          ) : null}
        </div>
      ) : null}
      {login ? (
        <div id={detailsId} className="provider-terminal" hidden={!showTerminal}>
          {showTerminal ? <ProviderTerminal transport={props.transport} installKey={key} /> : null}
        </div>
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
function providerEmailKey(provider: ProviderId): string {
  return `harness.providerEmail.${provider}`
}

function AccountIdentity(props: { provider: ProviderId; account: Account }) {
  const [savedEmail] = useState(() => localStorage.getItem(providerEmailKey(props.provider)))
  const email = props.account.email ?? savedEmail
  const claude = props.provider === 'claude-code'

  return (
    <>
      {email ? (
        <>
          {claude ? 'Authenticated as ' : null}
          <AccountEmail email={email} />
        </>
      ) : claude ? (
        'Authenticated'
      ) : (
        'Signed in'
      )}
      {props.account.plan ? ' · ' : null}
      {props.account.plan}
    </>
  )
}

/** T3-style privacy: the fixed-width address stays redacted until explicitly clicked. */
function AccountEmail(props: { email: string }) {
  const [revealed, setRevealed] = useState(false)
  return (
    <button
      className="settings__email"
      type="button"
      data-revealed={revealed}
      aria-label={revealed ? 'Hide account email' : 'Reveal account email'}
      aria-pressed={revealed}
      title={revealed ? 'Click to hide email' : 'Click to reveal email'}
      onClick={() => setRevealed((current) => !current)}
    >
      <span className="settings__email-value">{props.email}</span>
    </button>
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
