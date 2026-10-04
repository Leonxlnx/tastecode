import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { RowIssue } from './RowIssue.js'
import { surfaceLoadFailed } from '../surface-load-error.js'
import { AppearanceColorPicker } from './AppearanceColorPicker.js'
import { accentColor, backdropColor, backdropColorScheme } from '../theme-colors.js'
import {
  getFastModeOffValue,
  getFastServiceTier,
  getNextServiceTierForModel,
  isFastModeEnabled,
} from './model-selector-utils.js'
import { IconMorph } from './IconMorph.js'
import { BackgroundModelSettingsSchema } from '@harness/contracts'
import '../styles/settings.css'
import type {
  Account,
  ApprovalMode,
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
import { z } from 'zod'
import {
  IconChartBar as BarChart3,
  IconChevronDown as ChevronDown,
  IconKey as KeyRound,
  IconArrowLeft as ArrowLeft,
  IconUserCircle as CircleUserRound,
  IconBlocks as Blocks,
  IconBug as Bug,
  IconDatabase as Database,
  IconEye as Eye,
  IconEyeOff as EyeOff,
  IconInfoCircle as Info,
  IconPackages as Boxes,
  IconKeyboard as Keyboard,
  IconNetwork as Network,
  IconPalette as Palette,
  IconLayoutSidebar as PanelLeft,
  IconRotate as RotateCcw,
  IconUser as UserRound,
} from '@tabler/icons-react'
import { connectionMark, isCustomModelChoice, type ModelChoice } from '../model-catalog.js'
import {
  pinnableModels,
  pinnedModelChoice,
  providerApprovalDefault,
  type ProviderDefault,
  type ProviderDefaults,
} from '../provider-defaults.js'
import {
  ProviderTuning,
  ProviderTuningSkeleton,
  useProviderContextSettings,
} from './ProviderTuning.js'
import { Skeleton, SkeletonCode, SkeletonStatus } from './Skeleton.js'
import { listInstalledFontFamilies, readInstalledFontFamilies } from '../local-fonts.js'
import {
  appUpdateState,
  checkForAppUpdates,
  installAppUpdate,
  isDesktop,
  localDiagnosticsEnabled,
  onAppUpdateState,
  openLocalDiagnostics,
  setLocalDiagnosticsEnabled,
  simulateAppUpdate,
  type AppUpdateState,
} from '../bridge.js'
import {
  onSimulatedAppUpdate,
  simulatedAppUpdate,
  stopAppUpdateSimulation,
  type AppUpdateSimulation,
} from '../app-update-simulation.js'
import {
  beginInstall,
  beginLogin,
  cancelInstall,
  clearInstall,
  deviceCode,
  installKey,
  installState,
  loginKey,
  signedInEmail,
  subscribeInstalls,
  type InstallTarget,
  type ProviderLoginTerminalTarget,
} from '../provider-install.js'
import type { Transport } from '../transport.js'
import {
  fontFamilyFromPreference,
  fontPreferenceForFamily,
  type AccentPreference,
  type AppearancePreference,
  type AppearancePreferences,
  type BackdropPreference,
  type FontPreference,
  type ThemePreference,
  type ThemeColorScheme,
} from '../theme.js'
import {
  performAppHaptic,
  prepareAppHaptics,
  readAppHaptics,
  subscribeAppHaptics,
  writeAppHaptics,
} from '../haptics.js'
import { AppSelect } from './AppSelect.js'
import { Menu, MenuItem } from './Menu.js'
import { ProviderIcon } from './ProviderIcon.js'
import { McpSettings } from './McpSettings.js'
import { groupModelsBySource } from './model-selector-utils.js'
import { SkillsSettings } from './SkillsSettings.js'
import { ProviderRow, ProviderRowSkeleton, type ProviderAction } from './ProviderRow.js'
import { ProfileSettings } from './ProfileSettings.js'
import { GeneratedAvatarLab } from './GeneratedAvatarLab.js'
import type { ProfileIdentityPreferences } from '../profile-preferences.js'
import { SourceIdentity } from './SourceIdentity.js'
import { SettingsMeta, StateLabel } from './SettingsStatus.js'
import { UsageSettings } from './UsageSettings.js'
import {
  DEFAULT_KEYBINDINGS,
  type KeybindingId,
  type Keybindings,
  type Shortcut,
} from '../shortcuts.js'
import { KeybindSettings } from './KeybindSettings.js'
import { GeneralSettings } from './GeneralSettings.js'
import { ProviderUpdateCheck } from './ProviderUpdates.js'
import { useProviderUpdates, type ProviderUpdateSimulation } from '../provider-updates.js'

const InstallTerminal = lazy(() =>
  import('./InstallTerminal.js')
    .then((module) => ({ default: module.InstallTerminal }))
    .catch(surfaceLoadFailed),
)

export type SettingsSection =
  | 'profile'
  | 'providers'
  | 'models'
  | 'mcp'
  | 'skills'
  | 'workflows'
  | 'usage'
  | 'appearance'
  | 'keybinds'
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
  { value: 'mono', label: 'Geist Mono' },
  { value: 'inter', label: 'Inter' },
  { value: 'system', label: 'System default' },
] as const satisfies ReadonlyArray<{ value: FontPreference; label: string }>

const FONT_SEARCH = {
  label: 'Search fonts',
  placeholder: 'Search fonts…',
  emptyMessage: 'No matching fonts',
} as const

function legacyFontLabel(font: FontPreference): string | undefined {
  if (font === 'humanist') return 'Humanist'
  if (font === 'rounded') return 'Rounded'
  if (font === 'serif') return 'Editorial'
  return undefined
}

function fontOptionKey(label: string): string {
  return label.normalize('NFKC').toLocaleLowerCase('en-US')
}

function compareFontOptions(left: { label: string }, right: { label: string }): number {
  return left.label.localeCompare(right.label, undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

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

const GLASS_SELECT_OPTIONS = GLASS_OPTIONS.map((option) => ({
  value: String(option.value),
  label: option.label,
}))

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

function noop(): void {}
function noopKeybindingChange(_action: KeybindingId, _shortcut: Shortcut | null): void {}

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
  accountLoading?: boolean | undefined
  profileIdentity?: ProfileIdentityPreferences | undefined
  onProfileIdentityChange?: ((updates: Partial<ProfileIdentityPreferences>) => void) | undefined
  providerStatuses: ProviderStatus[]
  acpAgents?: ResultOf<'acp.agents'>['agents'] | undefined
  modelConnections?: ModelConnection[] | undefined
  /** The provider list has not arrived yet. */
  providersLoading?: boolean | undefined
  models: ModelChoice[]
  modelsLoading?: boolean | undefined
  hiddenModels: Set<string>
  onModelVisibilityChange: (key: string, visible: boolean) => void
  providerDefaults?: ProviderDefaultsControls | undefined
  onConnectionsChanged: () => void
  projectCount: number
  projectsLoading?: boolean | undefined
  sidebarSettings: SidebarSettings
  onSidebarSettingsChange: (settings: Partial<SidebarSettings>) => void
  themePreference: ThemePreference
  themeColorScheme: ThemeColorScheme
  onThemePreferenceChange: (theme: ThemePreference) => void
  appearancePreferences: AppearancePreferences
  onAppearancePreferenceChange: (
    mode: ThemeColorScheme,
    updates: Partial<AppearancePreference>,
  ) => void
  showMacOSFontSmoothing: boolean
  macOSFontSmoothing: boolean
  onMacOSFontSmoothingChange: (enabled: boolean) => void
  macOS?: boolean | undefined
  keybindings?: Keybindings | undefined
  onKeybindingChange?: ((action: KeybindingId, shortcut: Shortcut | null) => void) | undefined
  onKeybindingsReset?: (() => void) | undefined
  showMacOSHaptics?: boolean | undefined
  onAccountChange: (provider: ProviderId, account: Account) => void
  authRefreshRevision?: number | undefined
  initialSection?: SettingsSection | undefined
  showDebug?: boolean | undefined
  onReset: () => void
  onForceOnboarding?: (() => void) | undefined
  onClose: () => void
  onProviderLoginTerminalOpen?: ((target: ProviderLoginTerminalTarget) => void) | undefined
}) {
  const [selectedSection, setSection] = useState<SettingsSection>(
    props.initialSection ?? 'workflows',
  )
  const section = selectedSection === 'debug' && !props.showDebug ? 'workflows' : selectedSection

  useEffect(() => {
    setSection(props.initialSection ?? 'workflows')
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
            active={section === 'keybinds'}
            icon={<Keyboard size={15} aria-hidden />}
            label="Keybinds"
            onClick={() => setSection('keybinds')}
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
          {props.showDebug ? (
            <SettingsNavItem
              active={section === 'debug'}
              icon={<Bug size={15} aria-hidden />}
              label="Debug"
              onClick={() => setSection('debug')}
            />
          ) : null}
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
          className={`settings__content${section === 'usage' ? ' settings__content--usage' : ''}`}
        >
          {section === 'profile' ? (
            <ProfileSettings
              transport={props.transport}
              account={props.account}
              accountLoading={props.accountLoading}
              providerName={props.providerName}
              identity={props.profileIdentity}
              onIdentityChange={props.onProfileIdentityChange}
            />
          ) : null}
          {section === 'providers' ? <ProviderSettings {...props} /> : null}
          {section === 'models' ? <ModelSettings {...props} /> : null}
          {section === 'mcp' ? (
            <McpSettings
              {...props}
              providers={props.providerStatuses.map(({ id, displayName }) => ({
                provider: id,
                providerName: displayName,
              }))}
            />
          ) : null}
          {section === 'skills' ? <SkillsSettings {...props} /> : null}
          {section === 'workflows' ? <GeneralSettings {...props} /> : null}
          {section === 'usage' ? <UsageSettings transport={props.transport} /> : null}
          {section === 'appearance' ? <AppearanceSettings {...props} /> : null}
          {section === 'keybinds' ? (
            <KeybindSettings
              keybindings={props.keybindings ?? DEFAULT_KEYBINDINGS}
              macOS={props.macOS ?? false}
              onChange={props.onKeybindingChange ?? noopKeybindingChange}
              onReset={props.onKeybindingsReset ?? noop}
            />
          ) : null}
          {section === 'data' ? <DataSettings {...props} /> : null}
          {section === 'debug' ? (
            <SettingsPanel title="Debug">
              <SettingsRow title="Onboarding">
                <button
                  className="btn"
                  onClick={props.onForceOnboarding}
                  disabled={!props.onForceOnboarding}
                >
                  Force onboarding
                </button>
              </SettingsRow>
              <UsageHistoryReset transport={props.transport} />
              <AppUpdateSimulationRow />
              <ProviderUpdateSimulationRow transport={props.transport} />
              <SettingsRow
                title="Avatar generator"
                note="The picture a profile gets from its name when no photo is uploaded. Same name, same picture, on every provider."
                className="settings__row--roomy"
              />
              <GeneratedAvatarLab initialName={props.profileIdentity?.displayName} />
            </SettingsPanel>
          ) : null}
          {section === 'about' ? <AboutSettings transport={props.transport} /> : null}
        </div>
      </main>
    </div>
  )
}

const UPDATE_SIMULATIONS = [
  { scenario: 'update', label: 'Update' },
  { scenario: 'failure', label: 'Failure' },
  { scenario: 'current', label: 'Up to date' },
] as const satisfies ReadonlyArray<{ scenario: AppUpdateSimulation; label: string }>

function AppUpdateSimulationRow() {
  const [running, setRunning] = useState(() => simulatedAppUpdate() !== undefined)
  useEffect(() => onSimulatedAppUpdate((state) => setRunning(state !== undefined)), [])

  return (
    <SettingsRow
      title="Simulate app update"
      note="Plays a fake release through the sidebar button and About. Nothing is downloaded; restarting reloads the window."
      className="settings__row--roomy"
    >
      {UPDATE_SIMULATIONS.map(({ scenario, label }) => (
        <button
          key={scenario}
          className="settings__action"
          type="button"
          onClick={() => void simulateAppUpdate(scenario)}
        >
          {label}
        </button>
      ))}
      <button
        className="settings__action"
        type="button"
        disabled={!running}
        onClick={stopAppUpdateSimulation}
      >
        Stop
      </button>
    </SettingsRow>
  )
}

const PROVIDER_UPDATE_SIMULATIONS = [
  { scenario: 'one', label: 'One release' },
  { scenario: 'several', label: 'Three releases' },
  { scenario: 'failure', label: 'Failing update' },
] as const satisfies ReadonlyArray<{ scenario: ProviderUpdateSimulation; label: string }>

function ProviderUpdateSimulationRow(props: { transport: Transport }) {
  const { store, state } = useProviderUpdates(props.transport)
  return (
    <SettingsRow
      title="Simulate provider updates"
      note="Pops the update notice with made-up releases one step past what is installed. Update plays the whole run without touching a CLI; dismissing the notice ends it."
      className="settings__row--roomy"
    >
      {PROVIDER_UPDATE_SIMULATIONS.map(({ scenario, label }) => (
        <button
          key={scenario}
          className="settings__action"
          type="button"
          onClick={() => store.simulate(scenario)}
        >
          {label}
        </button>
      ))}
      <button
        className="settings__action"
        type="button"
        aria-label="Stop provider update simulation"
        disabled={!state.simulation}
        onClick={store.stopSimulation}
      >
        Stop
      </button>
    </SettingsRow>
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

const CONNECTION_PRESETS = {
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
} satisfies Record<
  ModelConnectionPreset,
  { label: string; transport: ModelTransport; baseUrl: string; placeholder: string }
>

type ProviderMap<T> = Partial<Record<ProviderId, T>>

// Nightly exposes every installed CLI; ACP agents and API connections have their own rows.
const PROVIDER_ROSTER: readonly ProviderId[] = [
  'codex',
  'claude-code',
  'grok',
  'cursor',
  'opencode',
  'antigravity',
  'pi',
]

/** What a new chat on each provider starts with. The app shell owns it. */
export type ProviderDefaultsControls = {
  pins: ProviderDefaults
  onPinChange: (provider: ProviderId, pin: ProviderDefault | undefined) => void
  access: ProviderMap<ApprovalMode>
  onAccessChange: (provider: ProviderId, mode: ApprovalMode) => void
}

export function ProviderSettings(props: {
  provider: ProviderId
  account: Account | undefined
  providerStatuses: ProviderStatus[]
  acpAgents?: ResultOf<'acp.agents'>['agents'] | undefined
  modelConnections?: ModelConnection[] | undefined
  providersLoading?: boolean | undefined
  projectPath?: string | undefined
  transport: Transport
  models?: ModelChoice[] | undefined
  hiddenModels?: Set<string> | undefined
  providerDefaults?: ProviderDefaultsControls | undefined
  onConnectionsChanged: () => void
  onAccountChange: (provider: ProviderId, account: Account) => void
  authRefreshRevision?: number | undefined
  onProviderLoginTerminalOpen?: ((target: ProviderLoginTerminalTarget) => void) | undefined
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

  const [agentAccounts, setAgentAccounts] = useState<Record<string, Account>>({})
  const [agentAccountErrors, setAgentAccountErrors] = useState<Record<string, string>>({})
  const [agentBusy, setAgentBusy] = useState<string>()
  const [addingConnection, setAddingConnection] = useState(false)
  const [connectionPreset, setConnectionPreset] = useState<ModelConnectionPreset>('openai')
  const [connectionName, setConnectionName] = useState(CONNECTION_PRESETS.openai.label)
  const [connectionBaseUrl, setConnectionBaseUrl] = useState(CONNECTION_PRESETS.openai.baseUrl)
  const [connectionDefaultModel, setConnectionDefaultModel] = useState('')
  const [connectionApiKey, setConnectionApiKey] = useState('')
  const [connectionError, setConnectionError] = useState<string>()
  const [connectionSaving, setConnectionSaving] = useState(false)
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
  const providerDefaults = props.providerDefaults
  const context = useProviderContextSettings(props.transport, providerDefaults !== undefined)

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

  useEffect(() => {
    const account = props.account
    if (!account) return
    delete statusRequests.current[props.provider]
    setAuthStates((current) => ({
      ...current,
      [props.provider]: { phase: 'ready', account },
    }))
  }, [props.provider, props.account])

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
    .filter((status) => status.installed && status.id !== 'acp' && status.id !== 'api')
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
  }, [props.transport, props.authRefreshRevision, authProviderKey, completeLogin, refreshAccount])

  useEffect(() => {
    operations.current = {}
    setAuthOperations({})
    setAuthErrors({})
  }, [props.transport])

  const refreshAgentAccount = useCallback(
    async (agentId: string) => {
      try {
        const account = await props.transport.request('auth.status', {
          provider: 'acp',
          agent: agentId,
        })
        setAgentAccounts((current) => ({ ...current, [agentId]: account }))
        setAgentAccountErrors((current) => ({ ...current, [agentId]: '' }))
      } catch (cause) {
        setAgentAccountErrors((current) => ({
          ...current,
          [agentId]: cause instanceof Error ? cause.message : String(cause),
        }))
      }
    },
    [props.transport],
  )

  const installedAgentKey = (props.acpAgents ?? [])
    .filter((agent) => agent.installed)
    .map((agent) => agent.id)
    .join('|')
  useEffect(() => {
    for (const agentId of installedAgentKey.split('|')) {
      if (agentId) void refreshAgentAccount(agentId)
    }
  }, [installedAgentKey, refreshAgentAccount])

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
      delete statusRequests.current[provider]
      const account = { signedIn: false }
      try {
        localStorage.removeItem(providerEmailKey(provider))
      } catch {
        // An optional display cache must not turn a successful sign-out into a failure.
      }
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

  const signOutAgent = async (agentId: string) => {
    setAgentBusy(agentId)
    setAgentAccountErrors((current) => ({ ...current, [agentId]: '' }))
    try {
      await props.transport.request('auth.signOut', { provider: 'acp', agent: agentId })
      setAgentAccounts((current) => ({ ...current, [agentId]: { signedIn: false } }))
    } catch (cause) {
      setAgentAccountErrors((current) => ({
        ...current,
        [agentId]: cause instanceof Error ? cause.message : String(cause),
      }))
    } finally {
      setAgentBusy((current) => (current === agentId ? undefined : current))
    }
  }

  const chooseConnectionPreset = (preset: ModelConnectionPreset) => {
    const config = CONNECTION_PRESETS[preset]
    setConnectionPreset(preset)
    setConnectionName(config.label)
    setConnectionBaseUrl(config.baseUrl)
    setConnectionDefaultModel('')
  }

  const addConnection = async () => {
    setConnectionSaving(true)
    setConnectionError(undefined)
    try {
      const id = `${connectionPreset}-${crypto.randomUUID()}`
      await props.transport.request('connections.upsert', {
        id,
        displayName: connectionName.trim(),
        preset: connectionPreset,
        transport: CONNECTION_PRESETS[connectionPreset].transport,
        baseUrl: connectionBaseUrl.trim(),
        ...(connectionDefaultModel.trim() ? { defaultModel: connectionDefaultModel.trim() } : {}),
        enabled: true,
      })
      await props.transport.request('connections.setCredential', {
        connectionId: id,
        apiKey: connectionApiKey.trim(),
      })
      setAddingConnection(false)
      setConnectionApiKey('')
      props.onConnectionsChanged()
    } catch (cause) {
      setConnectionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setConnectionSaving(false)
    }
  }

  const renderAccountRow = (status: ProviderStatus) => {
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
          onOpenExpandedTerminal={props.onProviderLoginTerminalOpen}
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
          onOpenExpandedTerminal={props.onProviderLoginTerminalOpen}
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
        link={account?.signedIn ? 'connected' : 'open'}
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
            ? {
                label: operation?.kind === 'sign-out' ? 'Signing out…' : 'Sign out',
                disabled: operation !== undefined,
                danger: true,
                onClick: () => void signOut(status.id),
              }
            : {
                label: operation?.kind === 'sign-in' ? 'Signing in…' : 'Sign in',
                disabled: operation !== undefined,
                onClick: () => void signIn(status.id),
              }
        }
      />
    )
  }

  const byId = (id: ProviderId) => props.providerStatuses.filter((status) => status.id === id)
  const knownAgentIds = new Set(['gemini', 'kimi', 'qwen'])
  const agents = [
    ...(props.acpAgents ?? []).filter((agent) => knownAgentIds.has(agent.id)),
    ...(props.acpAgents ?? []).filter((agent) => !knownAgentIds.has(agent.id)),
  ]

  const renderAgentRow = (agent: ResultOf<'acp.agents'>['agents'][number]) => {
    const provider: ProviderStatus = {
      id: 'acp',
      displayName: agent.name,
      installed: agent.installed,
      auth: 'unknown',
      setup: agent.setup,
      ...(agent.problem ? { problem: agent.problem } : {}),
    }
    if (!agent.installed) {
      return (
        <InstallableRow
          key={agent.id}
          provider={provider}
          target={{ provider: 'acp', agent: agent.id }}
          transport={props.transport}
          onInstalled={props.onConnectionsChanged}
          onOpenExpandedTerminal={props.onProviderLoginTerminalOpen}
        />
      )
    }
    const account = agentAccounts[agent.id]
    const accountError = agentAccountErrors[agent.id]
    if (!account && !accountError) {
      return <ProviderRow key={agent.id} provider={provider} status="Checking account…" live />
    }
    if (!account?.signedIn) {
      return (
        <CliSignInRow
          key={agent.id}
          provider={{
            ...provider,
            ...(accountError ? { problem: accountError } : {}),
          }}
          target={{ provider: 'acp', agent: agent.id }}
          transport={props.transport}
          onSignedIn={() => void refreshAgentAccount(agent.id)}
          onOpenExpandedTerminal={props.onProviderLoginTerminalOpen}
        />
      )
    }
    return (
      <ProviderRow
        key={agent.id}
        provider={provider}
        status="Signed in"
        issue={accountError ? { message: accountError, announce: true } : undefined}
        secondary={{
          label: agentBusy === agent.id ? 'Signing out…' : 'Sign out',
          disabled: agentBusy === agent.id,
          danger: true,
          onClick: () => void signOutAgent(agent.id),
        }}
      />
    )
  }

  const signedIn = (status: ProviderStatus) => {
    const authState = authStates[status.id]
    if (authState) return authState.phase === 'ready' && authState.account.signedIn
    return status.id === props.provider && props.account?.signedIn === true
  }
  const checkingAccount = (status: ProviderStatus) => {
    const authState = authStates[status.id]
    if (authState) return authState.phase === 'loading'
    return !(status.id === props.provider && props.account)
  }
  const renderTuning = (status: ProviderStatus) => {
    if (!providerDefaults) return null
    // A provider that may well be signed in keeps the place of its defaults
    // while the account is checked, so the roster does not jump when it answers.
    const pending = status.installed && status.auth !== 'unauthenticated' && checkingAccount(status)
    if (!pending && !signedIn(status)) return null
    const pin = providerDefaults.pins[status.id]
    const pinnedName = pinnedModelChoice(props.models ?? [], status.id, pin)?.model.displayName
    return (
      <ProviderTuning
        provider={status}
        models={pinnableModels(props.models ?? [], status.id, props.hiddenModels)}
        pinned={pin}
        pinnedName={pinnedName}
        onPinnedChange={(next) => providerDefaults.onPinChange(status.id, next)}
        access={providerApprovalDefault(
          providerDefaults.access[status.id],
          status.capabilities?.autoReview === true,
        )}
        onAccessChange={(mode) => providerDefaults.onAccessChange(status.id, mode)}
        context={context.state}
        contextError={context.errors[status.id]}
        onContextChange={(settings) => context.update(status.id, settings)}
        pending={pending}
      />
    )
  }
  const renderProviderRow = (status: ProviderStatus) => (
    <div className="provider-settings__entry" key={status.id}>
      {renderAccountRow(status)}
      {renderTuning(status)}
    </div>
  )

  return (
    <SettingsPanel
      title="Providers"
      groupClassName="settings__group--plain settings__group--providers"
    >
      {props.providersLoading && props.providerStatuses.length === 0 ? (
        <SkeletonStatus label="Loading providers…">
          {PROVIDER_ROSTER.map((id, index) => (
            <div className="provider-settings__entry" key={id}>
              <ProviderRowSkeleton index={index} />
              {providerDefaults ? <ProviderTuningSkeleton /> : null}
            </div>
          ))}
        </SkeletonStatus>
      ) : (
        PROVIDER_ROSTER.flatMap(byId).map(renderProviderRow)
      )}
      {agents.map(renderAgentRow)}
      <h2 className="settings__group-title settings__group-title--inside">API connections</h2>
      {(props.modelConnections ?? []).map((connection) => (
        <SettingsRow key={connection.id} title={connection.displayName}>
          <div className="provider-settings__actions">
            <StateLabel
              state={connection.credentialConfigured ? 'ready' : 'setup-needed'}
              detail={
                connection.credentialConfigured
                  ? CONNECTION_PRESETS[connection.preset].label
                  : 'Key missing'
              }
            />
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
      {addingConnection ? (
        <div className="provider-form">
          <div className="provider-form__field">
            <span>Provider</span>
            <Menu
              align="left"
              drop="down"
              label={`Provider, ${CONNECTION_PRESETS[connectionPreset].label}`}
              panelLabel="API provider"
              panelClassName="provider-form__menu"
              triggerClassName="provider-form__select"
              trigger={(open) => (
                <>
                  <span className="provider-form__select-value">
                    <ProviderIcon mark={connectionMark(connectionPreset)} size={16} />
                    {CONNECTION_PRESETS[connectionPreset].label}
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
                    icon={
                      <ProviderIcon
                        mark={connectionMark(value as ModelConnectionPreset)}
                        size={16}
                      />
                    }
                    active={value === connectionPreset}
                    onClick={() => {
                      chooseConnectionPreset(value as ModelConnectionPreset)
                      close()
                    }}
                  />
                ))
              }
            </Menu>
          </div>
          <label>
            <span>Name</span>
            <input
              value={connectionName}
              onChange={(event) => setConnectionName(event.target.value)}
            />
          </label>
          <label className="provider-form__wide">
            <span>Base URL</span>
            <input
              value={connectionBaseUrl}
              onChange={(event) => setConnectionBaseUrl(event.target.value)}
              spellCheck={false}
            />
          </label>
          <label>
            <span>Default model</span>
            <input
              value={connectionDefaultModel}
              onChange={(event) => setConnectionDefaultModel(event.target.value)}
              placeholder={CONNECTION_PRESETS[connectionPreset].placeholder}
              spellCheck={false}
            />
          </label>
          <label className="provider-form__wide">
            <span>API key</span>
            <input
              type="password"
              value={connectionApiKey}
              onChange={(event) => setConnectionApiKey(event.target.value)}
              autoComplete="off"
            />
          </label>
          {connectionError ? <p className="provider-form__error">{connectionError}</p> : null}
          <div className="provider-form__actions">
            <button className="ghost" type="button" onClick={() => setAddingConnection(false)}>
              Cancel
            </button>
            <button
              className="btn"
              type="button"
              disabled={
                connectionSaving ||
                !connectionName.trim() ||
                !connectionBaseUrl.trim() ||
                !connectionApiKey.trim()
              }
              onClick={() => void addConnection()}
            >
              {connectionSaving ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </div>
      ) : (
        <button
          className="settings__action"
          type="button"
          onClick={() => setAddingConnection(true)}
        >
          <KeyRound size={15} aria-hidden />
          Connect another plan or API
        </button>
      )}
      <ProviderUpdateCheck transport={props.transport} />
    </SettingsPanel>
  )
}

function ModelSettings(props: {
  transport: Transport
  models: ModelChoice[]
  modelsLoading?: boolean | undefined
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
      ) : props.modelsLoading ? (
        <ModelSourcesSkeleton />
      ) : (
        <div className="model-settings__empty">
          <Boxes size={18} aria-hidden />
          <p>No models are available from your connected providers yet.</p>
        </div>
      )}
    </SettingsPanel>
  )
}

const MODEL_SKELETON_WIDTHS = [132, 176, 108, 152] as const

function ModelSourcesSkeleton() {
  return (
    <SkeletonStatus label="Loading models…" className="model-settings__sources">
      {[4, 3].map((rows, index) => (
        <section className="model-visibility" key={index} aria-hidden>
          <header className="model-visibility__source">
            <h3>
              <span className="source-identity source-identity--regular">
                <span className="source-identity__mark">
                  <Skeleton className="skeleton--icon" width={15} height={15} />
                </span>
                <Skeleton width={index === 0 ? 64 : 92} height={9} />
              </span>
            </h3>
            <div className="model-visibility__bulk-actions">
              <button type="button" disabled>
                All
              </button>
              <button type="button" disabled>
                None
              </button>
            </div>
          </header>
          <div className="model-visibility__models">
            <div>
              {MODEL_SKELETON_WIDTHS.slice(0, rows).map((width, row) => (
                <SettingsRow
                  key={row}
                  className="model-visibility__model"
                  title={
                    <span className="settings-value-skeleton">
                      <Skeleton width={width} height={9} />
                    </span>
                  }
                >
                  <span className="settings__switch-skeleton">
                    <Skeleton width={36} height={22} />
                  </span>
                </SettingsRow>
              ))}
            </div>
          </div>
        </section>
      ))}
    </SkeletonStatus>
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
  const fastTier = getFastServiceTier(selected?.model)
  const selectedSpeed = isFastModeEnabled(selected?.model, manual?.serviceTier)
    ? 'fast'
    : 'standard'
  const loading = state === undefined && !error

  return (
    <section className="background-model-settings" aria-label="Background work">
      <header>
        <h2>Background work</h2>
        <p>
          Used for session titles, commit-message drafts, and other short writing. Automatic uses
          Luna at low on a Codex subscription, Grok 4.6 at low when Grok is connected, or the newest
          cost-oriented model at its lowest effort elsewhere.
        </p>
      </header>
      <div className="settings__group">
        <SettingsRow
          title="Model"
          note={
            loading ? (
              <SettingsValueSkeleton label="Loading background model details…" width={240} />
            ) : state ? (
              automaticNote
            ) : undefined
          }
        >
          {loading ? (
            <SkeletonStatus
              label="Loading background model…"
              className="settings__select settings__select--model"
            >
              <Skeleton className="skeleton--block" width="100%" height={28} />
            </SkeletonStatus>
          ) : !state ? (
            <SettingsMeta>Unavailable</SettingsMeta>
          ) : (
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
                const serviceTier = getNextServiceTierForModel({
                  nextModel: choice.model,
                  currentModel: selected?.model,
                  currentServiceTier: manual?.serviceTier,
                })
                void update({
                  mode: 'manual',
                  target: {
                    provider: choice.source.provider,
                    ...(choice.source.connectionId
                      ? { connectionId: choice.source.connectionId }
                      : {}),
                    ...(choice.source.agent
                      ? {
                          agent: choice.source.agent,
                        }
                      : {}),
                    model: choice.model.id,
                    ...(serviceTier ? { serviceTier } : {}),
                    ...(choice.model.reasoningEfforts[0]
                      ? {
                          effort: choice.model.reasoningEfforts[0],
                        }
                      : {}),
                  },
                })
              }}
            />
          )}
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
        {manual && selected && fastTier ? (
          <SettingsRow title="Speed" note="Choose the speed used for background writing.">
            <AppSelect
              className="settings__select settings__select--effort"
              ariaLabel="Background speed"
              align="right"
              value={selectedSpeed}
              options={[
                { value: 'standard', label: 'Standard' },
                { value: 'fast', label: 'Fast' },
              ]}
              disabled={busy}
              onChange={(speed) => {
                const serviceTier =
                  speed === 'fast' ? fastTier.id : getFastModeOffValue(selected.model)
                void update({ mode: 'manual', target: { ...manual, serviceTier } })
              }}
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

function isBackgroundModelSettingsState(
  value: z.input<typeof BackgroundModelSettingsSchema>,
): value is BackgroundModelSettingsState {
  return BackgroundModelSettingsSchema.safeParse(value).success
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
    const [sourceId, modelId] = z.tuple([z.string(), z.string()]).parse(JSON.parse(value))
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
  const noneVisible = visibleCount === 0

  const setAllVisible = (visible: boolean) => {
    for (const choice of props.choices) {
      const currentlyVisible = !props.hiddenModels.has(choice.key)
      if (currentlyVisible !== visible) {
        props.onModelVisibilityChange(choice.key, visible)
      }
    }
  }

  return (
    <section className="model-visibility" aria-label={props.source}>
      <header className="model-visibility__source">
        {props.choices[0] ? (
          <h3>
            <SourceIdentity presentation={{ label: props.source, mark: props.choices[0].mark }} />
          </h3>
        ) : null}
        <div
          className="model-visibility__bulk-actions"
          role="group"
          aria-label={`${props.source} model visibility`}
        >
          <button
            type="button"
            aria-label={`Show all ${props.source} models in model picker`}
            disabled={allVisible}
            onClick={() => setAllVisible(true)}
          >
            All
          </button>
          <button
            type="button"
            aria-label={`Hide all ${props.source} models from model picker`}
            disabled={noneVisible}
            onClick={() => setAllVisible(false)}
          >
            None
          </button>
        </div>
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
  themeColorScheme: ThemeColorScheme
  onThemePreferenceChange: (theme: ThemePreference) => void
  appearancePreferences: AppearancePreferences
  onAppearancePreferenceChange: (
    mode: ThemeColorScheme,
    updates: Partial<AppearancePreference>,
  ) => void
  showMacOSFontSmoothing: boolean
  macOSFontSmoothing: boolean
  onMacOSFontSmoothingChange: (enabled: boolean) => void
  showMacOSHaptics?: boolean | undefined
}) {
  return (
    <SettingsPanel title="Appearance" groupClassName="settings__group--plain">
      <section className="appearance-theme" aria-labelledby="appearance-theme-heading">
        <h2 className="settings__group-title" id="appearance-theme-heading">
          Theme
        </h2>
        <ThemePicker value={props.themePreference} onChange={props.onThemePreferenceChange} />
      </section>
      <AppearanceCodePreview />
      {(['light', 'dark'] as const).map((mode) => (
        <AppearanceEditor
          key={mode}
          mode={mode}
          preference={props.appearancePreferences[mode]}
          onChange={(updates) => props.onAppearancePreferenceChange(mode, updates)}
        />
      ))}
      {props.showMacOSHaptics || props.showMacOSFontSmoothing ? (
        <section className="appearance-editor" aria-label="Shared appearance controls">
          {props.showMacOSHaptics ? <SidebarHapticsSetting /> : null}
          {props.showMacOSFontSmoothing ? (
            <SettingsRow className="appearance-editor__row" title="Font smoothing">
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
          ) : null}
        </section>
      ) : null}
    </SettingsPanel>
  )
}

function AppearanceEditor(props: {
  mode: ThemeColorScheme
  preference: AppearancePreference
  onChange: (updates: Partial<AppearancePreference>) => void
}) {
  const [installedFontFamilies, setInstalledFontFamilies] = useState(readInstalledFontFamilies)
  const requestInstalledFontFamilies = useCallback(() => {
    void listInstalledFontFamilies().then(setInstalledFontFamilies)
  }, [])
  const fontOptions = useMemo(() => {
    const optionsByLabel = new Map<string, { value: FontPreference; label: string }>()
    for (const family of installedFontFamilies ?? []) {
      const value = fontPreferenceForFamily(family)
      if (!value) continue
      optionsByLabel.set(fontOptionKey(family), { value, label: family })
    }
    for (const option of FONT_OPTIONS) {
      optionsByLabel.set(fontOptionKey(option.label), option)
    }

    const selectedFamily = fontFamilyFromPreference(props.preference.font)
    const options = [...optionsByLabel.values()]
    if (!options.some((option) => option.value === props.preference.font)) {
      const label = selectedFamily ?? legacyFontLabel(props.preference.font)
      if (label) optionsByLabel.set(fontOptionKey(label), { value: props.preference.font, label })
    }

    return [...optionsByLabel.values()].sort(compareFontOptions)
  }, [installedFontFamilies, props.preference.font])
  const selectedGlass = GLASS_OPTIONS.reduce((best, candidate) =>
    Math.abs(candidate.value - props.preference.glass) <
    Math.abs(best.value - props.preference.glass)
      ? candidate
      : best,
  )
  const light = (backdropColorScheme(props.preference.backdrop) ?? props.mode) === 'light'
  const title = props.mode === 'light' ? 'Light mode' : 'Dark mode'

  return (
    <section className="appearance-editor" aria-label={title}>
      <h2 className="appearance-editor__heading">{title}</h2>
      <SettingsRow className="appearance-editor__row" title="Theme">
        <AppSelect
          className="settings__select appearance-control__select"
          ariaLabel={`${title} theme`}
          align="right"
          value="default"
          options={[{ value: 'default', label: 'Default' }]}
          allowReselect
          onChange={() => props.onChange({ accent: 'neutral', backdrop: 'default' })}
        />
      </SettingsRow>
      <SettingsRow className="appearance-editor__row" title="Accent palette">
        <AppearanceColorPicker
          label="Accent palette"
          value={props.preference.accent}
          color={accentColor(props.preference.accent, light)}
          options={ACCENT_OPTIONS.map((option) => ({
            ...option,
            color: accentColor(option.value, light),
          }))}
          onChange={(accent) => props.onChange({ accent })}
        />
      </SettingsRow>
      <SettingsRow className="appearance-editor__row" title="Background">
        <AppearanceColorPicker
          label="Background"
          value={props.preference.backdrop}
          color={backdropColor(props.preference.backdrop, light)}
          options={BACKDROP_OPTIONS.map((option) => ({
            ...option,
            color: backdropColor(option.value, light),
          }))}
          onChange={(backdrop) => props.onChange({ backdrop })}
        />
      </SettingsRow>
      <SettingsRow className="appearance-editor__row" title="Interface font">
        <div className="appearance-control">
          <span className="appearance-control__type" aria-hidden>
            Aa
          </span>
          <AppSelect
            className="settings__select appearance-control__select"
            ariaLabel="Interface font"
            align="right"
            value={props.preference.font}
            options={fontOptions}
            onOpen={requestInstalledFontFamilies}
            loadingMessage={installedFontFamilies === undefined ? 'Loading fonts…' : undefined}
            search={FONT_SEARCH}
            onChange={(font) => props.onChange({ font })}
          />
        </div>
      </SettingsRow>
      <SettingsRow className="appearance-editor__row" title="Sidebar translucency">
        <div className="appearance-control">
          <span
            className="appearance-control__swatch appearance-choice__swatch"
            data-glass-preview={selectedGlass.value}
            aria-hidden
          />
          <AppSelect
            className="settings__select appearance-control__select"
            ariaLabel="Sidebar translucency"
            align="right"
            value={String(selectedGlass.value)}
            options={GLASS_SELECT_OPTIONS}
            onChange={(value) => props.onChange({ glass: Number(value) })}
          />
        </div>
      </SettingsRow>
    </section>
  )
}

function SidebarHapticsSetting() {
  const enabled = useSyncExternalStore(subscribeAppHaptics, readAppHaptics, readAppHaptics)
  return (
    <SettingsRow
      className="appearance-editor__row"
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
  )
}

function AppearanceCodePreview() {
  return (
    <div
      className="appearance-code-preview"
      role="img"
      aria-label="TasteCode thread.start code preview changing approval from ask to auto-review"
    >
      <div className="appearance-code-preview__pane" aria-hidden>
        <span className="appearance-code-preview__line">
          <span className="appearance-code-preview__number">1</span>
          <code>
            <span className="appearance-code-preview__keyword">await</span> transport.request(
          </code>
        </span>
        <span className="appearance-code-preview__line">
          <span className="appearance-code-preview__number">2</span>
          <code>
            {'  '}
            <span className="appearance-code-preview__string">&quot;thread.start&quot;</span>, {'{'}
          </code>
        </span>
        <span className="appearance-code-preview__line">
          <span className="appearance-code-preview__number">3</span>
          <code>
            {'    '}provider:{' '}
            <span className="appearance-code-preview__string">&quot;codex&quot;</span>,
          </code>
        </span>
        <span className="appearance-code-preview__line">
          <span className="appearance-code-preview__number">4</span>
          <code>{'    '}workspacePath: projectPath,</code>
        </span>
        <span className="appearance-code-preview__line" data-change="removed">
          <span className="appearance-code-preview__number">5</span>
          <code>
            {'    '}approval:{' '}
            <span className="appearance-code-preview__string">&quot;ask&quot;</span>,
          </code>
        </span>
        <span className="appearance-code-preview__line">
          <span className="appearance-code-preview__number">6</span>
          <code>{'  }'},</code>
        </span>
        <span className="appearance-code-preview__line">
          <span className="appearance-code-preview__number">7</span>
          <code>);</code>
        </span>
      </div>
      <div className="appearance-code-preview__pane" aria-hidden>
        <span className="appearance-code-preview__line">
          <span className="appearance-code-preview__number">1</span>
          <code>
            <span className="appearance-code-preview__keyword">await</span> transport.request(
          </code>
        </span>
        <span className="appearance-code-preview__line">
          <span className="appearance-code-preview__number">2</span>
          <code>
            {'  '}
            <span className="appearance-code-preview__string">&quot;thread.start&quot;</span>, {'{'}
          </code>
        </span>
        <span className="appearance-code-preview__line">
          <span className="appearance-code-preview__number">3</span>
          <code>
            {'    '}provider:{' '}
            <span className="appearance-code-preview__string">&quot;codex&quot;</span>,
          </code>
        </span>
        <span className="appearance-code-preview__line">
          <span className="appearance-code-preview__number">4</span>
          <code>{'    '}workspacePath: projectPath,</code>
        </span>
        <span className="appearance-code-preview__line" data-change="added">
          <span className="appearance-code-preview__number">5</span>
          <code>
            {'    '}approval:{' '}
            <span className="appearance-code-preview__string">&quot;auto-review&quot;</span>,
          </code>
        </span>
        <span className="appearance-code-preview__line">
          <span className="appearance-code-preview__number">6</span>
          <code>{'  }'},</code>
        </span>
        <span className="appearance-code-preview__line">
          <span className="appearance-code-preview__number">7</span>
          <code>);</code>
        </span>
      </div>
    </div>
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

function DataSettings(props: {
  projectCount: number
  projectsLoading?: boolean | undefined
  onReset: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [diagnosticsEnabled, setDiagnosticsEnabled] = useState<boolean>()
  const [diagnosticsError, setDiagnosticsError] = useState<string>()
  const projectLabel = `${props.projectCount} ${props.projectCount === 1 ? 'project' : 'projects'} on this machine`

  useEffect(() => {
    let cancelled = false
    void localDiagnosticsEnabled()
      .then((enabled) => {
        if (!cancelled) setDiagnosticsEnabled(enabled)
      })
      .catch((cause) => {
        if (!cancelled) {
          setDiagnosticsError(cause instanceof Error ? cause.message : String(cause))
        }
      })
    return () => {
      cancelled = true
    }
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
          note="Off by default. Stores redacted app error text only on this device. Nothing is uploaded. New entries stop immediately when turned off."
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
          {diagnosticsEnabled === undefined ? (
            diagnosticsError ? null : (
              <SkeletonStatus
                label="Loading local diagnostics…"
                className="settings__switch-skeleton"
              >
                <Skeleton width={36} height={22} />
              </SkeletonStatus>
            )
          ) : (
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
          )}
        </SettingsRow>
      ) : null}
      <SettingsRow
        title={
          props.projectsLoading ? (
            <SettingsValueSkeleton label="Loading project count…" width={176} />
          ) : (
            projectLabel
          )
        }
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
    const current =
      document.activeElement instanceof HTMLElement ? focusable.indexOf(document.activeElement) : -1
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

export function DebugSettings(props: { transport: Transport }) {
  return (
    <SettingsPanel title="Debug">
      <UsageHistoryReset transport={props.transport} />
    </SettingsPanel>
  )
}

function UsageHistoryReset(props: { transport: Transport }) {
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
  const nativePreparing = nativeUpdate?.status === 'preparing'
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
        : nativePreparing
          ? {
              state: 'checking' as const,
              detail: `Preparing ${nativeUpdate.version ?? 'update'}`,
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
          {nativeUpdate === undefined ? (
            <SettingsValueSkeleton label="Loading app version…" width={132} />
          ) : (
            `${isDesktop ? 'Desktop' : 'Browser'} · ${nativeUpdate.status !== 'unsupported' ? nativeUpdate.currentVersion : 'pre-release'}${result?.localCommit ? ` · ${short(result.localCommit)}` : ''}`
          )}
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
        {!checking && nativeUpdate === undefined ? (
          <SettingsMeta>
            <SettingsValueSkeleton label="Loading update status…" width={112} />
          </SettingsMeta>
        ) : null}
        {!checking && !nativeChecking && nativeStatus ? (
          <StateLabel {...nativeStatus} live />
        ) : null}
        {!checking && !nativeChecking && !nativeStatus && updateStatus ? (
          <StateLabel {...updateStatus} live />
        ) : null}
        <button
          className="settings__action"
          type="button"
          disabled={checking || nativeChecking || nativeDownloading || nativePreparing}
          onClick={() => void (nativeReady ? installAppUpdate() : check())}
        >
          <RotateCcw size={13} aria-hidden />
          {nativeReady
            ? 'Restart to update'
            : nativeDownloading
              ? 'Downloading…'
              : nativePreparing
                ? 'Preparing…'
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
 * the row narrates progress from the live output. App-level callers hand the
 * live terminal to the expanded workspace card; isolated callers keep the
 * attachable details fallback in this row.
 */
function InstallableRow(props: {
  provider: ProviderStatus
  target: InstallTarget
  transport: Transport
  onInstalled: () => void
  onOpenExpandedTerminal?: ((target: ProviderLoginTerminalTarget) => void) | undefined
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
    void beginInstall(props.transport, props.target)
      .then(() => {
        props.onOpenExpandedTerminal?.({
          provider: props.provider.id,
          displayName: props.provider.displayName,
          installKey: key,
          operation: 'install',
        })
      })
      .catch((cause: unknown) =>
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
        link="none"
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
 * launches that CLI in a server-side pty. App-level callers hand the attached
 * terminal to the expanded workspace pane for every provider; isolated callers
 * keep the guided card and attachable details here. A clean exit refreshes the
 * account, while a dirty exit keeps the log available for a retry.
 */
function CliSignInRow(props: {
  provider: ProviderStatus
  target: InstallTarget
  transport: Transport
  onSignedIn: () => void
  onOpenExpandedTerminal?: ((target: ProviderLoginTerminalTarget) => void) | undefined
}) {
  const key = loginKey(props.target)
  const detailsId = useId()
  const login = useSyncExternalStore(subscribeInstalls, () => installState(key))
  // Keep failed output behind Details; the status carries the error.
  const [showTerminal, setShowTerminal] = useState(false)
  const [startError, setStartError] = useState<string>()
  const [copied, setCopied] = useState(false)
  const [starting, setStarting] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const { onSignedIn } = props

  // Latched like InstallableRow: onSignedIn may get a new identity from any
  // parent render, and firing more than once per success is the seed of the
  // refresh loop fixed there.
  const notifiedLogin = useRef(false)
  const confirmedEmail = signedInEmail(login?.log ?? '')
  useEffect(() => {
    if (!confirmedEmail) return
    try {
      localStorage.setItem(providerEmailKey(props.provider.id), confirmedEmail)
    } catch {
      // Sign-in still completes when storage is full or blocked.
    }
  }, [confirmedEmail, props.provider.id])

  useEffect(() => {
    if (login?.phase === 'succeeded') {
      if (!notifiedLogin.current) {
        notifiedLogin.current = true
        if (!props.onOpenExpandedTerminal) clearInstall(key)
        onSignedIn()
      }
    } else {
      notifiedLogin.current = false
    }
  }, [login?.phase, key, onSignedIn, props.onOpenExpandedTerminal])

  useEffect(() => {
    if (login?.phase && login.phase !== 'running') setShowTerminal(false)
  }, [login?.phase])

  const start = () => {
    setStarting(true)
    setStartError(undefined)
    setShowTerminal(false)
    setCopied(false)
    // The expanded provider CLI opens its own browser. Do not open the URL it
    // prints as well, or one Sign in click creates two browser tabs.
    void beginLogin(
      props.transport,
      props.target,
      props.onOpenExpandedTerminal && props.provider.setup?.loginOpensBrowser !== false
        ? () => undefined
        : undefined,
    )
      .then(() => {
        if (installState(key)?.phase !== 'running' || installState(key)?.canceling) return
        props.onOpenExpandedTerminal?.({
          provider: props.provider.id,
          displayName: props.provider.displayName,
          installKey: key,
        })
      })
      .catch((cause: unknown) =>
        setStartError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setStarting(false))
  }

  const cancel = () => {
    setCanceling(true)
    setStartError(undefined)
    void cancelInstall(props.transport, key)
      .catch((cause: unknown) =>
        setStartError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setCanceling(false))
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
  const busy = running || starting
  const stopping = canceling || login?.canceling
  const status = stopping
    ? 'Canceling sign-in…'
    : busy
      ? 'Signing in…'
      : issue?.announce
        ? 'Sign-in failed'
        : login?.phase === 'canceled'
          ? 'Sign-in canceled'
          : 'Not signed in'
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
        live={busy}
        issue={issue}
        primary={{
          label: stopping
            ? 'Canceling…'
            : busy
              ? 'Cancel sign-in'
              : issue?.announce
                ? 'Retry sign-in'
                : 'Sign in',
          disabled: stopping,
          onClick: busy ? cancel : start,
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
    <Suspense
      fallback={
        <SkeletonStatus label="Opening terminal…" className="install-terminal">
          <SkeletonCode lines={9} />
        </SkeletonStatus>
      }
    >
      <InstallTerminal transport={props.transport} installKey={props.installKey} />
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
  const [savedEmail] = useState(() => {
    try {
      return localStorage.getItem(providerEmailKey(props.provider))
    } catch {
      return null
    }
  })
  const email = props.account.email ?? savedEmail

  return (
    <span className="settings__account">
      {email ? <AccountEmail email={email} /> : 'Signed in'}
      {props.account.plan ? (
        <span className="settings__account-plan"> · {props.account.plan}</span>
      ) : null}
    </span>
  )
}

/** Preview on hover or focus, then let a click keep the address visible. */
function AccountEmail(props: { email: string }) {
  const [pinned, setPinned] = useState(false)
  const [previewed, setPreviewed] = useState(false)
  const revealed = pinned || previewed

  const togglePinned = () => {
    setPreviewed(false)
    setPinned((current) => !current)
  }

  return (
    <span className="settings__email" data-revealed={revealed} data-pinned={pinned}>
      <button
        className="settings__email-toggle"
        type="button"
        aria-label={pinned ? 'Hide account email' : 'Show account email'}
        aria-pressed={pinned}
        title={pinned ? 'Click to hide email' : 'Hover to preview or click to keep visible'}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'touch') setPreviewed(true)
        }}
        onPointerLeave={() => setPreviewed(false)}
        onFocus={() => setPreviewed(true)}
        onBlur={() => setPreviewed(false)}
        onClick={togglePinned}
      >
        <IconMorph active={revealed ? 1 : 0}>
          <Eye className="settings__email-eye--show" size={15} aria-hidden />
          <EyeOff className="settings__email-eye--hide" size={15} aria-hidden />
        </IconMorph>
      </button>
      <span className="settings__email-clip">
        <span className="settings__email-value">{props.email}</span>
      </span>
    </span>
  )
}

function SettingsValueSkeleton(props: { label: string; width: number }) {
  return (
    <span className="settings-value-skeleton skeleton-group" role="status" aria-busy="true">
      <span className="visually-hidden">{props.label}</span>
      <Skeleton width={props.width} height={9} />
    </span>
  )
}

function SettingsRow(props: {
  title: ReactNode
  note?: ReactNode
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
