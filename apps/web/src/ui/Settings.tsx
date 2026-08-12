import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useDeferredValue,
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
  ConnectionAddress,
  ConnectionsStatus,
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
  BarChart3,
  Bug,
  CircleAlert,
  CircleUserRound,
  Blocks,
  Check,
  ChevronDown,
  Copy,
  Database,
  Eye,
  EyeOff,
  Info,
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
  isCustomModelChoice,
  providerMark,
  type ModelChoice,
  type ProviderMark,
} from '../model-catalog.js'
import { isDesktop, writeClipboardText } from '../bridge.js'
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
import {
  readModelPickerLayout,
  subscribeModelPickerLayout,
  writeModelPickerLayout,
} from '../model-picker-layout.js'
import { McpSettings } from './McpSettings.js'
import { Menu, MenuItem } from './Menu.js'
import { ModelSearchField } from './ModelSearchField.js'
import { groupModelsBySource } from './ModelSelector.js'
import { SkillsSettings } from './SkillsSettings.js'
import { ProviderIcon } from './ProviderIcon.js'
import { ProviderRow, type ProviderAction } from './ProviderRow.js'
import { ProfileSettings } from './ProfileSettings.js'
import type { ProfileIdentityPreferences } from '../profile-preferences.js'
import { renderQrSvg } from './qr-code.js'
import { SourceIdentity } from './SourceIdentity.js'
import { CountBadge, SettingsMeta, StateLabel } from './SettingsStatus.js'
import { UsageSettings } from './UsageSettings.js'

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
  | 'mobile'
  | 'usage'
  | 'appearance'
  | 'data'
  | 'debug'
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
  onProfileIdentityChange?: ((identity: ProfileIdentityPreferences) => void) | undefined
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
            active={section === 'mobile'}
            icon={<Smartphone size={15} aria-hidden />}
            label="Mobile access"
            onClick={() => setSection('mobile')}
          />
          <SettingsNavItem
            active={section === 'usage'}
            icon={<BarChart3 size={15} aria-hidden />}
            label="Usage"
            onClick={() => setSection('usage')}
          />
          <SettingsNavItem
            active={section === 'data'}
            icon={<Database size={15} aria-hidden />}
            label="Data & privacy"
            onClick={() => setSection('data')}
          />
          <SettingsNavItem
            active={section === 'debug'}
            icon={<Bug size={15} aria-hidden />}
            label="Debug"
            onClick={() => setSection('debug')}
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
          className={`settings__content${section === 'profile' ? ' settings__content--profile' : ''}${section === 'usage' ? ' settings__content--usage' : ''}`}
        >
          {section === 'profile' ? (
            <ProfileSettings
              transport={props.transport}
              account={props.account}
              providerName={props.providerName}
              identity={props.profileIdentity}
              onIdentityChange={props.onProfileIdentityChange}
            />
          ) : null}
          {section === 'providers' ? <ProviderSettings {...props} /> : null}
          {section === 'models' ? <ModelSettings {...props} /> : null}
          {section === 'mcp' ? <McpSettings {...props} /> : null}
          {section === 'skills' ? <SkillsSettings {...props} /> : null}
          {section === 'workflows' ? <WorkflowSettings {...props} /> : null}
          {section === 'mobile' ? <MobileAccessSettings transport={props.transport} /> : null}
          {section === 'usage' ? <UsageSettings transport={props.transport} /> : null}
          {section === 'appearance' ? <AppearanceSettings {...props} /> : null}
          {section === 'data' ? <DataSettings {...props} /> : null}
          {section === 'debug' ? <DebugSettings transport={props.transport} /> : null}
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
  models: ModelChoice[]
  hiddenModels: Set<string>
  onModelVisibilityChange: (key: string, visible: boolean) => void
}) {
  // Existing stored custom choices remain usable in the composer, but raw
  // provider-id editing is intentionally absent from beta settings.
  const catalogModels = props.models.filter((choice) => !isCustomModelChoice(choice))
  const sources = groupModelsBySource(catalogModels)
  const visibleModelCount = catalogModels.filter(
    (choice) => !props.hiddenModels.has(choice.key),
  ).length

  return (
    <SettingsPanel title="Models" groupClassName="settings__group--plain model-settings">
      {catalogModels.length > 0 ? (
        <div className="model-settings__summary">
          <span>
            {visibleModelCount} of {catalogModels.length} visible
          </span>
        </div>
      ) : null}

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

function ModelVisibilityGroup(props: {
  source: string
  choices: ModelChoice[]
  hiddenModels: Set<string>
  onModelVisibilityChange: (key: string, visible: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const visibleCount = props.choices.filter((choice) => !props.hiddenModels.has(choice.key)).length
  const allVisible = visibleCount === props.choices.length
  const mixedVisibility = visibleCount > 0 && !allVisible
  const filteredChoices = filterModelChoicesByQuery(props.choices, deferredQuery)

  return (
    <section className="model-visibility" aria-label={props.source}>
      <header className="model-visibility__source">
        <div className="model-visibility__source-copy">
          {props.choices[0] ? (
            <h3>
              <SourceIdentity presentation={{ label: props.source, mark: props.choices[0].mark }} />
            </h3>
          ) : null}
          <CountBadge
            value={`${visibleCount}/${props.choices.length}`}
            label={`${visibleCount} of ${props.choices.length} models visible`}
          />
        </div>
        <ModelSearchField
          className="model-visibility__search"
          value={query}
          label={`Search ${props.source} models`}
          onChange={setQuery}
        />
        <button
          className={`switch switch--source${allVisible ? ' is-on' : ''}${mixedVisibility ? ' is-mixed' : ''}`}
          type="button"
          role="checkbox"
          aria-label={`Show models from ${props.source}`}
          aria-checked={mixedVisibility ? 'mixed' : allVisible}
          onClick={() => {
            // Mixed and off both converge to all visible; only a fully-on
            // source turns off. The tri-state control never hides a model
            // just because a sibling was already hidden.
            for (const choice of props.choices)
              props.onModelVisibilityChange(choice.key, !allVisible)
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
  const [webQrSvg, setWebQrSvg] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<'pair' | 'stop' | string>()
  const [copiedPairingUri, setCopiedPairingUri] = useState<string>()
  const [copiedWebUrl, setCopiedWebUrl] = useState<string>()
  const [now, setNow] = useState(Date.now)
  const transportEpoch = useRef(0)
  const statusMutationEpoch = useRef(0)
  const statusRequest = useRef<Promise<void> | undefined>(undefined)

  const refresh = useCallback(() => {
    if (statusRequest.current) return statusRequest.current

    const mutationEpoch = statusMutationEpoch.current
    const request = (async () => {
      try {
        const nextStatus = await props.transport.request('connections.status', {})
        if (mutationEpoch !== statusMutationEpoch.current) return
        setStatus(nextStatus)
        setError(undefined)
      } catch (cause) {
        if (mutationEpoch !== statusMutationEpoch.current) return
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    statusRequest.current = request
    void request.then(() => {
      if (statusRequest.current === request) statusRequest.current = undefined
    })
    return request
  }, [props.transport])

  const invalidateStatusReads = () => {
    statusMutationEpoch.current += 1
    statusRequest.current = undefined
  }

  useEffect(() => {
    setBusy(undefined)
    void refresh()
    const timer = window.setInterval(() => {
      setNow(Date.now())
      void refresh()
    }, 2_000)
    return () => {
      window.clearInterval(timer)
      transportEpoch.current += 1
      invalidateStatusReads()
    }
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

  const primaryWebUrl = status?.webUrls?.[0]
  useEffect(() => {
    if (!primaryWebUrl) {
      setWebQrSvg(undefined)
      return
    }
    let cancelled = false
    void renderQrSvg(primaryWebUrl)
      .then((svg) => {
        if (!cancelled) setWebQrSvg(svg)
      })
      .catch(() => {
        // QR rendering is a convenience; a broken one must not block the panel.
        if (!cancelled) setWebQrSvg(undefined)
      })
    return () => {
      cancelled = true
    }
  }, [primaryWebUrl])

  const startPairing = async () => {
    const requestTransportEpoch = transportEpoch.current
    setBusy('pair')
    try {
      const offer = await props.transport.request('connections.startPairing', {})
      if (requestTransportEpoch !== transportEpoch.current) return
      invalidateStatusReads()
      setStatus(offer)
      setPairing(offer)
      setNow(Date.now())
      setError(undefined)
    } catch (cause) {
      if (requestTransportEpoch !== transportEpoch.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (requestTransportEpoch === transportEpoch.current) setBusy(undefined)
    }
  }

  const stop = async () => {
    const requestTransportEpoch = transportEpoch.current
    setBusy('stop')
    try {
      await props.transport.request('connections.stop', {})
      if (requestTransportEpoch !== transportEpoch.current) return
      invalidateStatusReads()
      setPairing(undefined)
      await refresh()
    } catch (cause) {
      if (requestTransportEpoch !== transportEpoch.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (requestTransportEpoch === transportEpoch.current) setBusy(undefined)
    }
  }

  const disconnectDevice = async (deviceId: string) => {
    const requestTransportEpoch = transportEpoch.current
    setBusy(deviceId)
    try {
      await props.transport.request('connections.revoke', { deviceId })
      if (requestTransportEpoch !== transportEpoch.current) return
      invalidateStatusReads()
      await refresh()
    } catch (cause) {
      if (requestTransportEpoch !== transportEpoch.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (requestTransportEpoch === transportEpoch.current) setBusy(undefined)
    }
  }

  const copyPairingLink = async (pairingUri: string) => {
    try {
      await writeClipboardText(pairingUri)
      setCopiedPairingUri(pairingUri)
      setError(undefined)
    } catch (cause) {
      setCopiedPairingUri(undefined)
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(`Could not copy pairing link: ${message}`)
    }
  }

  const copyWebUrl = async (url: string) => {
    try {
      await writeClipboardText(url)
      setCopiedWebUrl(url)
      setError(undefined)
    } catch (cause) {
      setCopiedWebUrl(undefined)
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(`Could not copy the app link: ${message}`)
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
            : 'Generate a one-time code to accept the native app again. The web app stays available.'
        }
      >
        <StateLabel state={status?.enabled ? 'ready' : 'unavailable'} />
      </SettingsRow>

      {(status?.webUrls?.length ?? 0) > 0 ? (
        <div className="settings__mobile-block">
          <div className="settings__web-access">
            <div className="settings__web-access-qr">
              {webQrSvg ? (
                <div
                  className="settings__qr"
                  role="img"
                  aria-label="App QR code"
                  dangerouslySetInnerHTML={{ __html: webQrSvg }}
                />
              ) : (
                <div className="settings__qr" aria-hidden>
                  Generating QR…
                </div>
              )}
              <p className="settings__qr-caption">Scan to open it on your phone</p>
            </div>
            <div className="settings__web-access-main">
              <p className="settings__row-title">App on your phone — bookmark this</p>
              <p className="settings__row-note">
                The URL stays the same across restarts. Open it on your phone to use the whole
                harness — the same UI as this desktop.
              </p>
              <div className="settings__console-urls">
                {status?.webUrls.map((url, index) => (
                  <UrlRow
                    url={url}
                    key={url}
                    primary={index === 0}
                    copied={copiedWebUrl === url}
                    onCopy={() => void copyWebUrl(url)}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

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
            {busy === 'stop' ? 'Stopping...' : 'Stop accepting connections'}
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
              onClick={() => void copyPairingLink(activePairing.pairingUri)}
            >
              {copiedPairingUri === activePairing.pairingUri ? 'Copied' : 'Copy pairing link'}
            </button>
          </div>
        </div>
      ) : null}

      <h2 className="settings__group-title settings__group-title--inside">Paired devices</h2>
      {status?.devices.length ? (
        status.devices.map((device) => (
          <SettingsRow
            key={device.id}
            title={device.name}
            note={formatDeviceNote(device.lastSeenAt, now)}
          >
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

function UrlRow(props: { url: string; primary: boolean; copied: boolean; onCopy: () => void }) {
  return (
    <div className="settings__console-url">
      <code className="settings__console-url-code" title={props.url}>
        {props.url}
      </code>
      {props.primary ? (
        <span className="settings__console-primary" title="The QR above encodes this URL">
          QR
        </span>
      ) : null}
      <button
        className={`settings__console-copy${props.copied ? ' is-copied' : ''}`}
        type="button"
        onClick={props.onCopy}
      >
        {props.copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
        {props.copied ? 'Copied' : 'Copy'}
      </button>
    </div>
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

export function formatDeviceNote(lastSeenAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - lastSeenAt) / 60_000))
  if (minutes === 0) return 'Seen just now'
  if (minutes < 60) return `Seen ${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Seen ${hours}h ago`
  return `Seen ${Math.floor(hours / 24)}d ago`
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
  const projectLabel = `${props.projectCount} ${props.projectCount === 1 ? 'project' : 'projects'} on this machine`

  return (
    <SettingsPanel title="Data & privacy">
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
            models, layout, and recent UI selections, then reloads Personal Harness. Projects,
            workspaces, files, chat history, and provider credentials are not deleted.
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

export function DebugSettings(props: { transport: Transport }) {
  const [state, setState] = useState<'idle' | 'resetting' | 'started' | 'error'>('idle')
  const [error, setError] = useState<string>()

  const resetUsage = async () => {
    setState('resetting')
    setError(undefined)
    try {
      await props.transport.request('usage.resetHistory', {})
      setState('started')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setState('error')
    }
  }

  return (
    <SettingsPanel title="Debug">
      <SettingsRow
        title="Usage history index"
        note="Clears the generated cache and reparses every local provider history. Sessions and Harness data are not deleted."
        className="settings__row--roomy"
      >
        {state === 'started' ? <StateLabel state="checking" detail="Scan started" live /> : null}
        {state === 'error' && error ? (
          <RowIssue message={error} tip="Restart the app, then try the reset again." />
        ) : null}
        <button
          className="settings__action"
          type="button"
          disabled={state === 'resetting'}
          onClick={() => void resetUsage()}
        >
          <RotateCcw size={13} aria-hidden />
          <span>{state === 'resetting' ? 'Resetting…' : 'Reset and rescan'}</span>
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

  return (
    <SettingsPanel title="About">
      <SettingsRow title="Personal Harness">
        <SettingsMeta>
          {`${isDesktop ? 'Desktop' : 'Browser'} · pre-release${result?.localCommit ? ` · ${short(result.localCommit)}` : ''}`}
        </SettingsMeta>
      </SettingsRow>
      <SettingsRow title="Updates">
        {result?.error ? (
          <RowIssue message={result.error} tip="Check your network or GitHub access, then retry." />
        ) : null}
        {checking ? <StateLabel state="checking" live /> : null}
        {!checking && updateStatus ? <StateLabel {...updateStatus} live /> : null}
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
function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 1) return email
  return `${email[0]}${'*'.repeat(at - 1)}${email.slice(at)}`
}

/**
 * Privacy by default: the address stays masked until explicitly revealed.
 * Both forms render stacked in one grid cell so the row never shifts when
 * the longer full address appears.
 */
function AccountEmail(props: { email: string }) {
  const [revealed, setRevealed] = useState(false)

  return (
    <span className={`settings__email${revealed ? ' is-revealed' : ''}`}>
      <span
        className="settings__email-toggle"
        aria-label={revealed ? 'Hide account email' : 'Show account email'}
        tabIndex={0}
        onMouseEnter={() => setRevealed(true)}
        onMouseLeave={() => setRevealed(false)}
        onFocus={() => setRevealed(true)}
        onBlur={() => setRevealed(false)}
      >
        {revealed ? <EyeOff size={12} aria-hidden /> : <Eye size={12} aria-hidden />}
      </span>
      <span className="settings__email-value" aria-live="polite">
        <span className="settings__email-masked" aria-hidden={revealed}>
          {maskEmail(props.email)}
        </span>
        <span className="settings__email-full" aria-hidden={!revealed}>
          {props.email}
        </span>
      </span>
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
