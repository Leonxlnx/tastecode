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
import { IconMorph } from './IconMorph.js'
import { BackgroundModelSettingsSchema } from '@harness/contracts'
import '../styles/settings.css'
import type {
  Account,
  BackgroundModelSettings as BackgroundModelSettingsState,
  BackgroundModelSource,
  BackgroundModelTarget,
  DataOf,
  ModelConnection,
  ProviderId,
  ProviderStatus,
  ResultOf,
  SidebarSettings,
} from '@harness/contracts'
import { z } from 'zod'
import {
  IconArrowLeft as ArrowLeft,
  IconUserCircle as CircleUserRound,
  IconBlocks as Blocks,
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
import { isCustomModelChoice, type ModelChoice } from '../model-catalog.js'
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
  type ProviderLoginTerminalTarget,
} from '../provider-install.js'
import type { Transport } from '../transport.js'
import {
  fontFamilyFromPreference,
  fontPreferenceForFamily,
  type AccentPreference,
  type BackdropPreference,
  type FontPreference,
  type ThemePreference,
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
import {
  readTerminalPlacement,
  subscribeTerminalPlacement,
  writeTerminalPlacement,
  type TerminalPlacement,
} from '../terminal-placement.js'
import { AppSelect } from './AppSelect.js'
import { McpSettings } from './McpSettings.js'
import { groupModelsBySource } from './model-selector-utils.js'
import { SkillsSettings } from './SkillsSettings.js'
import { ProviderRow, type ProviderAction } from './ProviderRow.js'
import { ProfileSettings } from './ProfileSettings.js'
import type { ProfileIdentityPreferences } from '../profile-preferences.js'
import { SourceIdentity } from './SourceIdentity.js'
import { SettingsMeta, StateLabel } from './SettingsStatus.js'
import {
  DEFAULT_KEYBINDINGS,
  type KeybindingId,
  type Keybindings,
  type Shortcut,
} from '../shortcuts.js'
import { KeybindSettings } from './KeybindSettings.js'
import { ProviderUpdateCheck } from './ProviderUpdates.js'

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
  | 'keybinds'
  | 'data'
  | 'about'

const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'codex', label: 'Codex' },
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

const TERMINAL_PLACEMENT_OPTIONS = [
  { value: 'bottom', label: 'Bottom panel' },
  { value: 'workspace', label: 'Right sidebar' },
] as const satisfies ReadonlyArray<{ value: TerminalPlacement; label: string }>

const MCP_PROVIDER_OPTIONS = [
  { provider: 'codex', providerName: 'Codex' },
  { provider: 'claude-code', providerName: 'Claude Code' },
  { provider: 'grok', providerName: 'Grok' },
] satisfies Array<{ provider: ProviderId; providerName: string }>

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
  macOS?: boolean | undefined
  keybindings?: Keybindings | undefined
  onKeybindingChange?: ((action: KeybindingId, shortcut: Shortcut | null) => void) | undefined
  onKeybindingsReset?: (() => void) | undefined
  showMacOSHaptics?: boolean | undefined
  onAccountChange: (provider: ProviderId, account: Account) => void
  authRefreshRevision?: number | undefined
  initialSection?: SettingsSection | undefined
  onReset: () => void
  onClose: () => void
  onProviderLoginTerminalOpen?: ((target: ProviderLoginTerminalTarget) => void) | undefined
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
          {section === 'keybinds' ? (
            <KeybindSettings
              keybindings={props.keybindings ?? DEFAULT_KEYBINDINGS}
              macOS={props.macOS ?? false}
              onChange={props.onKeybindingChange ?? noopKeybindingChange}
              onReset={props.onKeybindingsReset ?? noop}
            />
          ) : null}
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
      <SettingsRow
        title="Default terminal"
        note="Used by the Toggle terminal shortcut and command."
      >
        <TerminalPlacementSelect />
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

type ProviderMap<T> = Partial<Record<ProviderId, T>>

export function ProviderSettings(props: {
  provider: ProviderId
  account: Account | undefined
  providerStatuses: ProviderStatus[]
  projectPath?: string | undefined
  transport: Transport
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
  }, [props.transport, props.authRefreshRevision, authProviderKey, completeLogin, refreshAccount])

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
  const renderProviderRow = (status: ProviderStatus) => (
    <div className="provider-settings__entry" key={status.id}>
      {renderAccountRow(status)}
    </div>
  )

  return (
    <SettingsPanel title="Providers" groupClassName="settings__group--providers">
      <header className="provider-settings__header">
        <h2>Accounts</h2>
      </header>
      {byId('codex').map(renderProviderRow)}
      {byId('claude-code').map(renderProviderRow)}
      {byId('grok').map(renderProviderRow)}
      {direct
        .filter((status) => !['codex', 'claude-code', 'grok'].includes(status.id))
        .map(renderProviderRow)}
      <ProviderUpdateCheck transport={props.transport} />
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
          Luna at low on a Codex subscription, Grok 4.6 at low when Grok is connected, or the newest
          cost-oriented model at its lowest effort elsewhere.
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
                    ? {
                        connectionId: choice.source.connectionId,
                      }
                    : {}),
                  ...(choice.source.agent
                    ? {
                        agent: choice.source.agent,
                      }
                    : {}),
                  model: choice.model.id,
                  ...(choice.model.reasoningEfforts[0]
                    ? {
                        effort: choice.model.reasoningEfforts[0],
                      }
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

    const selectedFamily = fontFamilyFromPreference(props.fontPreference)
    const options = [...optionsByLabel.values()]
    if (!options.some((option) => option.value === props.fontPreference)) {
      const label = selectedFamily ?? legacyFontLabel(props.fontPreference)
      if (label) optionsByLabel.set(fontOptionKey(label), { value: props.fontPreference, label })
    }

    return [...optionsByLabel.values()].sort(compareFontOptions)
  }, [installedFontFamilies, props.fontPreference])
  const selectedGlass = GLASS_OPTIONS.reduce((best, candidate) =>
    Math.abs(candidate.value - props.sidebarGlass) < Math.abs(best.value - props.sidebarGlass)
      ? candidate
      : best,
  )
  const selectedThemeLabel =
    THEME_OPTIONS.find((option) => option.value === props.themePreference)?.label ?? 'Custom'

  return (
    <SettingsPanel title="Appearance" groupClassName="settings__group--plain">
      <section className="appearance-theme" aria-labelledby="appearance-theme-heading">
        <h2 className="settings__group-title" id="appearance-theme-heading">
          Theme
        </h2>
        <ThemePicker value={props.themePreference} onChange={props.onThemePreferenceChange} />
      </section>
      <AppearanceCodePreview />
      <section className="appearance-editor" aria-labelledby="appearance-details-heading">
        <header className="appearance-editor__header">
          <h2 id="appearance-details-heading">Theme details</h2>
          <span className="appearance-editor__scope">{selectedThemeLabel}</span>
        </header>
        <SettingsRow className="appearance-editor__row" title="Accent palette">
          <div className="appearance-control">
            <span
              className="appearance-control__swatch appearance-choice__swatch"
              data-accent-preview={props.accentPreference}
              aria-hidden
            />
            <AppSelect
              className="settings__select appearance-control__select"
              ariaLabel="Accent palette"
              align="right"
              value={props.accentPreference}
              options={ACCENT_OPTIONS}
              onChange={props.onAccentPreferenceChange}
            />
          </div>
        </SettingsRow>
        <SettingsRow className="appearance-editor__row" title="Background">
          <div className="appearance-control">
            <span
              className="appearance-control__swatch appearance-choice__swatch"
              data-backdrop-preview={props.backdropPreference}
              aria-hidden
            />
            <AppSelect
              className="settings__select appearance-control__select"
              ariaLabel="Background"
              align="right"
              value={props.backdropPreference}
              options={BACKDROP_OPTIONS}
              onChange={props.onBackdropPreferenceChange}
            />
          </div>
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
              value={props.fontPreference}
              options={fontOptions}
              onOpen={requestInstalledFontFamilies}
              loadingMessage={installedFontFamilies === undefined ? 'Loading fonts…' : undefined}
              search={FONT_SEARCH}
              onChange={props.onFontPreferenceChange}
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
              onChange={(value) => props.onSidebarGlassChange(Number(value))}
            />
          </div>
        </SettingsRow>
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
    </SettingsPanel>
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

function TerminalPlacementSelect() {
  const placement = useSyncExternalStore(
    subscribeTerminalPlacement,
    readTerminalPlacement,
    readTerminalPlacement,
  )
  return (
    <AppSelect
      className="settings__select"
      ariaLabel="Default terminal location"
      align="right"
      value={placement}
      options={TERMINAL_PLACEMENT_OPTIONS}
      onChange={writeTerminalPlacement}
    />
  )
}

function AppearanceCodePreview() {
  return (
    <div
      className="appearance-code-preview"
      role="img"
      aria-label="Code sample preview using the current appearance settings"
    >
      <div className="appearance-code-preview__pane" aria-hidden>
        <span className="appearance-code-preview__line">
          <span className="appearance-code-preview__number">1</span>
          <code>
            <span className="appearance-code-preview__keyword">const</span> themePreview = {'{'}
          </code>
        </span>
        <span className="appearance-code-preview__line" data-change="removed">
          <span className="appearance-code-preview__number">2</span>
          <code>
            surface: <span className="appearance-code-preview__string">&quot;sidebar&quot;</span>,
          </code>
        </span>
        <span className="appearance-code-preview__line" data-change="removed">
          <span className="appearance-code-preview__number">3</span>
          <code>
            accent: <span className="appearance-code-preview__string">&quot;neutral&quot;</span>,
          </code>
        </span>
        <span className="appearance-code-preview__line" data-change="removed">
          <span className="appearance-code-preview__number">4</span>
          <code>
            contrast: <span className="appearance-code-preview__number-value">42</span>,
          </code>
        </span>
        <span className="appearance-code-preview__line">
          <span className="appearance-code-preview__number">5</span>
          <code>{'}'};</code>
        </span>
      </div>
      <div className="appearance-code-preview__pane" aria-hidden>
        <span className="appearance-code-preview__line">
          <span className="appearance-code-preview__number">1</span>
          <code>
            <span className="appearance-code-preview__keyword">const</span> themePreview = {'{'}
          </code>
        </span>
        <span className="appearance-code-preview__line" data-change="added">
          <span className="appearance-code-preview__number">2</span>
          <code>
            surface:{' '}
            <span className="appearance-code-preview__string">&quot;sidebar-raised&quot;</span>,
          </code>
        </span>
        <span className="appearance-code-preview__line" data-change="added">
          <span className="appearance-code-preview__number">3</span>
          <code>
            accent: <span className="appearance-code-preview__string">&quot;focused&quot;</span>,
          </code>
        </span>
        <span className="appearance-code-preview__line" data-change="added">
          <span className="appearance-code-preview__number">4</span>
          <code>
            contrast: <span className="appearance-code-preview__number-value">68</span>,
          </code>
        </span>
        <span className="appearance-code-preview__line">
          <span className="appearance-code-preview__number">5</span>
          <code>{'}'};</code>
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
        if (!props.onOpenExpandedTerminal) clearInstall(key)
        onSignedIn()
      }
    } else {
      notifiedLogin.current = false
    }
  }, [login?.phase, key, onSignedIn, props.onOpenExpandedTerminal])

  useEffect(() => {
    if (login?.phase === 'failed') setShowTerminal(true)
  }, [login?.phase])

  const start = () => {
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
        props.onOpenExpandedTerminal?.({
          provider: props.provider.id,
          displayName: props.provider.displayName,
          installKey: key,
        })
      })
      .catch((cause: unknown) =>
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
  const [savedEmail] = useState(() => localStorage.getItem(providerEmailKey(props.provider)))
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
