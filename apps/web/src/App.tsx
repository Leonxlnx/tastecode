import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { CSSProperties, TransitionEvent as ReactTransitionEvent } from 'react'
import { IconLoader2 as LoaderCircle } from '@tabler/icons-react'
import type {
  Account,
  ApprovalDecision,
  ApprovalMode,
  DomainEvent,
  ModelConnection,
  ProviderId,
  ProviderStatus,
  PullRequestListItem,
  QueuedTurn,
  ResultOf,
  SidebarSettings,
} from '@harness/contracts'
import {
  isDesktop,
  isMacOS,
  onNativeMenuAction,
  pickFolder,
  reportStartupMilestone,
  setDesktopTheme,
  syncNativeMenuShortcuts,
} from './bridge.js'
import {
  createDefaultKeybindings,
  KEYBINDING_DEFINITIONS,
  matchesShortcut,
  readKeybindings,
  shortcutLabel,
  writeKeybindings,
  type KeybindingId,
  type Shortcut,
} from './shortcuts.js'
import { readTerminalPlacement, subscribeTerminalPlacement } from './terminal-placement.js'
import { ProviderUpdateNotice } from './ui/ProviderUpdates.js'
import { IndeterminateRequestError, Transport } from './transport.js'
import { OptimisticMutations } from './optimistic-mutations.js'
import {
  appendUserMessage,
  beginOptimisticTurn,
  createOptimisticMessageId,
  emptyThread,
  removeOptimisticMessage,
  type ThreadState,
} from './thread-store.js'
import {
  ThreadController,
  removePendingSubmission,
  type PendingSubmission,
  type RecoverableDraft,
} from './thread-controller.js'

import {
  hasWorkspaceStartForPath,
  indexQueueItemIdsForChecks,
  indexWorkspaceSessions,
  ThreadOwnedMap,
  workspaceProjectActivity,
} from './workspace-idle.js'
import { createPaletteChatSearch, createPaletteChatSearchCache } from './palette-chat-search.js'
import { createProjectChoiceProjector } from './project-choices.js'
import {
  findSession,
  markSessionRead,
  promoteSession,
  reconcileProjectList,
  removeSession,
  updateSession,
  updateSessions,
} from './project-store.js'
import {
  applyProjectOrder,
  parseStoredProjectOrder,
  parseStoredSessionOrder,
} from './sidebar-order.js'
import { createSessionOrderSerializer } from './session-order-serializer.js'
import type { CommandScope, PaletteCommand } from './ui/CommandPalette.js'
import { Composer, type SendAvailability, type WorkspaceInfo } from './ui/Composer.js'
import {
  getFastModeOffValue,
  getFastServiceTier,
  getNextServiceTierForModel,
} from './ui/model-selector-utils.js'
import type { Checkpoint } from './ui/RollbackDialog.js'
import { SessionSearchHost, type SessionSearchHandle } from './ui/SessionSearchHost.js'
import type { SettingsSection } from './ui/Settings.js'
import { Sidebar, type Project } from './ui/Sidebar.js'
import { PanelToggles, StageHeader } from './ui/StageHeader.js'
import { NoticePresence } from './ui/NoticePresence.js'
import { LazyThread } from './ui/LazyThread.js'
import { TitleBar } from './ui/TitleBar.js'
import { ZoomHud } from './ui/ZoomHud.js'
import { useDeferredArchiveQueue } from './ui/useDeferredArchiveQueue.js'
import { serverBaseUrl } from './server-url.js'
import { addDesignBriefing } from './design-agent/briefing.js'
import { sourceSupportsAttachments } from './attachment-capability.js'
import { canCaptureVoice, type VoiceRecording } from './voice-capability.js'
import { UsageLimitsController } from './usage-limits-state.js'
import {
  agentMark,
  choicesFor,
  customModelChoice,
  customModelKey,
  isCustomModelChoice,
  modelChoiceKey,
  modelVisibleByDefault,
  providerDisplayName,
  providerMark,
  resolveReasoningEffort,
  sourceKey,
  type ModelChoice,
} from './model-catalog.js'
import {
  freshModelCatalogChoices,
  parseModelCatalogCache,
  serializeModelCatalogCache,
} from './model-catalog-cache.js'
import { parseSideChatCommand } from './side-chat-command.js'
import {
  composerDraftKey,
  isEmptyComposerDraft,
  NEW_CHAT_DRAFT_KEY,
  type ComposerDraft,
} from './composer-drafts.js'
import type { ComposerResource } from './ui/ComposerResourcePicker.js'
import {
  clearInstall,
  installState,
  subscribeInstalls,
  type ProviderLoginTerminalTarget,
} from './provider-install.js'
import type {
  SideChatParentStatus,
  SideChatPromptRequest,
  SideChatStartOptions,
} from './ui/workspace/WorkspaceSideChat.js'
import type { BrowserNavigationRequest } from './ui/workspace/WorkspaceBrowser.js'
import type { WorkspaceTool } from './ui/workspace/WorkspacePanel.js'
import {
  readProfileIdentityPreferences,
  writeProfileIdentityPreferences,
  type ProfileIdentityPreferences,
} from './profile-preferences.js'
import {
  ACCENT_KEY,
  applyAccentPreference,
  applyBackdropPreference,
  applyFontPreference,
  applyGlassPreference,
  applyTheme,
  BACKDROP_KEY,
  colorSchemeForTheme,
  DARK_THEME_QUERY,
  FONT_KEY,
  GLASS_KEY,
  readAccentPreference,
  readBackdropPreference,
  readFontPreference,
  readGlassPreference,
  readSystemTheme,
  readThemePreference,
  THEME_KEY,
  type AccentPreference,
  type BackdropPreference,
  type Theme,
  type ThemePreference,
  type FontPreference,
} from './theme.js'

const SERVER_BASE_URL = serverBaseUrl(import.meta.env.VITE_HARNESS_SERVER_URL)
const SETUP_KEY = 'harness.provider'
const ONBOARDING_KEY = 'harness.onboarding.v1'
const PROVIDER_IDS = [
  'codex',
  'claude-code',
  'grok',
  'cursor',
  'opencode',
  'antigravity',
  'pi',
  'acp',
  'api',
] as const satisfies readonly ProviderId[]
const PROVIDER_ID_SET = new Set<ProviderId>(PROVIDER_IDS)
const PUBLIC_BETA_PROVIDER_IDS = new Set<ProviderId>(['codex', 'claude-code', 'grok'])
/** Engines a custom model can be attached to — ACP agents and API
 *  connections carry their own roster concepts and stay out of this list. */
const DIRECT_PROVIDER_IDS = PROVIDER_IDS.filter((id) => id !== 'acp' && id !== 'api' && id !== 'pi')
const DIRECT_PROVIDER_ID_SET = new Set<ProviderId>(DIRECT_PROVIDER_IDS)
/** Which named agent or custom harness source was chosen. */
const AGENT_KEY = 'harness.acpAgent'
const AGENT_NAME_KEY = 'harness.acpAgentName'
const PROJECTS_KEY = 'harness.projects'
const PROJECT_ORDER_KEY = 'harness.projectOrder'
const SESSION_ORDER_KEY = 'harness.sessionOrder'
const MODEL_KEY = 'harness.model'
const MODEL_CATALOG_KEY = 'harness.modelCatalog.v1'
const CUSTOM_MODELS_KEY = 'harness.customModels.v1'
/** Last model/effort/tier used per source, so returning to a provider
 *  restores the exact working setup instead of a best-guess translation. */
const MODEL_BY_SOURCE_KEY = 'harness.modelBySource'
const EMPTY_PALETTE_COMMANDS: PaletteCommand[] = []
const HIDDEN_MODELS_KEY = 'harness.hiddenModels'
const MODEL_VISIBILITY_VERSION_KEY = 'harness.modelVisibilityVersion'
const MODEL_VISIBILITY_VERSION = '3'
const PALETTE_CHAT_SEARCH_CACHE = createPaletteChatSearchCache()
const EFFORT_KEY = 'harness.effort'
const SERVICE_TIER_KEY = 'harness.serviceTier'
const APPROVAL_KEY = 'harness.approval'
const APPROVAL_BY_PROVIDER_KEY = 'harness.approvalByProvider'
const MACOS_FONT_SMOOTHING_KEY = 'harness.macosFontSmoothing'
const TERMINAL_HEIGHT_KEY = 'harness.terminal.height'
const BOTTOM_TERMINAL_MOTION_MS = 260
const RAIL_WIDTH_KEY = 'harness.rail.width'
const DEFAULT_RAIL_WIDTH = 256
const WORKSPACE_PANEL_WIDTH_KEY = 'harness.workspacePanel.width'
const NOTICE_AUTO_DISMISS_MS = 5_000
const DEFAULT_SIDEBAR_SETTINGS: SidebarSettings = { mode: 'classic', autoSettleDays: 3 }
type BottomTerminalPhase = 'closed' | 'opening' | 'open' | 'closing'
type TerminalPaneModule = typeof import('./ui/TerminalPane.js')
type TerminalPaneComponent = TerminalPaneModule['TerminalPane']
type LazyTerminalPaneModule = { default: TerminalPaneComponent }
let terminalPanePromise: Promise<LazyTerminalPaneModule> | undefined
let resolvedTerminalPane: TerminalPaneComponent | undefined
const loadTerminalPane = (): Promise<LazyTerminalPaneModule> =>
  (terminalPanePromise ??= import('./ui/TerminalPane.js').then((module) => {
    resolvedTerminalPane = module.TerminalPane
    return { default: module.TerminalPane }
  }))
const TerminalPane = lazy(loadTerminalPane)
const PullRequestsView = lazy(() =>
  import('./ui/pull-requests/PullRequestsView.js').then((module) => ({
    default: module.PullRequestsView,
  })),
)
const ArchiveToast = lazy(() =>
  import('./ui/ArchiveToast.js').then((module) => ({ default: module.ArchiveToast })),
)
type WorkspacePanelModule = typeof import('./ui/workspace/WorkspacePanel.js')
type WorkspacePanelComponent = WorkspacePanelModule['WorkspacePanel']
type LazyWorkspacePanelModule = { default: WorkspacePanelComponent }
let workspacePanelPromise: Promise<LazyWorkspacePanelModule> | undefined
let resolvedWorkspacePanel: WorkspacePanelComponent | undefined
const loadWorkspacePanel = (): Promise<LazyWorkspacePanelModule> =>
  (workspacePanelPromise ??= import('./ui/workspace/WorkspacePanel.js').then((module) => {
    resolvedWorkspacePanel = module.WorkspacePanel
    return { default: module.WorkspacePanel }
  }))
const WorkspacePanel = lazy(loadWorkspacePanel)
const Settings = lazy(() =>
  import('./ui/Settings.js').then((module) => ({ default: module.Settings })),
)
const CommandPalette = lazy(() =>
  import('./ui/CommandPalette.js').then((module) => ({ default: module.CommandPalette })),
)
const CheckoutDiscardDialog = lazy(() =>
  import('./ui/CheckoutDiscardDialog.js').then((module) => ({
    default: module.CheckoutDiscardDialog,
  })),
)
const RollbackDialog = lazy(() =>
  import('./ui/RollbackDialog.js').then((module) => ({ default: module.RollbackDialog })),
)
const WelcomeDialog = lazy(() =>
  import('./ui/WelcomeDialog.js').then((module) => ({ default: module.WelcomeDialog })),
)

/**
 * Projects and sessions used to live here. The server owns them now, so this
 * only exists to hand what it finds over once and then get out of the way —
 * dropping it would silently lose the projects of anyone upgrading.
 */
function takeLegacyProjects(): Array<{ path: string; name?: string }> {
  try {
    const raw = readSetting(PROJECTS_KEY)
    if (!raw) return []
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    const projects: Array<{ path: string; name?: string }> = []
    for (const entry of value) {
      if (
        !isRecord(entry) ||
        typeof entry['path'] !== 'string' ||
        (entry['name'] !== undefined && typeof entry['name'] !== 'string')
      ) {
        return []
      }
      projects.push({
        path: entry['path'],
        ...(entry['name'] ? { name: entry['name'] } : {}),
      })
    }
    return projects
  } catch {
    return []
  }
}

type CustomModel = {
  provider: ProviderId
  modelId: string
  displayName: string
}

type CatalogAvailability = 'loading' | 'ready' | 'failed'
type AccountCheck = { provider: ProviderId; state: CatalogAvailability; account?: Account }

type WorkspaceIdleProbe = {
  inFlight: Promise<void> | undefined
  pendingPath: string | undefined
  idlePath: string | undefined
  blockedPath: string | undefined
  pendingStarts: Map<string, { path: string; tokens: number[] }>
  submissionStarts: ThreadOwnedMap<{ threadId: string; token: number }>
  queuedStarts: ThreadOwnedMap<{ threadId: string; token: number }>
  claimedStarts: Set<string>
  queueActions: ThreadOwnedMap<{
    threadId: string
    count: number
    pending: number
    steers: number
  }>
  unknownQueues: Set<string>
  nextStart: number
  revision: number
  transportRevision: number
  refreshedRevision: number
  refreshedPath: string | undefined
}

type ShellStyle = CSSProperties & { '--rail-w': string }
type WorkspaceLayoutStyle = CSSProperties & { '--workspace-panel-w': string }
type ProviderLoginTerminalSession = ProviderLoginTerminalTarget & {
  id: number
  visible: boolean
  restorePanelOpen: boolean
  restorePanelExpanded: boolean
  restoreSettings: boolean
}

function shellStyle(width: number): ShellStyle {
  return { '--rail-w': `${width}px` }
}

function workspaceLayoutStyle(width: number): WorkspaceLayoutStyle {
  return { '--workspace-panel-w': `${width}px` }
}

function resolveSendAvailability(input: {
  catalog: CatalogAvailability
  serverBoundSession: boolean
  activeProvider?: ProviderId | undefined
  selectedChoice?: ModelChoice | undefined
  providerStatuses: ProviderStatus[]
  accountCheck: AccountCheck
}): SendAvailability {
  if (input.serverBoundSession) return 'ready'
  if (input.catalog === 'loading') return 'loading'
  if (input.catalog === 'failed') return 'unavailable'

  const provider = input.activeProvider ?? input.selectedChoice?.provider
  if (!provider) {
    return input.providerStatuses.some(
      (status) => !status.installed || status.auth === 'unauthenticated',
    )
      ? 'setup-required'
      : 'unavailable'
  }

  if (input.selectedChoice?.agent && input.selectedChoice.provider !== 'acp') return 'ready'

  const status = input.providerStatuses.find((entry) => entry.id === provider)
  if (!status) return 'unavailable'
  if (!status.installed || status.auth === 'unauthenticated') return 'setup-required'
  if (status.problem || !status.capabilities) return 'unavailable'
  if (status.auth === 'authenticated') return 'ready'
  if (input.accountCheck.provider !== provider || input.accountCheck.state === 'loading') {
    return 'loading'
  }
  if (input.accountCheck.state === 'failed') return 'unavailable'
  return input.accountCheck.account?.signedIn ? 'ready' : 'setup-required'
}

function readCustomModels(): CustomModel[] {
  try {
    const raw = readSetting(CUSTOM_MODELS_KEY)
    if (!raw) return []
    const entries: unknown = JSON.parse(raw)
    if (!Array.isArray(entries)) return []
    const models: CustomModel[] = []
    for (const entry of entries) {
      if (!isRecord(entry)) continue
      const provider = entry['provider']
      const storedModelId = entry['modelId']
      if (
        !isProviderId(provider) ||
        !DIRECT_PROVIDER_ID_SET.has(provider) ||
        typeof storedModelId !== 'string'
      ) {
        continue
      }
      const modelId = storedModelId.trim()
      if (!modelId) continue
      models.push({
        provider,
        modelId,
        displayName: typeof entry['displayName'] === 'string' ? entry['displayName'].trim() : '',
      })
    }
    return models
  } catch {
    return []
  }
}

/** Custom entries append to the provider catalog, so they sit at the bottom
 *  of their provider's group and can never shadow an enumerated model. The
 *  keyed drop covers a cache-miss restore that already carried a custom
 *  choice, so the same model can never appear twice. */
function mergeCustomModels(catalog: ModelChoice[], custom: CustomModel[]): ModelChoice[] {
  if (custom.length === 0) return catalog
  const customChoices = custom.map((entry) =>
    customModelChoice(entry, providerDisplayName(entry.provider), providerMark(entry.provider)),
  )
  const customKeys = new Set(customChoices.map((choice) => choice.key))
  return [...catalog.filter((choice) => !customKeys.has(choice.key)), ...customChoices]
}

function modelSource(choice: ModelChoice): string {
  return sourceKey({
    provider: choice.provider,
    connectionId: choice.connectionId,
    agentId: choice.agent?.id,
  })
}

export function App() {
  const transport = useMemo(() => new Transport(SERVER_BASE_URL), [])
  // StrictMode replays effect cleanup against this same memoized instance.
  const usageController = useMemo(
    () => new UsageLimitsController((params) => transport.request('usage.summary', params)),
    [transport],
  )
  const usageDisposals = useRef(new Map<UsageLimitsController, number>())
  const subscribeUsage = useCallback(
    (listener: () => void) => usageController.subscribe(listener),
    [usageController],
  )
  const readUsage = useCallback(() => usageController.snapshot(), [usageController])
  const usageState = useSyncExternalStore(subscribeUsage, readUsage, readUsage)
  const refreshUsage = useCallback(
    (requestedProvider?: ProviderId) => usageController.refresh(requestedProvider),
    [usageController],
  )
  const consumeReset = useCallback(
    async (requestedProvider: ProviderId, idempotencyKey: string) => {
      try {
        return await transport.request('usage.consumeReset', {
          provider: requestedProvider,
          idempotencyKey,
        })
      } finally {
        refreshUsage(requestedProvider)
      }
    },
    [transport, refreshUsage],
  )

  useEffect(() => {
    // Let StrictMode's immediate replay cancel disposal, while a real unmount
    // or controller replacement still tears down trailing refresh timers.
    window.clearTimeout(usageDisposals.current.get(usageController))
    usageDisposals.current.delete(usageController)
    return () => {
      usageDisposals.current.set(
        usageController,
        window.setTimeout(() => {
          usageDisposals.current.delete(usageController)
          usageController.dispose()
        }, 0),
      )
    }
  }, [usageController])
  const [provider, setProvider] = useState<ProviderId>(() => {
    const stored = readSetting(SETUP_KEY)
    return PROVIDER_IDS.find((id) => id === stored) ?? 'codex'
  })
  const providerRef = useRef(provider)
  providerRef.current = provider
  const [acpAgent, setAcpAgent] = useState<string | undefined>(
    () => readSetting(AGENT_KEY) ?? undefined,
  )
  // Kept so the sidebar can say "Gemini CLI" rather than "acp". The name lives
  // in the adapter package, which the renderer deliberately cannot import.
  const [acpAgentName, setAcpAgentName] = useState<string | undefined>(
    () => readSetting(AGENT_NAME_KEY) ?? undefined,
  )
  // A cache of what the server says, not a source of truth. Every change goes
  // to the server and comes back through here.
  const [projects, setProjects] = useState<Project[]>([])
  const projectChoiceProjector = useMemo(createProjectChoiceProjector, [])
  const projectChoices = useMemo(
    () => projectChoiceProjector(projects),
    [projectChoiceProjector, projects],
  )
  const [projectsStatus, setProjectsStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [onboardingDismissed, setOnboardingDismissed] = useState(
    () => readSetting(ONBOARDING_KEY) === 'done',
  )
  /** The thread whose interrupt has been sent but not yet acknowledged. */
  const [stoppingThreadId, setStoppingThreadId] = useState<string | undefined>()

  useEffect(() => {
    if (projectsStatus !== 'ready' || projects.length === 0 || onboardingDismissed) return
    writeSetting(ONBOARDING_KEY, 'done')
    setOnboardingDismissed(true)
  }, [projects, projectsStatus, onboardingDismissed])
  const [offline, setOffline] = useState(false)
  const [threadController] = useState(() => new ThreadController(transport))
  const [activeId, setActiveIdState] = useState<string | undefined>()
  const setActiveId = useCallback(
    (id: string | undefined) => {
      threadController.activate(id)
      setActiveIdState(id)
    },
    [threadController],
  )
  const [activePath, setActivePath] = useState<string | undefined>()
  const threadFrameStore = threadController.frames
  const thread = useSyncExternalStore(
    threadFrameStore.subscribeStructure,
    threadFrameStore.getStructureSnapshot,
  )
  const setThread = useCallback(
    (next: ThreadState) => threadFrameStore.publish(next),
    [threadFrameStore],
  )
  const [loadingThreadId, setLoadingThreadId] = useState<string | undefined>()
  const composerDraftKeyRef = useRef(NEW_CHAT_DRAFT_KEY)
  const injectedDraftTransition = useRef(false)
  const pendingSession = useRef<
    | {
        id: string
        promise: Promise<string | undefined>
        threadId?: string | undefined
        title: string
      }
    | undefined
  >(undefined)
  const pendingInterruptThreadIds = useRef(new Set<string>())
  const [queuedTurns, setQueuedTurns] = useState<QueuedTurn[]>([])
  const [canSteerQueue, setCanSteerQueue] = useState(false)
  const [customModels] = useState<CustomModel[]>(readCustomModels)
  const customModelsRef = useRef(customModels)
  customModelsRef.current = customModels
  const [{ models: catalogModels, loaded: modelsLoaded, unvalidatedModelKeys }, setModelCatalog] =
    useState<{
      models: ModelChoice[]
      loaded: boolean
      unvalidatedModelKeys: Set<string>
    }>(() => {
      const cached = parseModelCatalogCache(readSetting(MODEL_CATALOG_KEY))
      // Freshness controls whether cached metadata is trusted, not whether its
      // display names may paint. Keep stale names visible while discovery
      // refreshes them instead of flashing raw ids such as `gpt-5.6-sol`.
      const cachedModels = cached?.models ?? []
      const freshModelKeys = new Set(freshModelCatalogChoices(cached).map((choice) => choice.key))
      const restored = cachedModels.length === 0 ? readStoredModelChoice(customModels) : undefined
      return {
        models: cachedModels.length > 0 ? cachedModels : restored ? [restored] : [],
        loaded: cachedModels.length > 0 || restored !== undefined,
        // Stale metadata and the upgrade fallback are presentational only.
        // Until discovery refreshes them they cannot validate a service tier.
        unvalidatedModelKeys: new Set(
          cachedModels
            .filter((choice) => !freshModelKeys.has(choice.key))
            .map((choice) => choice.key)
            .concat(restored && !isCustomModelChoice(restored) ? [restored.key] : []),
        ),
      }
    })
  const [providerStatuses, setProviderStatuses] = useState<ProviderStatus[]>([])
  const [acpAgents, setAcpAgents] = useState<ResultOf<'acp.agents'>['agents']>([])
  const [acpAgentsRequest, setAcpAgentsRequest] = useState(0)
  const acpAgentsCache = useRef<{ transport: Transport; request: number } | undefined>(undefined)
  const [customHarnessIds, setCustomHarnessIds] = useState<Set<string>>(() => new Set())
  const [modelConnections, setModelConnections] = useState<ModelConnection[]>([])
  const [catalogRequest, setCatalogRequest] = useState(0)
  const [modelConnectionsSource, setModelConnectionsSource] = useState<
    { transport: Transport; request: number } | undefined
  >()
  const [providerCatalogSource, setProviderCatalogSource] = useState<
    { transport: Transport; request: number } | undefined
  >()
  const [catalogAvailability, setCatalogAvailability] = useState<CatalogAvailability>('loading')
  const startupMilestones = useRef({
    projectsRequested: false,
    projectsReceived: false,
    projectsReconciled: false,
    projects: false,
    catalog: false,
  })
  useEffect(() => {
    if (projectsStatus === 'ready' && !startupMilestones.current.projects) {
      startupMilestones.current.projects = true
      reportStartupMilestone('projects-ready')
    }
    if (catalogAvailability === 'ready' && !startupMilestones.current.catalog) {
      startupMilestones.current.catalog = true
      reportStartupMilestone('catalog-ready')
    }
  }, [catalogAvailability, projectsStatus])
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(() => {
    try {
      const stored: unknown = JSON.parse(readSetting(HIDDEN_MODELS_KEY) ?? '[]')
      return new Set(isStringArray(stored) ? stored : [])
    } catch {
      return new Set()
    }
  })
  const modelVisibilityInitialized = useRef(readSetting(HIDDEN_MODELS_KEY) !== null)
  // Read via ref inside the catalog effect so toggling visibility does not
  // refetch every provider's model list.
  const hiddenModelsRef = useRef(hiddenModels)
  hiddenModelsRef.current = hiddenModels
  const [modelId, setModelId] = useState<string | undefined>(
    () => readSetting(MODEL_KEY) ?? undefined,
  )
  const [effort, setEffort] = useState<string | undefined>(
    () => readSetting(EFFORT_KEY) ?? undefined,
  )
  const [serviceTier, setServiceTier] = useState<string | undefined>(
    () => readSetting(SERVICE_TIER_KEY) ?? undefined,
  )
  const [approvalByProvider, setApprovalByProvider] = useState<ApprovalPreferences>(() =>
    readApprovalPreferences(provider),
  )
  const approval = approvalByProvider[provider] ?? 'ask'
  const [collapsed, setCollapsed] = useState(
    () => globalThis.matchMedia?.('(max-width: 700px)').matches ?? false,
  )
  // Sampled once was not enough: resizing under the breakpoint left the
  // absolutely-positioned rail permanently overlaying the thread.
  useEffect(() => {
    const media = globalThis.matchMedia?.('(max-width: 700px)')
    if (!media) return
    const onChange = (event: MediaQueryListEvent) => setCollapsed(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  const [railWidth, setRailWidth] = useState(readRailWidth)
  const [workspace, setWorkspace] = useState<WorkspaceInfo | undefined>()
  const [branches, setBranches] = useState<string[]>([])
  const projectBranches = useRef(new Map<string, string>())
  const [workspaceRefreshRevision, setWorkspaceRefreshRevision] = useState(0)
  const [account, setAccount] = useState<Account | undefined>()
  const [profileIdentity, setProfileIdentity] = useState(readProfileIdentityPreferences)
  const updateProfileIdentity = useCallback((updates: Partial<ProfileIdentityPreferences>) => {
    setProfileIdentity((current) => {
      const next = { ...current, ...updates }
      writeProfileIdentityPreferences(next)
      return next
    })
  }, [])
  const [accountCheck, setAccountCheck] = useState<AccountCheck>({ provider, state: 'loading' })
  const accountRequestRevision = useRef(0)
  const [voiceAvailable, setVoiceAvailable] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [keybindings, setKeybindings] = useState(readKeybindings)
  const [surface, setSurface] = useState<'chat' | 'pull-requests'>('chat')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('providers')
  const [providerAuthRefreshRevision, setProviderAuthRefreshRevision] = useState(0)
  const [pullRequestSetupRefreshRevision, setPullRequestSetupRefreshRevision] = useState(0)
  const [sidebarSettings, setSidebarSettings] = useState(DEFAULT_SIDEBAR_SETTINGS)
  const confirmedSidebarSettings = useRef(DEFAULT_SIDEBAR_SETTINGS)
  const confirmedSidebarSettingsRevision = useRef(0)
  const sidebarSettingsSourceRevision = useRef(0)
  const sidebarSettingsUpdates = useRef(new Map<number, Partial<SidebarSettings>>())
  const nextSidebarSettingsRevision = useRef(0)
  const [paletteScope, setPaletteScope] = useState<CommandScope | null>(null)
  const [preferredNewThreadProject, setPreferredNewThreadProject] = useState<string>()
  const sessionSearch = useRef<SessionSearchHandle>(null)
  const [searchJump, setSearchJump] = useState<{
    threadId: string
    turnId: string
    request: number
  }>()
  const [composerFocusRequest, setComposerFocusRequest] = useState(0)
  const [composerDraft, setComposerDraft] = useState<
    | {
        text: string
        attachments?: string[] | undefined
        resources?: ComposerResource[] | undefined
        request: number
      }
    | undefined
  >()
  const [threadRevealRequest, setThreadRevealRequest] = useState(0)
  // Session entry gets a fresh virtualizer at the latest message. A pending
  // session becoming durable keeps this key and preserves its live view.
  const [threadEntryKey, setThreadEntryKey] = useState(0)
  const [notice, setNotice] = useState<string | undefined>()
  const [archiveToastDismissed, setArchiveToastDismissed] = useState(false)
  const {
    hiddenIds: archivingIds,
    pendingIds: pendingArchives,
    queue: enqueueArchive,
    undo: undoQueuedArchives,
  } = useDeferredArchiveQueue(10_000)
  const archiveProjects = useMemo(() => {
    if (archivingIds.length === 0) return projects
    const hidden = new Set(archivingIds)
    return projects.map((project) => ({
      ...project,
      sessions: project.sessions.filter((session) => !hidden.has(session.id)),
    }))
  }, [projects, archivingIds])

  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [rollbackOpen, setRollbackOpen] = useState(false)
  const [rollbackInspection, setRollbackInspection] = useState<
    { checkpoint: Checkpoint; files: string[] } | undefined
  >()
  const [rollbackLoadingId, setRollbackLoadingId] = useState<number | undefined>()
  const [rollbackRestoring, setRollbackRestoring] = useState(false)
  const [undoRestore, setUndoRestore] = useState<{ threadId: string; token: string } | undefined>()
  useEffect(() => {
    if (!notice) return
    const timeout = globalThis.setTimeout(() => {
      setNotice(undefined)
      setUndoRestore(undefined)
    }, NOTICE_AUTO_DISMISS_MS)
    return () => globalThis.clearTimeout(timeout)
  }, [notice])
  const [isolateSession, setIsolateSession] = useState(false)
  const [designMode, setDesignMode] = useState(false)
  const [checkoutDelete, setCheckoutDelete] = useState<
    { id: string; title: string; branch: string } | undefined
  >()
  const [checkoutDeleteBusy, setCheckoutDeleteBusy] = useState(false)
  const macOS = isMacOS()
  const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference)
  const [fontPreference, setFontPreference] = useState<FontPreference>(readFontPreference)
  const [accentPreference, setAccentPreference] = useState<AccentPreference>(readAccentPreference)
  const [backdropPreference, setBackdropPreference] =
    useState<BackdropPreference>(readBackdropPreference)
  const [sidebarGlass, setSidebarGlass] = useState<number>(readGlassPreference)
  const [systemTheme, setSystemTheme] = useState<Theme>(readSystemTheme)
  const theme = themePreference === 'system' ? systemTheme : themePreference
  const themeColorScheme = colorSchemeForTheme(theme)
  const [macOSFontSmoothing, setMacOSFontSmoothing] = useState(
    () => readSetting(MACOS_FONT_SMOOTHING_KEY) !== 'false',
  )
  const [bottomTerminalPhase, setBottomTerminalPhase] = useState<BottomTerminalPhase>('closed')
  const [bottomTerminalHasMounted, setBottomTerminalHasMounted] = useState(false)
  const terminalOpen = bottomTerminalPhase === 'opening' || bottomTerminalPhase === 'open'
  const bottomTerminalMounted = bottomTerminalHasMounted || bottomTerminalPhase !== 'closed'
  const terminalPlacement = useSyncExternalStore(
    subscribeTerminalPlacement,
    readTerminalPlacement,
    readTerminalPlacement,
  )
  const [terminalHeight, setTerminalHeight] = useState(readTerminalHeight)
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false)
  const [workspacePanelHasMounted, setWorkspacePanelHasMounted] = useState(false)
  const [workspacePanelExpanded, setWorkspacePanelExpanded] = useState(false)
  const [workspacePanelWidth, setWorkspacePanelWidth] = useState(readWorkspacePanelWidth)
  const [workspaceTerminalToggleRequest, setWorkspaceTerminalToggleRequest] = useState(0)
  const [workspaceToolRequest, setWorkspaceToolRequest] = useState<{
    request: number
    kind: WorkspaceTool
  }>()
  const nextWorkspaceToolRequest = useRef(0)
  const [workspaceDesignPreviewRequest, setWorkspaceDesignPreviewRequest] =
    useState<BrowserNavigationRequest>()
  const [providerLoginTerminal, setProviderLoginTerminal] = useState<ProviderLoginTerminalSession>()
  const nextProviderLoginTerminalId = useRef(1)
  const providerLoginState = useSyncExternalStore(subscribeInstalls, () =>
    providerLoginTerminal ? installState(providerLoginTerminal.installKey) : undefined,
  )
  const [sideChatPromptRequest, setSideChatPromptRequest] = useState<SideChatPromptRequest>()
  /** The live catalog with user-defined models appended. Everything below
   *  reads this merged list; the cache only ever stores the server catalog. */
  const models = useMemo(
    () => mergeCustomModels(catalogModels, customModels),
    [catalogModels, customModels],
  )
  const rosterModels = useMemo(
    () =>
      models.filter(
        (choice) =>
          PUBLIC_BETA_PROVIDER_IDS.has(choice.provider) ||
          (choice.agent ? customHarnessIds.has(choice.agent.id) : false),
      ),
    [models, customHarnessIds],
  )
  const catalogModelsRef = useRef(catalogModels)
  catalogModelsRef.current = catalogModels
  const modelsRef = useRef(models)
  modelsRef.current = models
  const visibleModels = useMemo(
    () => rosterModels.filter((choice) => !hiddenModels.has(choice.key)),
    [rosterModels, hiddenModels],
  )
  // Memoised for identity: while the catalog is empty this is the selected
  // choice, and a fresh object per render would give every consumer downstream
  // (including effects that write settings) a new dependency each frame.
  const implicitChoice = useMemo(
    () =>
      provider !== 'api' && (provider !== 'pi' || acpAgent)
        ? choicesFor(
            {
              provider,
              sourceName: providerName(provider, acpAgentName),
              mark: provider === 'acp' && acpAgent ? agentMark(acpAgent) : providerMark(provider),
              ...(acpAgent
                ? {
                    agent: { id: acpAgent, name: acpAgentName ?? acpAgent },
                  }
                : {}),
            },
            [],
            true,
          )[0]
        : undefined,
    [provider, acpAgent, acpAgentName],
  )
  const activeSession = useMemo(
    () => (activeId ? findSession(projects, activeId)?.session : undefined),
    [activeId, projects],
  )
  const activeModelSource = useMemo(() => {
    return activeSession
      ? sourceKey({
          provider: activeSession.provider,
          agentId: activeSession.agent,
        })
      : undefined
  }, [activeSession])
  const selectableModels = useMemo(
    () =>
      activeModelSource
        ? visibleModels.filter((choice) => modelSource(choice) === activeModelSource)
        : visibleModels,
    [activeModelSource, visibleModels],
  )
  const storedModelChoice = models.find((choice) => choice.key === modelId)
  const sourceHasCatalogModels = useMemo(
    () =>
      activeModelSource
        ? rosterModels.some((choice) => modelSource(choice) === activeModelSource)
        : false,
    [activeModelSource, rosterModels],
  )
  const selectableImplicitChoice =
    implicitChoice &&
    PUBLIC_BETA_PROVIDER_IDS.has(implicitChoice.provider) &&
    (!activeModelSource || modelSource(implicitChoice) === activeModelSource) &&
    (rosterModels.length === 0 || (activeModelSource && !sourceHasCatalogModels))
      ? implicitChoice
      : undefined
  const selectedModelChoice =
    selectableModels.find((choice) => choice.key === modelId) ??
    selectableModels[0] ??
    selectableImplicitChoice
  const sendAvailability = resolveSendAvailability({
    catalog: catalogAvailability,
    serverBoundSession: Boolean(
      activeSession && activeSession.provider === provider && !implicitChoice,
    ),
    activeProvider: activeSession?.provider,
    selectedChoice: selectedModelChoice,
    providerStatuses,
    accountCheck,
  })
  // One effective setup drives both the picker and requests. State can briefly
  // contain values from storage or the model that was just hidden; resolving
  // in render prevents that transition from leaking into an immediate send.
  const selectedEffort = selectedModelChoice
    ? resolveReasoningEffort({
        currentEffort: effort,
        currentModel: storedModelChoice?.model,
        nextModel: selectedModelChoice.model,
      })
    : undefined
  const selectedServiceTier = selectedModelChoice
    ? unvalidatedModelKeys.has(selectedModelChoice.key)
      ? serviceTier
      : getNextServiceTierForModel({
          currentServiceTier: serviceTier,
          currentModel: storedModelChoice?.model,
          nextModel: selectedModelChoice.model,
        })
    : undefined
  const attachmentsSupported = useMemo(
    () =>
      sourceSupportsAttachments(
        selectedModelChoice
          ? {
              provider: selectedModelChoice.provider,
              connectionId: selectedModelChoice.connectionId,
              agentId: selectedModelChoice.agent?.id,
            }
          : { provider, agentId: acpAgent },
        providerStatuses,
        modelConnections,
      ),
    [selectedModelChoice, provider, acpAgent, providerStatuses, modelConnections],
  )
  const autoReviewSupported = useMemo(
    () =>
      providerStatuses.find((entry) => entry.id === provider)?.capabilities?.autoReview === true,
    [provider, providerStatuses],
  )

  useEffect(() => {
    const checkConnection = () => void transport.ensureHealthy()
    const checkVisibleConnection = () => {
      if (document.visibilityState === 'visible') checkConnection()
    }
    window.addEventListener('focus', checkConnection)
    window.addEventListener('online', checkConnection)
    document.addEventListener('visibilitychange', checkVisibleConnection)
    return () => {
      window.removeEventListener('focus', checkConnection)
      window.removeEventListener('online', checkConnection)
      document.removeEventListener('visibilitychange', checkVisibleConnection)
    }
  }, [transport])

  useLayoutEffect(() => {
    applyTheme(theme)
    void setDesktopTheme(themePreference)
  }, [theme, themePreference])

  usePersistedSettingChange(THEME_KEY, themePreference)

  useLayoutEffect(() => {
    applyFontPreference(fontPreference)
  }, [fontPreference])
  usePersistedSettingChange(FONT_KEY, fontPreference)

  useLayoutEffect(() => {
    applyAccentPreference(accentPreference)
  }, [accentPreference])
  usePersistedSettingChange(ACCENT_KEY, accentPreference)

  useLayoutEffect(() => {
    applyBackdropPreference(backdropPreference)
  }, [backdropPreference])
  usePersistedSettingChange(BACKDROP_KEY, backdropPreference)

  useLayoutEffect(() => {
    applyGlassPreference(sidebarGlass)
  }, [sidebarGlass])
  usePersistedSettingChange(GLASS_KEY, String(sidebarGlass))

  useEffect(() => {
    const media = globalThis.matchMedia?.(DARK_THEME_QUERY)
    if (!media) return

    const updateSystemTheme = () => setSystemTheme(media.matches ? 'dark' : 'light')
    updateSystemTheme()
    media.addEventListener('change', updateSystemTheme)
    return () => media.removeEventListener('change', updateSystemTheme)
  }, [])

  useLayoutEffect(() => {
    document.documentElement.classList.toggle(
      'is-macos-font-smoothing',
      macOS && macOSFontSmoothing,
    )
    return () => document.documentElement.classList.remove('is-macos-font-smoothing')
  }, [macOS, macOSFontSmoothing])

  usePersistedSettingChange(
    MACOS_FONT_SMOOTHING_KEY,
    macOS ? String(macOSFontSmoothing) : undefined,
  )

  useEffect(() => {
    const reduceMotion =
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    if (bottomTerminalPhase === 'opening') {
      setBottomTerminalPhase('open')
      return
    }
    if (bottomTerminalPhase === 'closing' && reduceMotion) {
      setBottomTerminalPhase('closed')
    }
  }, [bottomTerminalPhase])

  useEffect(() => {
    if (bottomTerminalPhase !== 'closing') return
    const timeout = globalThis.setTimeout(() => {
      setBottomTerminalPhase((phase) => (phase === 'closing' ? 'closed' : phase))
    }, BOTTOM_TERMINAL_MOTION_MS + 80)
    return () => globalThis.clearTimeout(timeout)
  }, [bottomTerminalPhase])

  usePersistedSettingChange(TERMINAL_HEIGHT_KEY, String(terminalHeight))

  const cancelWorkspacePanelWidthPersistence = usePersistedSettingChange(
    WORKSPACE_PANEL_WIDTH_KEY,
    String(workspacePanelWidth),
    120,
  )

  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const activePathRef = useRef(activePath)
  activePathRef.current = activePath
  const publishComposerDraft = useCallback((draft: ComposerDraft) => {
    setComposerDraft((current) => ({
      text: draft.text,
      attachments: draft.attachments,
      resources: draft.resources,
      request: (current?.request ?? 0) + 1,
    }))
  }, [])
  const restoreRejectedDraft = useCallback(
    (threadId: string, rejected: RecoverableDraft) => {
      const draft = threadController.recoverDraft(threadId, rejected)
      if (threadId === activeIdRef.current) {
        threadController.draftOwner = threadId
        publishComposerDraft(draft)
      }
    },
    [publishComposerDraft],
  )
  const restoreComposerDraft = useCallback(
    (key: string) => {
      threadController.draftOwner = key
      composerDraftKeyRef.current = key
      publishComposerDraft(threadController.draft(key))
    },
    [publishComposerDraft],
  )
  const handleComposerReady = useCallback(() => {
    restoreComposerDraft(composerDraftKey(activeIdRef.current))
  }, [restoreComposerDraft])
  // New chat and every session keep a separate prompt. Restore on destination
  // change so the previous bar does not travel with the composer.
  useEffect(() => {
    const key = composerDraftKey(activeId)
    if (injectedDraftTransition.current) {
      injectedDraftTransition.current = false
      threadController.draftOwner = key
      composerDraftKeyRef.current = key
      return
    }
    if (composerDraftKeyRef.current === key) {
      threadController.draftOwner = key
      return
    }
    restoreComposerDraft(key)
  }, [activeId, restoreComposerDraft])
  useEffect(() => {
    if (surface !== 'chat') return
    const key = composerDraftKey(activeIdRef.current)
    if (isEmptyComposerDraft(threadController.draft(key))) return
    restoreComposerDraft(key)
  }, [surface, restoreComposerDraft])
  const updateComposerDraftText = useCallback((text: string) => {
    threadController.editDraft(threadController.draftOwner, { text })
  }, [])
  const updateComposerDraftAttachments = useCallback((attachments: string[]) => {
    threadController.editDraft(threadController.draftOwner, { attachments })
  }, [])
  const updateComposerDraftResources = useCallback((resources: ComposerResource[]) => {
    threadController.editDraft(threadController.draftOwner, { resources })
  }, [])
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const workspaceIdleProbe = useRef<WorkspaceIdleProbe>({
    inFlight: undefined,
    pendingPath: undefined,
    idlePath: undefined,
    blockedPath: undefined,
    pendingStarts: new Map(),
    submissionStarts: new ThreadOwnedMap(),
    queuedStarts: new ThreadOwnedMap(),
    claimedStarts: new Set(),
    queueActions: new ThreadOwnedMap(),
    unknownQueues: new Set(),
    nextStart: 0,
    revision: 0,
    transportRevision: 0,
    refreshedRevision: -1,
    refreshedPath: undefined,
  })
  const isThreadCacheProtected = useCallback(
    (threadId: string) => {
      const probe = workspaceIdleProbe.current
      return (
        threadController.isProtected(threadId) ||
        (probe.pendingStarts.get(threadId)?.tokens.length ?? 0) > 0 ||
        probe.submissionStarts.countForThread(threadId) > 0 ||
        probe.queuedStarts.countForThread(threadId) > 0 ||
        probe.queueActions.countForThread(threadId) > 0 ||
        probe.unknownQueues.has(threadId)
      )
    },
    [threadController],
  )
  const pruneThreadStateCache = useCallback(
    () => threadController.prune(isThreadCacheProtected),
    [threadController, isThreadCacheProtected],
  )
  const pruneQueueMetadata = useCallback(
    () => threadController.pruneQueues(isThreadCacheProtected),
    [threadController, isThreadCacheProtected],
  )
  const beginQueueRead = useCallback(
    (id: string) => threadController.beginQueueRead(id),
    [threadController],
  )
  const finishQueueRead = useCallback(
    (id: string) => {
      if (threadController.finishQueueRead(id)) pruneQueueMetadata()
    },
    [threadController, pruneQueueMetadata],
  )
  useEffect(pruneThreadStateCache, [activeId, pruneThreadStateCache])
  useEffect(pruneQueueMetadata, [activeId, pruneQueueMetadata])
  useEffect(() => {
    workspaceIdleProbe.current.revision += 1
  }, [activePath])
  // prettier-ignore
  const invalidateWorkspaceIdleProbe = useCallback((projectPath: string | undefined) => { if (!projectPath || projectPath !== activePathRef.current) return; workspaceIdleProbe.current.revision += 1; workspaceIdleProbe.current.idlePath = undefined; if (workspaceIdleProbe.current.blockedPath === projectPath) workspaceIdleProbe.current.blockedPath = undefined }, [])
  // prettier-ignore
  const releaseWorkspaceStart = useCallback((threadId: string, token?: number) => { const probe = workspaceIdleProbe.current, pending = probe.pendingStarts.get(threadId); if (!pending) return; const index = token === undefined ? 0 : pending.tokens.indexOf(token); if (index < 0) return; pending.tokens.splice(index, 1); if (pending.tokens.length > 0) return; probe.pendingStarts.delete(threadId); if (probe.blockedPath !== pending.path || hasWorkspaceStartForPath(probe.pendingStarts.values(), pending.path)) return; probe.blockedPath = undefined; return pending.path }, [])
  // prettier-ignore
  const holdWorkspaceStart = useCallback((threadId: string, path: string) => { const probe = workspaceIdleProbe.current, current = probe.pendingStarts.get(threadId), token = ++probe.nextStart; probe.idlePath = probe.refreshedPath = undefined; probe.pendingStarts.set(threadId, { path, tokens: [...(current?.tokens ?? []), token] }); return token }, [])
  const refreshWorkspaceAfterCompletion = useCallback(
    (projectPath: string | undefined) => {
      if (!projectPath || projectPath !== activePathRef.current) return
      const probe = workspaceIdleProbe.current
      if (probe.refreshedPath === projectPath && probe.refreshedRevision === probe.revision) return
      probe.pendingPath = projectPath
      if (probe.inFlight) return

      const drain = async () => {
        const transportRevision = probe.transportRevision
        let retryPath: string | undefined
        let retryAvailable = true
        while (probe.pendingPath && transportRevision === probe.transportRevision) {
          const path = probe.pendingPath
          if (path !== retryPath) {
            retryPath = path
            retryAvailable = true
          }
          const revision = probe.revision
          probe.pendingPath = undefined
          let retry = false
          try {
            const { projects } = await transport.request('projects.list', {})
            if (revision !== probe.revision || transportRevision !== probe.transportRevision)
              continue
            if (activePathRef.current !== path) continue
            const project = projects.find((candidate) => candidate.path === path)
            if (!project) {
              retry = probe.idlePath !== path
            } else {
              const pending = hasWorkspaceStartForPath(probe.pendingStarts.values(), path)
              const activity = workspaceProjectActivity(
                project.sessions,
                threadController.queues,
                probe.unknownQueues,
                probe.queueActions.values(),
              )
              if (activity.needsResync) resync.current()
              const blocked = activity.running || pending || activity.queued || activity.unknown
              if (blocked) probe.blockedPath = path
              else if (probe.blockedPath === path) probe.blockedPath = undefined
              probe.idlePath = blocked ? undefined : path
            }
          } catch {
            retry =
              transportRevision === probe.transportRevision &&
              revision === probe.revision &&
              probe.idlePath !== path
          }
          if (!retry || !retryAvailable || probe.pendingPath) continue
          retryAvailable = false
          probe.pendingPath = path
        }

        const path = probe.idlePath
        const blocked = hasWorkspaceStartForPath(probe.pendingStarts.values(), path)
        if (path === activePathRef.current && blocked) probe.blockedPath = path
        probe.idlePath = undefined
        if (path === activePathRef.current && !blocked) {
          probe.refreshedPath = path
          probe.refreshedRevision = probe.revision
          setWorkspaceRefreshRevision((revision) => revision + 1)
        }
      }
      const inFlight = drain()
      probe.inFlight = inFlight
      void inFlight.finally(() => {
        if (probe.inFlight === inFlight) probe.inFlight = undefined
      })
    },
    [transport],
  )
  // prettier-ignore
  const releaseQueuedStart = useCallback((queuedTurnId: string) => { const probe = workspaceIdleProbe.current, owner = probe.queuedStarts.get(queuedTurnId); if (!owner) return; probe.queuedStarts.delete(queuedTurnId); probe.claimedStarts.delete(queuedTurnId); for (const [id, start] of probe.submissionStarts.entriesForThread(owner.threadId)) if (start.token === owner.token) probe.submissionStarts.delete(id); const path = releaseWorkspaceStart(owner.threadId, owner.token); if (path) refreshWorkspaceAfterCompletion(path) }, [releaseWorkspaceStart, refreshWorkspaceAfterCompletion])
  // prettier-ignore
  const holdQueueAction = useCallback((id: string, threadId: string, kind: 'delete' | 'steer') => { const probe = workspaceIdleProbe.current, action = probe.queueActions.get(id) ?? { threadId, count: 0, pending: 0, steers: 0 }; action.count += 1; action.pending += 1; if (kind === 'steer') action.steers += 1; probe.queueActions.set(id, action) }, [])
  // prettier-ignore
  const settleQueueAction = useCallback((id: string, kind: 'delete' | 'steer', indeterminate = false) => { const action = workspaceIdleProbe.current.queueActions.get(id); if (!action) return; action.pending -= 1; if (!indeterminate) { action.count -= 1; if (kind === 'steer') action.steers -= 1 }; if (action.count === 0) workspaceIdleProbe.current.queueActions.delete(id) }, [])
  // prettier-ignore
  const releaseDirectStart = useCallback((threadId: string) => { const probe = workspaceIdleProbe.current, queued = new Set([...probe.queuedStarts.entriesForThread(threadId)].map(([, owner]) => owner.token)), token = probe.pendingStarts.get(threadId)?.tokens.find((candidate) => !queued.has(candidate)); if (token === undefined) return; for (const [id, start] of probe.submissionStarts.entriesForThread(threadId)) if (start.token === token) probe.submissionStarts.delete(id); releaseWorkspaceStart(threadId, token) }, [releaseWorkspaceStart])
  // prettier-ignore
  const clearWorkspaceThread = useCallback((threadId: string) => { const probe = workspaceIdleProbe.current, path = probe.pendingStarts.get(threadId)?.path ?? findSession(projectsRef.current, threadId)?.project.path; probe.pendingStarts.delete(threadId); probe.unknownQueues.delete(threadId); threadController.forget(threadId); for (const [id] of probe.submissionStarts.entriesForThread(threadId)) probe.submissionStarts.delete(id); for (const [id] of probe.queuedStarts.entriesForThread(threadId)) { probe.queuedStarts.delete(id); probe.claimedStarts.delete(id) }; for (const [id] of probe.queueActions.entriesForThread(threadId)) probe.queueActions.delete(id); if (activeIdRef.current === threadId) { activeIdRef.current = undefined; setActiveId(undefined); setThread(emptyThread) }; return path }, [])
  /** Refetch after an outage. Held in a ref because the transport effect is
   *  set up before the fetchers it needs are declared. */
  const resync = useRef<(retry?: boolean) => void>(() => {})
  const flushPendingLifecyclePushes = useRef<(() => void) | undefined>(undefined)
  const sidebarSettingsRef = useRef(sidebarSettings)
  sidebarSettingsRef.current = sidebarSettings
  const reconcileSidebarSettings = useCallback(() => {
    let next = confirmedSidebarSettings.current
    for (const updates of sidebarSettingsUpdates.current.values()) {
      next = { ...next, ...updates }
    }
    sidebarSettingsRef.current = next
    setSidebarSettings(next)
  }, [])
  const settleQueuedSubmissions = useCallback(
    (threadId: string, items: QueuedTurn[], snapshot?: ThreadState) => {
      const rejected = threadController.settleSubmissions(threadId, items, snapshot)
      if (threadId === activeIdRef.current)
        setThread(threadController.snapshot(threadId) ?? emptyThread)
      for (const submission of rejected) restoreRejectedDraft(threadId, submission)
    },
    [restoreRejectedDraft],
  )
  const acceptSidebarSettings = useCallback(
    (settings: SidebarSettings) => {
      sidebarSettingsSourceRevision.current += 1
      confirmedSidebarSettings.current = settings
      reconcileSidebarSettings()
    },
    [reconcileSidebarSettings],
  )

  useEffect(() => {
    // Deltas arrive far faster than frames are drawn. Fold and render one batch
    // per animation frame so a provider burst copies the item list once, not
    // once per token. A non-delta first flushes its thread synchronously, which
    // preserves event order and keeps approvals, boundaries, and completions
    // immediate.
    let lifecycleFlush: number | undefined
    let lifecycleFallback: number | undefined
    const pendingLifecycles = new Map<string, Project['sessions'][number]['lifecycle']>()
    const flushLifecyclePushes = () => {
      if (lifecycleFlush !== undefined) cancelAnimationFrame(lifecycleFlush)
      if (lifecycleFallback !== undefined) window.clearTimeout(lifecycleFallback)
      lifecycleFlush = undefined
      lifecycleFallback = undefined
      if (pendingLifecycles.size === 0) return
      const lifecycles = new Map(pendingLifecycles)
      pendingLifecycles.clear()
      setProjects((current) =>
        updateSessions(current, lifecycles, (session, nextLifecycle) => ({
          ...session,
          lifecycle: nextLifecycle,
        })),
      )
    }
    flushPendingLifecyclePushes.current = flushLifecyclePushes
    const offEvents = transport.on('thread.event', (data) => {
      const { threadId, event } = data
      const next = threadController.receive(data, isThreadCacheProtected)
      if (!next) return
      if (threadId === activeIdRef.current && endsDesignBriefing(event)) setDesignMode(false)
      if (
        event.type === 'turn.started' ||
        event.type === 'turn.completed' ||
        event.type === 'thread.error'
      ) {
        // prettier-ignore
        const projectPath = findSession(projectsRef.current, threadId)?.project.path ?? (threadId === activeIdRef.current ? activePathRef.current : undefined)
        if (event.type === 'turn.started') {
          threadController.resetBackground(threadId)
          if (threadId !== activeIdRef.current) {
            threadController.compact(threadId, isThreadCacheProtected(threadId))
          }
          const probe = workspaceIdleProbe.current
          probe.unknownQueues.delete(threadId)
          // prettier-ignore
          const queued = [...probe.queuedStarts.entriesForThread(threadId)].find(([id]) => probe.claimedStarts.has(id) || !threadController.queue(threadId)?.items.some((item) => item.id === id))?.[0]
          if (queued) releaseQueuedStart(queued)
          else releaseDirectStart(threadId)
          invalidateWorkspaceIdleProbe(projectPath)
        } else {
          refreshWorkspaceAfterCompletion(projectPath)
        }
      }

      if (affectsSessionStatus(event)) {
        setProjects((current) => {
          const updated = updateSession(current, threadId, (session) => {
            const status = statusFor(next, event, threadId !== activeIdRef.current)
            return {
              ...session,
              status,
              statusSince: status === session.status ? session.statusSince : Date.now(),
              ...(event.type === 'turn.completed'
                ? {
                    unread: threadId !== activeIdRef.current,
                  }
                : {}),
            }
          })
          return event.type === 'turn.started' && sidebarSettingsRef.current.mode === 'classic'
            ? promoteSession(updated, threadId)
            : updated
        })
        if (event.type === 'turn.completed' && threadId === activeIdRef.current) {
          // Only here for the server's mark-as-read side effect — the live event
          // stream already delivered the turn. afterSeq skips serializing,
          // shipping, and parsing the full log just to throw it away.
          void transport
            .request('thread.history', { threadId, afterSeq: Number.MAX_SAFE_INTEGER })
            .catch(() => undefined)
          refreshUsage(providerRef.current)
        }
      }
      if (event.type === 'turn.completed' || event.type === 'thread.error') {
        threadController.resetBackground(threadId)
        pruneThreadStateCache()
      }
    })
    const offQueue = transport.on('thread.queue', ({ threadId, items, canSteer }) => {
      const previousItems = threadController.queue(threadId)?.items ?? []
      const probe = workspaceIdleProbe.current
      const ownedChecks =
        probe.queuedStarts.countForThread(threadId) + probe.queueActions.countForThread(threadId)
      const currentIds = indexQueueItemIdsForChecks(items, previousItems.length + ownedChecks)
      const previousIds = indexQueueItemIdsForChecks(previousItems, ownedChecks)
      const currentHas = (id: string) => currentIds?.has(id) ?? items.some((item) => item.id === id)
      const previousHas = (id: string) =>
        previousIds?.has(id) ?? previousItems.some((item) => item.id === id)
      if (previousItems.some((item) => !currentHas(item.id))) probe.unknownQueues.add(threadId)
      else probe.unknownQueues.delete(threadId)
      // prettier-ignore
      { for (const [id] of probe.queuedStarts.entriesForThread(threadId)) { if (currentHas(id)) probe.claimedStarts.delete(id); else if (previousHas(id) && !probe.queueActions.has(id)) probe.claimedStarts.add(id) }; for (const [id, action] of probe.queueActions.entriesForThread(threadId)) if (action.pending === 0 && currentHas(id) && !previousHas(id)) probe.queueActions.delete(id) }
      threadController.setQueue(threadId, { items, canSteer }, 'server')
      settleQueuedSubmissions(threadId, items)
      const projectPath = findSession(projectsRef.current, threadId)?.project.path
      if (items.length === 0 && probe.blockedPath === projectPath)
        refreshWorkspaceAfterCompletion(projectPath)
      if (threadId !== activeIdRef.current) {
        if (items.length === 0) pruneQueueMetadata()
        return
      }
      setQueuedTurns(items)
      setCanSteerQueue(canSteer)
    })
    const offLifecycle = transport.on('thread.lifecycle', ({ threadId, lifecycle }) => {
      pendingLifecycles.set(threadId, lifecycle)
      if (lifecycleFlush !== undefined) return
      lifecycleFlush = requestAnimationFrame(flushLifecyclePushes)
      // Browsers can pause animation frames for hidden windows. This bounded
      // fallback keeps background lifecycle state from waiting indefinitely.
      lifecycleFallback = window.setTimeout(flushLifecyclePushes, 100)
    })
    const offPreviewCapture = transport.on('preview.captureRequested', (request) => {
      setWorkspacePanelHasMounted(true)
      setWorkspaceDesignPreviewRequest({ requestId: request.requestId, url: request.url })
    })
    const offSidebarSettings = transport.on('sidebar.settings', acceptSidebarSettings)
    const offUsageChanged = transport.on('usage.changed', ({ provider }) => {
      usageController.changed(provider)
    })
    const offSequenceGap = transport.onSequenceGap(() => resync.current())
    // Held back briefly: a clean reconnect takes ~500ms, and a banner that
    // appears and vanishes in that time is noise, not information.
    let announce: number | undefined
    let missedPushes = false
    const offState = transport.onState((state) => {
      window.clearTimeout(announce)
      if (state === 'reconnecting') {
        missedPushes = true
        announce = window.setTimeout(() => setOffline(true), 1200)
      } else {
        setOffline(false)
        if (state === 'open' && missedPushes) setCatalogRequest((current) => current + 1)
        if (
          state === 'open' &&
          usageController.snapshot().some((entry) => entry.status === 'error')
        ) {
          refreshUsage()
        }
        // Pushes sent while the socket was down are in the durable log but
        // were never delivered, and sequence numbers restart per connection
        // so the gap detector cannot see it. Without this the thread stays
        // silently truncated — an answer cut mid-sentence, an approval that
        // was already resolved still asking — until the user switches
        // sessions and back.
        if (
          state === 'open' &&
          (missedPushes ||
            workspaceIdleProbe.current.pendingStarts.size > 0 ||
            threadController.queues.size > 0 ||
            workspaceIdleProbe.current.unknownQueues.size > 0)
        ) {
          missedPushes = false
          resync.current()
        }
      }
    })
    transport.connect()
    return () => {
      if (lifecycleFlush !== undefined) cancelAnimationFrame(lifecycleFlush)
      if (lifecycleFallback !== undefined) window.clearTimeout(lifecycleFallback)
      if (flushPendingLifecyclePushes.current === flushLifecyclePushes) {
        flushPendingLifecyclePushes.current = undefined
      }
      pendingLifecycles.clear()
      threadController.suspend()
      window.clearTimeout(announce)
      const probe = workspaceIdleProbe.current
      probe.revision += 1
      probe.transportRevision += 1
      threadController.beginRecovery()
      probe.inFlight = probe.pendingPath = probe.idlePath = probe.blockedPath = undefined
      offEvents()
      offQueue()
      offLifecycle()
      offPreviewCapture()
      offSidebarSettings()
      offUsageChanged()
      offSequenceGap()
      offState()
      transport.close()
    }
  }, [
    transport,
    acceptSidebarSettings,
    settleQueuedSubmissions,
    invalidateWorkspaceIdleProbe,
    releaseWorkspaceStart,
    releaseQueuedStart,
    releaseDirectStart,
    clearWorkspaceThread,
    refreshWorkspaceAfterCompletion,
    refreshUsage,
    usageController,
    threadFrameStore,
    pruneThreadStateCache,
    pruneQueueMetadata,
    isThreadCacheProtected,
  ])

  useEffect(() => {
    if (workspacePanelHasMounted) return
    const openWorkspaceTool = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      const key = event.key.toLowerCase()
      const kind: WorkspaceTool | undefined =
        key === 'g' && event.shiftKey
          ? 'review'
          : key === 't' && !event.shiftKey
            ? 'browser'
            : key === 'p' && event.altKey && !event.shiftKey
              ? 'files'
              : key === 's' && event.altKey
                ? 'side-chat'
                : undefined
      if (!kind) return
      event.preventDefault()
      setWorkspacePanelHasMounted(true)
      setWorkspaceToolRequest({ request: ++nextWorkspaceToolRequest.current, kind })
    }
    window.addEventListener('keydown', openWorkspaceTool)
    return () => window.removeEventListener('keydown', openWorkspaceTool)
  }, [workspacePanelHasMounted])

  useEffect(() => {
    let cancelled = false
    const sourceRevision = sidebarSettingsSourceRevision.current
    void transport
      .request('sidebar.settings', {})
      .then((settings) => {
        if (!cancelled && sidebarSettingsSourceRevision.current === sourceRevision) {
          acceptSidebarSettings(settings)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [transport, acceptSidebarSettings])

  // Build one catalog from every connected source. Model ids are not globally
  // unique, so each choice keeps the provider/connection that will pay for it.
  useEffect(() => {
    let cancelled = false
    setCatalogAvailability((current) => (current === 'ready' ? current : 'loading'))
    void (async () => {
      const connectionsCatalog = transport
        .request('connections.list', {})
        .catch(() => ({ connections: [] }))
      void connectionsCatalog.then((result) => {
        if (cancelled) return
        setModelConnections(result?.connections ?? [])
        setModelConnectionsSource({ transport, request: catalogRequest })
      })
      const harnessesCatalog = transport
        .request('harnesses.list', {})
        .catch(() => ({ harnesses: [] }))
      const providersResult = await transport.request('providers.list', {})
      const providers = providersResult?.providers ?? []
      if (cancelled) return
      setProviderStatuses(providers)
      setCatalogAvailability('ready')
      const storedProvider = readSetting(SETUP_KEY)
      if (
        !activeIdRef.current &&
        (!isProviderId(storedProvider) || !PUBLIC_BETA_PROVIDER_IDS.has(storedProvider))
      ) {
        const fallback = providers.find(
          (status) =>
            PUBLIC_BETA_PROVIDER_IDS.has(status.id) &&
            status.installed &&
            status.capabilities &&
            !status.problem &&
            status.auth !== 'unauthenticated',
        )
        if (fallback) {
          setProvider(fallback.id)
        }
      }
      setProviderCatalogSource({ transport, request: catalogRequest })
      const unknownKeys = new Set<string>()
      const directPromise = Promise.all(
        providers
          .filter((entry) => entry.installed && PUBLIC_BETA_PROVIDER_IDS.has(entry.id))
          .map(async (entry) => {
            const preserveCatalog = () => {
              const source = sourceKey({ provider: entry.id })
              const preserved = catalogModelsRef.current.filter(
                (choice) => !isCustomModelChoice(choice) && modelSource(choice) === source,
              )
              for (const choice of preserved) {
                if (unvalidatedModelKeys.has(choice.key)) unknownKeys.add(choice.key)
              }
              return { provider: entry.id, discovered: false, models: preserved }
            }
            try {
              const result = await transport.request('models.list', { provider: entry.id })
              const models = choicesFor(
                {
                  provider: entry.id,
                  sourceName: entry.displayName,
                  mark: providerMark(entry.id),
                },
                result.models,
                false,
              )
              return models.length > 0
                ? { provider: entry.id, discovered: true, models }
                : preserveCatalog()
            } catch {
              return preserveCatalog()
            }
          }),
      )
      const harnessesResult = await harnessesCatalog
      const harnesses = harnessesResult?.harnesses ?? []
      setCustomHarnessIds(new Set(harnesses.map((harness) => harness.id)))
      const customSourcesPromise = Promise.all(
        harnesses.map(async (harness) => {
          const source = sourceKey({ provider: harness.provider, agentId: harness.id })
          const input = {
            provider: harness.provider,
            sourceName: harness.displayName,
            mark: providerMark(harness.provider),
            agent: { id: harness.id, name: harness.displayName },
          }
          try {
            const result = await transport.request('models.list', {
              provider: harness.provider,
              agent: harness.id,
            })
            return { source, discovered: true, models: choicesFor(input, result.models, true) }
          } catch {
            const preserved = catalogModelsRef.current.filter(
              (choice) => !isCustomModelChoice(choice) && modelSource(choice) === source,
            )
            if (preserved.length > 0) return { source, discovered: false, models: preserved }
            const fallback = choicesFor(input, [], true)
            for (const choice of fallback) unknownKeys.add(choice.key)
            return { source, discovered: false, models: fallback }
          }
        }),
      )
      const [direct, customSources] = await Promise.all([directPromise, customSourcesPromise])
      // Public beta scope: the picker holds only the three direct plans the
      // server lists. Explicit custom harnesses remain eligible because the
      // user configured those sources directly; parked built-ins stay hidden.
      if (cancelled) return
      const directCatalog = direct.flatMap((entry) => entry.models)
      const publicDiscoveries = direct.filter((entry) =>
        PUBLIC_BETA_PROVIDER_IDS.has(entry.provider),
      )
      const publicCatalog = directCatalog.filter((choice) =>
        PUBLIC_BETA_PROVIDER_IDS.has(choice.provider),
      )
      const catalog = [...publicCatalog, ...customSources.flatMap((entry) => entry.models)]
      const publicCatalogReady =
        publicDiscoveries.length > 0 && publicDiscoveries.every((entry) => entry.discovered)
      setModelCatalog({ models: catalog, loaded: true, unvalidatedModelKeys: unknownKeys })
      // A synthetic cache-miss entry has no tier metadata. Do not persist it
      // as an authoritative snapshot after a transient discovery failure.
      if (unknownKeys.size === 0 && direct.every((entry) => entry.discovered)) {
        writeSetting(
          MODEL_CATALOG_KEY,
          serializeModelCatalogCache(catalog, {
            validatedSources: [
              ...direct
                .filter((entry) => entry.discovered)
                .map((entry) => sourceKey({ provider: entry.provider })),
              ...customSources.filter((entry) => entry.discovered).map((entry) => entry.source),
            ],
          }),
        )
      }
      const stored = readSetting(MODEL_KEY)
      // A hidden model cannot remain the internal selection. Otherwise the
      // picker shows no such choice while a turn can still silently use it.
      let hidden = hiddenModelsRef.current
      let hiddenChanged = false
      if (!modelVisibilityInitialized.current && publicCatalogReady && publicCatalog.length > 0) {
        hidden = new Set(
          publicCatalog
            .filter((choice) => !modelVisibleByDefault(choice.model))
            .map((choice) => choice.key),
        )
        modelVisibilityInitialized.current = true
        hiddenChanged = true
      }
      if (
        publicCatalogReady &&
        readSetting(MODEL_VISIBILITY_VERSION_KEY) !== MODEL_VISIBILITY_VERSION
      ) {
        const migrated = new Set(hidden)
        for (const choice of publicCatalog) {
          if (modelVisibleByDefault(choice.model)) migrated.delete(choice.key)
          else migrated.add(choice.key)
        }
        hidden = migrated
        hiddenChanged = true
        writeSetting(MODEL_VISIBILITY_VERSION_KEY, MODEL_VISIBILITY_VERSION)
      }
      if (hiddenChanged) {
        hiddenModelsRef.current = hidden
        setHiddenModels(hidden)
      }
      const customPool = customModelsRef.current
        .filter((entry) => PUBLIC_BETA_PROVIDER_IDS.has(entry.provider))
        .map((entry) =>
          customModelChoice(
            entry,
            providerDisplayName(entry.provider),
            providerMark(entry.provider),
          ),
        )
      const all = [...catalog, ...customPool]
      const visible = all.filter((choice) => !hidden.has(choice.key))
      const currentSession = activeIdRef.current
        ? findSession(projectsRef.current, activeIdRef.current)?.session
        : undefined
      const currentSource = currentSession
        ? sourceKey({ provider: currentSession.provider, agentId: currentSession.agent })
        : undefined
      const storedSetup = readStoredModelChoice(customModelsRef.current)
      const preferredSource = currentSource ?? (storedSetup ? modelSource(storedSetup) : undefined)
      const preferredPool = preferredSource
        ? visible.filter((choice) => modelSource(choice) === preferredSource)
        : []
      // Existing sessions never cross sources. New chats prefer their stored
      // source while it still has a visible choice, but may fall back globally
      // when that source disappears or is hidden in full.
      const selectionPool = currentSource
        ? preferredPool
        : preferredPool.length > 0
          ? preferredPool
          : visible
      const selections = readSourceSelections()
      const storedSelection =
        selectionPool.find((choice) => choice.key === stored) ??
        selectionPool.find((choice) => choice.model.id === stored)
      const fallback = selectionPool.find((choice) => choice.model.isDefault) ?? selectionPool[0]
      const rememberedFallbackKey = fallback
        ? selections[modelSource(fallback)]?.modelKey
        : undefined
      const selected =
        storedSelection ??
        selectionPool.find((choice) => choice.key === rememberedFallbackKey) ??
        fallback
      if (!selected) {
        setModelId(undefined)
        setEffort(undefined)
        setServiceTier(undefined)
        return
      }
      const previous =
        modelsRef.current.find((choice) => choice.key === stored) ??
        modelsRef.current.find((choice) => choice.model.id === stored)
      const remembered = selections[modelSource(selected)]
      const remembersSelected = remembered?.modelKey === selected.key
      setModelId(selected.key)
      setProvider(selected.provider)
      setAcpAgent(selected.agent?.id)
      setAcpAgentName(selected.agent?.name)
      // Persist the whole selection together, exactly like selectModel does.
      // Persisting only the model key left provider and agent to come from
      // stale storage on the next launch — a boot where the model belongs to
      // one provider and the session goes to another.
      writeSetting(SETUP_KEY, selected.provider)
      if (selected.agent) {
        writeSetting(AGENT_KEY, selected.agent.id)
        writeSetting(AGENT_NAME_KEY, selected.agent.name)
      } else {
        // A stale agent id under a non-ACP provider is the same boot split
        // this block exists to prevent.
        removeSetting(AGENT_KEY)
        removeSetting(AGENT_NAME_KEY)
      }
      setEffort((current) => {
        if (remembersSelected) {
          return remembered.effort && selected.model.reasoningEfforts.includes(remembered.effort)
            ? remembered.effort
            : resolveReasoningEffort({ currentEffort: undefined, nextModel: selected.model })
        }
        return resolveReasoningEffort({
          currentEffort: current,
          currentModel: previous?.model,
          nextModel: selected.model,
        })
      })
      setServiceTier((current) => {
        if (unknownKeys.has(selected.key)) {
          return remembersSelected ? remembered.serviceTier : current
        }
        if (remembersSelected) {
          return remembered.serviceTier &&
            selected.model.serviceTiers.some((tier) => tier.id === remembered.serviceTier)
            ? remembered.serviceTier
            : getFastModeOffValue(selected.model)
        }
        return getNextServiceTierForModel({
          currentServiceTier: current,
          currentModel: previous?.model,
          nextModel: selected.model,
        })
      })
    })().catch(() => {
      if (!cancelled) {
        setProviderCatalogSource((current) =>
          current?.transport === transport && current.request === catalogRequest
            ? current
            : { transport, request: catalogRequest },
        )
        setModelCatalog((current) => ({ ...current, loaded: true }))
        setCatalogAvailability((current) => (current === 'ready' ? current : 'failed'))
      }
    })
    return () => {
      cancelled = true
    }
  }, [transport, catalogRequest])

  useEffect(() => {
    if (
      !settingsOpen ||
      (acpAgentsCache.current?.transport === transport &&
        acpAgentsCache.current.request === acpAgentsRequest)
    ) {
      return
    }
    let cancelled = false
    void transport
      .request('acp.agents', {})
      .then((result) => {
        if (cancelled) return
        setAcpAgents(result?.agents ?? [])
        acpAgentsCache.current = { transport, request: acpAgentsRequest }
      })
      .catch(() => {
        if (cancelled) return
        setAcpAgents([])
        acpAgentsCache.current = { transport, request: acpAgentsRequest }
      })
    return () => {
      cancelled = true
    }
  }, [transport, settingsOpen, acpAgentsRequest])

  useEffect(() => {
    if (!isDesktop || !canCaptureVoice() || selectedModelChoice?.agent) {
      setVoiceAvailable(false)
      return
    }
    // Wait until the same catalog revision has resolved the provider fallback
    // and connection
    // snapshot, so either startup order produces one status request.
    if (
      modelConnectionsSource?.transport !== transport ||
      modelConnectionsSource.request !== catalogRequest ||
      providerCatalogSource?.transport !== transport ||
      providerCatalogSource.request !== catalogRequest
    ) {
      return
    }
    let cancelled = false
    void transport
      .request('voice.status', { provider })
      .then((status) => {
        if (!cancelled) setVoiceAvailable(status.available)
      })
      .catch(() => {
        if (!cancelled) setVoiceAvailable(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    transport,
    provider,
    catalogRequest,
    modelConnectionsSource,
    providerCatalogSource,
    selectedModelChoice?.agent,
  ])

  // Turn start takes a git checkpoint, so refresh the shelf only after project idle.
  useEffect(() => {
    if (!activePath) {
      setWorkspace(undefined)
      setBranches([])
      return
    }
    let cancelled = false
    void Promise.all([
      transport.request('workspace.info', { path: activePath }).catch(() => undefined),
      transport.request('workspace.branches', { path: activePath }).catch(() => undefined),
    ]).then(([info, result]) => {
      if (cancelled) return
      setWorkspace(info)
      setBranches(result?.branches ?? (info?.branch ? [info.branch] : []))
      const available = result?.branches ?? (info?.branch ? [info.branch] : [])
      const remembered =
        projectBranches.current.get(activePath) ?? readSetting(`harness.branch:${activePath}`)
      const branch =
        remembered && available.includes(remembered)
          ? remembered
          : available.includes('main')
            ? 'main'
            : info?.branch
      if (branch) projectBranches.current.set(activePath, branch)
    })
    return () => {
      cancelled = true
    }
  }, [transport, activePath, workspaceRefreshRevision])

  useEffect(() => {
    let cancelled = false
    const revision = ++accountRequestRevision.current
    setAccount(undefined)
    if (selectedModelChoice?.agent && provider !== 'acp') {
      setAccountCheck({ provider, state: 'ready', account: { signedIn: true } })
      return () => {
        cancelled = true
      }
    }
    setAccountCheck({ provider, state: 'loading' })
    void transport
      .request('auth.status', {
        provider,
        ...(provider === 'acp' && (selectedModelChoice?.agent?.id ?? acpAgent)
          ? { agent: selectedModelChoice?.agent?.id ?? acpAgent }
          : {}),
      })
      .then((nextAccount) => {
        if (cancelled || revision !== accountRequestRevision.current) return
        setAccount(nextAccount)
        setAccountCheck({ provider, state: 'ready', account: nextAccount })
      })
      .catch(() => {
        if (cancelled || revision !== accountRequestRevision.current) return
        setAccount(undefined)
        setAccountCheck({ provider, state: 'failed' })
      })
    return () => {
      cancelled = true
    }
  }, [transport, provider, acpAgent, selectedModelChoice?.agent])

  const refreshProjects = useCallback(async () => {
    if (!startupMilestones.current.projectsRequested) {
      startupMilestones.current.projectsRequested = true
      reportStartupMilestone('projects-requested')
    }
    const { projects: list } = await transport.request('projects.list', {})
    if (!startupMilestones.current.projectsReceived) {
      startupMilestones.current.projectsReceived = true
      reportStartupMilestone('projects-received')
    }
    const savedOrder = loadSessionOrder()
    const projectOrder = loadProjectOrder()
    const firstProjectPath = applyProjectOrder(list, projectOrder)[0]?.path
    // A full snapshot received after queued pushes is authoritative. Flush the
    // older batch first so its state update cannot replay over this snapshot.
    flushPendingLifecyclePushes.current?.()
    setProjects((current) => {
      const reconciled = reconcileProjectList(current, list, projectOrder, savedOrder)
      if (!startupMilestones.current.projectsReconciled) {
        startupMilestones.current.projectsReconciled = true
        reportStartupMilestone('projects-reconciled')
      }
      return reconciled
    })
    setActivePath((current) => current ?? firstProjectPath)
    return list
  }, [transport])

  const refreshCheckpoints = useCallback(
    async (threadId: string) => {
      const result = await transport.request('thread.checkpoints', { threadId })
      if (activeIdRef.current === threadId) setCheckpoints(result.checkpoints)
    },
    [transport],
  )

  const loadHistory = useCallback(
    async (threadId: string, afterSeq?: number) => {
      try {
        const loaded = await threadController.loadHistory(threadId, afterSeq)
        if (loaded && activeIdRef.current === threadId) {
          setProjects((current) => updateSession(current, threadId, markSessionRead))
        }
        return loaded?.authority
      } finally {
        pruneThreadStateCache()
      }
    },
    [threadController, pruneThreadStateCache],
  )

  resync.current = (retry = true) => {
    const revision = threadController.beginRecovery()
    workspaceIdleProbe.current.revision += 1
    const activeId = activeIdRef.current
    const path = activePathRef.current
    const threadIds = new Set(threadController.pendingThreadIds())
    // prettier-ignore
    const ownerPaths = new Map([...workspaceIdleProbe.current.pendingStarts].filter(([id]) => !id.startsWith('pending:')).map(([id, owner]) => [id, { path: owner.path, tokens: [...owner.tokens] }]))
    for (const id of ownerPaths.keys()) threadIds.add(id)
    for (const action of workspaceIdleProbe.current.queueActions.values())
      threadIds.add(action.threadId)
    for (const session of projectsRef.current.find((project) => project.path === path)?.sessions ??
      [])
      if (
        !['failed', 'ready', 'idle'].includes(session.status) ||
        (threadController.queue(session.id)?.items.length ?? 0) > 0 ||
        workspaceIdleProbe.current.unknownQueues.has(session.id)
      )
        threadIds.add(session.id)
    if (activeId && !activeId.startsWith('pending:')) threadIds.add(activeId)
    const resyncThread = async (
      id: string,
    ): Promise<{ id: string; thread: ThreadState; queue: QueuedTurn[] } | undefined> => {
      const recovered = await threadController.recoverThread(id, revision, isThreadCacheProtected)
      if (!recovered) {
        if (threadController.isCurrentRecovery(revision))
          workspaceIdleProbe.current.unknownQueues.add(id)
        return
      }
      const { history: loaded, state, previousItems } = recovered
      const probe = workspaceIdleProbe.current
      const queuedStarts = [...probe.queuedStarts.entriesForThread(id)]
      const recoveredIds = indexQueueItemIdsForChecks(state.items, queuedStarts.length)
      const previousIds = indexQueueItemIdsForChecks(previousItems, queuedStarts.length)
      for (const [queuedId] of queuedStarts) {
        const recovered =
          recoveredIds?.has(queuedId) ?? state.items.some((item) => item.id === queuedId)
        if (recovered) {
          probe.claimedStarts.delete(queuedId)
          continue
        }
        const previous =
          previousIds?.has(queuedId) ?? previousItems.some((item) => item.id === queuedId)
        if (previous) probe.claimedStarts.add(queuedId)
      }
      for (const item of state.items) {
        const start = probe.submissionStarts.get(item.id)
        if (start?.threadId === id) probe.queuedStarts.set(item.id, start)
      }
      if (activeIdRef.current === id) {
        setQueuedTurns(state.items)
        setCanSteerQueue(state.canSteer)
      }
      if (!loaded) {
        workspaceIdleProbe.current.unknownQueues.add(id)
        return
      }
      workspaceIdleProbe.current.unknownQueues.delete(id)
      settleQueuedSubmissions(id, state.items, loaded)
      return { id, thread: loaded, queue: state.items }
    }
    void Promise.all([
      refreshProjects().catch(() => undefined),
      ...[...threadIds].map((id) => resyncThread(id)),
    ]).then(([projects, ...threads]) => {
      if (!threadController.isCurrentRecovery(revision)) return
      const states = threads.filter((state) => state !== undefined)
      const probe = workspaceIdleProbe.current
      const project = projects?.find((candidate) => candidate.path === path)
      if (!projects) {
        for (const id of ownerPaths.keys()) probe.unknownQueues.add(id)
        if (retry) resync.current(false)
        return
      }
      setProjectsStatus('ready')
      const sessionLocations = indexWorkspaceSessions(projects)
      for (const id of ownerPaths.keys()) {
        if (!sessionLocations.has(id)) clearWorkspaceThread(id)
      }
      for (const state of states) {
        const session = sessionLocations.get(state.id)?.session
        const captured = ownerPaths.get(state.id)
        const current = probe.pendingStarts.get(state.id)
        // prettier-ignore
        const durable = new Set(state.thread.items.filter((item) => item.turnId !== '').map((item) => item.id))
        for (const [id, start] of probe.submissionStarts.entriesForThread(state.id))
          if (durable.has(id)) {
            probe.submissionStarts.delete(id)
            probe.queuedStarts.delete(id)
            probe.claimedStarts.delete(id)
            releaseWorkspaceStart(state.id, start.token)
          }
        for (const [id] of probe.queuedStarts.entriesForThread(state.id))
          if (durable.has(id)) releaseQueuedStart(id)
        const actions = [...probe.queueActions.entriesForThread(state.id)]
        const recoveredQueueIds = indexQueueItemIdsForChecks(state.queue, actions.length)
        for (const [id, action] of actions) {
          if (action.pending !== 0) continue
          const recovered = recoveredQueueIds?.has(id) ?? state.queue.some((item) => item.id === id)
          if (recovered) continue
          if (action.steers > 0 && state.thread.running && !durable.has(id)) continue
          probe.queueActions.delete(id)
          releaseQueuedStart(id)
        }
        if (
          !session ||
          session.running ||
          session.status === 'queued' ||
          state.thread.running ||
          state.queue.length
        )
          continue
        if (captured && current) {
          const tokens = new Set(captured.tokens)
          const protectedTokens = new Set(
            [...probe.queuedStarts.entriesForThread(state.id)]
              .filter(
                ([id]) =>
                  (probe.claimedStarts.has(id) || probe.queueActions.has(id)) && !durable.has(id),
              )
              .map(([, owner]) => owner.token),
          )
          const remainingTokens = current.tokens.filter(
            (token) => !tokens.has(token) || protectedTokens.has(token),
          )
          current.tokens = remainingTokens
          for (const [id, start] of probe.submissionStarts.entriesForThread(state.id))
            if (tokens.has(start.token) && !remainingTokens.includes(start.token))
              probe.submissionStarts.delete(id)
          if (current.tokens.length === 0) probe.pendingStarts.delete(state.id)
          for (const [queuedId, owner] of probe.queuedStarts.entriesForThread(state.id))
            if (tokens.has(owner.token) && !protectedTokens.has(owner.token)) {
              probe.queuedStarts.delete(queuedId)
              probe.claimedStarts.delete(queuedId)
            }
        }
      }
      const previousSessionLocations = indexWorkspaceSessions(projectsRef.current)
      const activeIds = new Set(
        [...threadIds].filter(
          (id) =>
            sessionLocations.get(id)?.path === path &&
            (ownerPaths.get(id)?.path === path || previousSessionLocations.get(id)?.path === path),
        ),
      )
      const activeStates = states.filter((state) => activeIds.has(state.id))
      const activity = project
        ? workspaceProjectActivity(
            project.sessions,
            threadController.queues,
            probe.unknownQueues,
            probe.queueActions.values(),
          )
        : undefined
      const idle =
        path &&
        project &&
        activity &&
        activeStates.length === activeIds.size &&
        !activity.running &&
        !activity.queued &&
        !activity.unknown &&
        !activeStates.some((state) => state.thread.running || state.queue.length > 0)
      if (!idle) {
        if (retry && activeStates.length < activeIds.size) resync.current(false)
        return
      }
      refreshWorkspaceAfterCompletion(path)
    })
    refreshUsage()
    const sourceRevision = sidebarSettingsSourceRevision.current
    void transport
      .request('sidebar.settings', {})
      .then((settings) => {
        if (sidebarSettingsSourceRevision.current === sourceRevision) {
          acceptSidebarSettings(settings)
        }
      })
      .catch(() => undefined)
  }

  useEffect(() => {
    if (!activeId) {
      setQueuedTurns([])
      setCanSteerQueue(false)
      return
    }

    const cached = threadController.queue(activeId)
    setQueuedTurns(cached?.items ?? [])
    setCanSteerQueue(cached?.canSteer ?? false)
    let cancelled = false
    const localRevision = threadController.queueRevision(activeId, 'local')
    const serverRevision = threadController.queueRevision(activeId, 'server')
    beginQueueRead(activeId)
    void transport
      .request('thread.queue', { threadId: activeId })
      .then((state) => {
        if (
          cancelled ||
          threadController.queueRevision(activeId, 'local') !== localRevision ||
          threadController.queueRevision(activeId, 'server') !== serverRevision
        )
          return
        threadController.setQueue(activeId, state)
        settleQueuedSubmissions(activeId, state.items)
        if (activeIdRef.current !== activeId) return
        setQueuedTurns(state.items)
        setCanSteerQueue(state.canSteer)
      })
      .catch(() => undefined)
      .finally(() => finishQueueRead(activeId))
    return () => {
      cancelled = true
    }
  }, [transport, activeId, settleQueuedSubmissions, beginQueueRead, finishQueueRead])

  useEffect(() => {
    if (!activeId || thread.running) {
      if (!activeId) setCheckpoints([])
      return
    }
    void refreshCheckpoints(activeId).catch(() => setCheckpoints([]))
  }, [activeId, thread.running, refreshCheckpoints])

  const usageThreadId = activeId && !activeId.startsWith('pending:') ? activeId : undefined
  const usageProviders = useMemo(
    () => [
      provider,
      ...providerStatuses
        .filter((status) => status.installed && status.id !== provider)
        .map((status) => status.id),
    ],
    [provider, providerStatuses],
  )

  useLayoutEffect(() => {
    usageController.select(
      usageProviders.map((sourceProvider) => ({
        provider: sourceProvider,
        ...(sourceProvider === provider && usageThreadId
          ? {
              threadId: usageThreadId,
            }
          : {}),
      })),
    )
  }, [usageController, usageThreadId, provider, usageProviders])

  // First load, plus the one-time handover from localStorage. Anything found
  // there is given to the server and the key removed, so it happens once.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const legacy = takeLegacyProjects()
      for (const project of legacy) {
        await transport.request('projects.add', project).catch(() => undefined)
      }
      if (legacy.length > 0) removeSetting(PROJECTS_KEY)
      if (!cancelled) {
        setProjectsStatus('loading')
        await refreshProjects()
          .then(() => {
            if (!cancelled) setProjectsStatus('ready')
          })
          .catch(() => {
            if (!cancelled) setProjectsStatus('failed')
          })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [transport, refreshProjects])

  const retryProjects = useCallback(() => {
    setProjectsStatus('loading')
    void refreshProjects()
      .then(() => setProjectsStatus('ready'))
      .catch(() => setProjectsStatus('failed'))
  }, [refreshProjects])

  useEffect(() => {
    if (projects.length > 0) {
      saveProjectOrder(projects)
      saveSessionOrder(projects)
    }
  }, [projects])

  usePersistedSettingChange(MODEL_KEY, modelId || undefined)

  useEffect(() => {
    if (!modelVisibilityInitialized.current) return
    writeSetting(HIDDEN_MODELS_KEY, JSON.stringify([...hiddenModels]))
  }, [hiddenModels])

  usePersistedSettingChange(EFFORT_KEY, effort)

  usePersistedSettingChange(SERVICE_TIER_KEY, serviceTier)

  // Remember the active source's exact setup, so returning to a provider
  // restores what was last used there instead of a best-guess translation.
  useEffect(() => {
    // A visibility change derives its fallback before the persisted model key
    // catches up. Let commitModelChoice finish that transition before this
    // source is remembered, or it would remember a half-translated setup.
    if (
      !selectedModelChoice ||
      selectedModelChoice.key !== modelId ||
      // Provider-default fallbacks are synthetic, just like cache-miss
      // choices. They may drive a catalogless session without replacing the
      // exact model remembered for when that source's catalog returns.
      selectedModelChoice.model.id.length === 0 ||
      unvalidatedModelKeys.has(selectedModelChoice.key)
    ) {
      return
    }
    const source = sourceKey({
      provider: selectedModelChoice.provider,
      connectionId: selectedModelChoice.connectionId,
      agentId: selectedModelChoice.agent?.id,
    })
    const selections = readSourceSelections()
    const entry: SourceSelection = {
      modelKey: selectedModelChoice.key,
      ...(selectedEffort ? { effort: selectedEffort } : {}),
      ...(selectedServiceTier ? { serviceTier: selectedServiceTier } : {}),
    }
    const current = selections[source]
    if (
      current?.modelKey === entry.modelKey &&
      current.effort === entry.effort &&
      current.serviceTier === entry.serviceTier
    ) {
      return
    }
    selections[source] = entry
    writeSetting(MODEL_BY_SOURCE_KEY, JSON.stringify(selections))
  }, [selectedModelChoice, modelId, selectedEffort, selectedServiceTier, unvalidatedModelKeys])

  usePersistedSettingChange(APPROVAL_KEY, approval)

  usePersistedSettingChange(APPROVAL_BY_PROVIDER_KEY, JSON.stringify(approvalByProvider))

  // Shared tail of every model switch: persist the whole selection together,
  // then restore the effort/tier that source was last used with — or translate
  // the current setup onto the new model's ladder.
  const commitModelChoice = useCallback(
    (selected: ModelChoice) => {
      setModelId(selected.key)
      setProvider(selected.provider)
      setAcpAgent(selected.agent?.id)
      setAcpAgentName(selected.agent?.name)
      writeSetting(SETUP_KEY, selected.provider)
      if (selected.agent) {
        writeSetting(AGENT_KEY, selected.agent.id)
        writeSetting(AGENT_NAME_KEY, selected.agent.name)
      } else {
        // A stale agent id under a non-ACP provider is the same boot split
        // this block exists to prevent.
        removeSetting(AGENT_KEY)
        removeSetting(AGENT_NAME_KEY)
      }
      // Picking the model this source was last used with restores the exact
      // effort and tier that were active then. Any other pick translates the
      // current effort onto the new model's ladder, as before.
      const remembered =
        readSourceSelections()[
          sourceKey({
            provider: selected.provider,
            connectionId: selected.connectionId,
            agentId: selected.agent?.id,
          })
        ]
      if (remembered?.modelKey === selected.key) {
        setEffort(
          remembered.effort && selected.model.reasoningEfforts.includes(remembered.effort)
            ? remembered.effort
            : resolveReasoningEffort({ currentEffort: undefined, nextModel: selected.model }),
        )
        setServiceTier(
          unvalidatedModelKeys.has(selected.key)
            ? remembered.serviceTier
            : remembered.serviceTier &&
                selected.model.serviceTiers.some((tier) => tier.id === remembered.serviceTier)
              ? remembered.serviceTier
              : getFastModeOffValue(selected.model),
        )
        return
      }
      setEffort((current) =>
        resolveReasoningEffort({
          currentEffort: current,
          currentModel: storedModelChoice?.model ?? selectedModelChoice?.model,
          nextModel: selected.model,
        }),
      )
      // Not a bare id check: fast tiers are named differently per provider
      // (Codex 'priority', Cursor 'fast'), and fast intent must survive the
      // switch even though the id cannot.
      setServiceTier((current) =>
        unvalidatedModelKeys.has(selected.key)
          ? current
          : getNextServiceTierForModel({
              nextModel: selected.model,
              currentModel: storedModelChoice?.model ?? selectedModelChoice?.model,
              currentServiceTier: current,
            }),
      )
    },
    [selectedModelChoice, storedModelChoice, unvalidatedModelKeys],
  )

  // Keep persisted selection state coherent after a visibility or cache
  // transition. Requests already use the effective values above, so even an
  // interaction before this effect runs cannot observe the stale setup.
  useEffect(() => {
    if (!selectedModelChoice) {
      setModelId(undefined)
      setEffort(undefined)
      setServiceTier(undefined)
      return
    }
    if (
      modelId !== selectedModelChoice.key ||
      provider !== selectedModelChoice.provider ||
      acpAgent !== selectedModelChoice.agent?.id ||
      acpAgentName !== selectedModelChoice.agent?.name
    ) {
      commitModelChoice(selectedModelChoice)
      return
    }
    if (effort !== selectedEffort) setEffort(selectedEffort)
    if (serviceTier !== selectedServiceTier) setServiceTier(selectedServiceTier)
  }, [
    selectedModelChoice,
    modelId,
    provider,
    acpAgent,
    acpAgentName,
    effort,
    serviceTier,
    selectedEffort,
    selectedServiceTier,
    commitModelChoice,
  ])

  const selectModel = useCallback(
    (id: string) => {
      const selected = models.find((model) => model.key === id)
      if (!selected) return
      commitModelChoice(selected)
    },
    [models, commitModelChoice],
  )

  const addProjects = useCallback(
    async (paths: readonly string[]) => {
      const uniquePaths = [...new Set(paths)]
      const activePath = uniquePaths.at(-1)
      if (!activePath) return
      await Promise.all(uniquePaths.map((path) => transport.request('projects.add', { path })))
      await refreshProjects()
      setActivePath(activePath)
      activeIdRef.current = undefined
      setActiveId(undefined)
      setThread(emptyThread)
    },
    [transport, refreshProjects],
  )

  const addProject = useCallback(async () => {
    const path = await pickFolder()
    if (path) await addProjects([path])
  }, [addProjects])

  const generateSessionTitle = useCallback(
    async (threadId: string, prompt: string, expectedTitle: string) => {
      try {
        const generated = await transport.request('backgroundModel.generateTitle', {
          threadId,
          prompt,
          expectedTitle,
        })
        if (!generated.applied) return
        setProjects((current) => renameSession(current, threadId, generated.title))
      } catch {
        // The immediate prompt-derived title remains useful when a background
        // provider is unavailable or the short generation fails.
      }
    },
    [transport],
  )

  const createSession = useCallback(
    async (
      projectPath: string,
      provisionalId: string,
      title: string,
      titlePrompt: string,
    ): Promise<string | undefined> => {
      const choice = selectedModelChoice
      if (!choice) return undefined
      setNotice(undefined)
      setUndoRestore(undefined)
      setRollbackOpen(false)
      setActivePath(projectPath)
      try {
        let branch = projectBranches.current.get(projectPath)
        if (!branch) {
          const { branches: available } = await transport.request('workspace.branches', {
            path: projectPath,
          })
          const remembered = readSetting(`harness.branch:${projectPath}`)
          branch =
            remembered && available.includes(remembered)
              ? remembered
              : available.includes('main')
                ? 'main'
                : undefined
        }
        const sessionApproval =
          approval === 'auto-review' && !autoReviewSupported ? 'ask' : approval
        const { threadId } = await transport.request('thread.start', {
          provider: choice.provider,
          workspacePath: projectPath,
          ...(branch ? { baseRef: branch } : {}),
          approval: sessionApproval,
          ...(choice.agent ? { agent: choice.agent.id } : {}),
          ...(choice.connectionId
            ? {
                connectionId: choice.connectionId,
              }
            : {}),
          ...(choice.model.id ? { model: choice.model.id } : {}),
          ...(selectedServiceTier
            ? {
                serviceTier: selectedServiceTier,
              }
            : {}),
          ...(selectedEffort ? { effort: selectedEffort } : {}),
          ...(isolateSession ? { isolate: true } : {}),
        })
        const provisional = threadController.snapshot(provisionalId) ?? emptyThread
        threadController.discardSnapshot(provisionalId)
        threadController.update(threadId, provisional)
        threadController.setCursor(threadId, 0)
        const pendingStart = workspaceIdleProbe.current.pendingStarts.get(provisionalId)
        // prettier-ignore
        if (pendingStart) { workspaceIdleProbe.current.pendingStarts.delete(provisionalId); workspaceIdleProbe.current.pendingStarts.set(threadId, pendingStart) }
        const pending =
          pendingSession.current?.id === provisionalId ? pendingSession.current : undefined
        if (pending) pending.threadId = threadId
        const canonicalTitle = pending?.title ?? title
        setProjects((current) =>
          current.map((project) =>
            project.path !== projectPath
              ? project
              : {
                  ...project,
                  sessions: project.sessions.some((session) => session.id === provisionalId)
                    ? project.sessions.map((session) =>
                        session.id === provisionalId ? { ...session, id: threadId } : session,
                      )
                    : project.sessions.some((session) => session.id === threadId)
                      ? project.sessions
                      : [
                          {
                            id: threadId,
                            title: canonicalTitle,
                            provider: choice.provider,
                            ...(choice.agent
                              ? {
                                  agent: choice.agent.id,
                                }
                              : {}),
                            createdAt: Date.now(),
                            statusSince: Date.now(),
                            status: 'starting',
                            lifecycle: { state: 'active', keepActive: false },
                            unread: false,
                          },
                          ...project.sessions,
                        ],
                },
          ),
        )
        if (activeIdRef.current === provisionalId) {
          threadController.moveDraft(provisionalId, threadId)
          if (threadController.draftOwner === provisionalId) threadController.draftOwner = threadId
          if (composerDraftKeyRef.current === provisionalId) composerDraftKeyRef.current = threadId
          activeIdRef.current = threadId
          setActiveId(threadId)
          setThread(provisional)
        }
        void transport
          .request('thread.rename', { threadId, title: canonicalTitle })
          .then(() => generateSessionTitle(threadId, titlePrompt, canonicalTitle))
          .catch(() => undefined)
          .then(() => refreshProjects())
          .catch(() => undefined)
        return threadId
      } catch (error) {
        const path = releaseWorkspaceStart(provisionalId)
        if (path) refreshWorkspaceAfterCompletion(path)
        threadController.discardSnapshot(provisionalId)
        setProjects((current) =>
          current.map((project) => ({
            ...project,
            sessions: project.sessions.filter((session) => session.id !== provisionalId),
          })),
        )
        if (activeIdRef.current === provisionalId) {
          activeIdRef.current = undefined
          setActiveId(undefined)
          setThread(emptyThread)
        }
        setNotice(error instanceof Error ? error.message : String(error))
        return undefined
      }
    },
    [
      transport,
      selectedModelChoice,
      selectedServiceTier,
      selectedEffort,
      approval,
      autoReviewSupported,
      isolateSession,
      refreshProjects,
      generateSessionTitle,
      releaseWorkspaceStart,
      refreshWorkspaceAfterCompletion,
    ],
  )

  const beginSession = useCallback(
    (projectPath: string, draft?: string) => {
      setSurface('chat')
      if (draft !== undefined) {
        const next = threadController.editDraft(NEW_CHAT_DRAFT_KEY, {
          text: draft,
          attachments: [],
          resources: [],
        })
        threadController.draftOwner = NEW_CHAT_DRAFT_KEY
        composerDraftKeyRef.current = NEW_CHAT_DRAFT_KEY
        injectedDraftTransition.current = activeIdRef.current !== undefined
        publishComposerDraft(next)
      }
      // A session nobody typed into is bookkeeping, not history. Pressing "new
      // session" twice should not leave a trail of empty ones.
      const untouched = projectsRef.current
        .find((project) => project.path === projectPath)
        ?.sessions.filter((session) => session.title === 'New session')
      for (const session of untouched ?? []) {
        threadController.discardSnapshot(session.id)
      }
      setProjects((current) =>
        current.map((project) =>
          project.path === projectPath
            ? {
                ...project,
                sessions: project.sessions.filter((session) => session.title !== 'New session'),
              }
            : project,
        ),
      )
      void (async () => {
        for (const session of untouched ?? []) {
          const deleted = await transport
            .request('thread.delete', { threadId: session.id })
            .then(() => true)
            .catch(() => false)
          if (deleted) {
            clearWorkspaceThread(session.id)
            refreshWorkspaceAfterCompletion(projectPath)
          }
        }
        await refreshProjects().catch(() => undefined)
      })()
      setNotice(undefined)
      setActivePath(projectPath)
      activeIdRef.current = undefined
      setActiveId(undefined)
      setThread(emptyThread)
      setComposerFocusRequest((request) => request + 1)
      if (!PUBLIC_BETA_PROVIDER_IDS.has(provider)) setCatalogRequest((current) => current + 1)
    },
    [
      projects,
      transport,
      refreshProjects,
      provider,
      clearWorkspaceThread,
      refreshWorkspaceAfterCompletion,
      publishComposerDraft,
    ],
  )

  const updateQueue = useCallback(
    (threadId: string, update: (items: QueuedTurn[]) => QueuedTurn[]) => {
      const current = threadController.queue(threadId) ?? { items: [], canSteer: false }
      const next = { ...current, items: update(current.items) }
      threadController.setQueue(threadId, next, 'local')
      if (activeIdRef.current === threadId) setQueuedTurns(next.items)
    },
    [],
  )

  const requestInterrupt = useCallback(
    (threadId: string) => {
      setStoppingThreadId(threadId)
      void transport.request('thread.interrupt', { threadId }).catch((error) => {
        setStoppingThreadId((current) => (current === threadId ? undefined : current))
        setNotice(error instanceof Error ? error.message : String(error))
      })
    },
    [transport],
  )

  const send = useCallback(
    async (text: string, attachments: string[] = [], submission: 'queue' | 'steer' = 'queue') => {
      // The composer clears itself the moment it hands the text over. Every
      // early bail below must put the words back — a toast is no substitute
      // for the paragraph someone just typed.
      const restoreDraft = () => {
        const key = composerDraftKey(activeIdRef.current)
        const next = threadController.editDraft(key, { text, attachments })
        threadController.draftOwner = key
        publishComposerDraft(next)
      }
      const sideChatCommand = parseSideChatCommand(text)
      if (sideChatCommand) {
        if (!activeId || activeId.startsWith('pending:')) {
          restoreDraft()
          setNotice('Start the main chat before opening a side chat.')
          return
        }
        const parent = threadController.snapshot(activeId)
        if (!parent?.items.some((item) => item.type === 'message' && item.role === 'user')) {
          restoreDraft()
          setNotice('Send a message in the main chat before opening a side chat.')
          return
        }
        setNotice(undefined)
        setWorkspacePanelHasMounted(true)
        setWorkspacePanelOpen(true)
        setSideChatPromptRequest((current) => ({
          parentThreadId: activeId,
          text: sideChatCommand.prompt,
          attachments,
          request: (current?.request ?? 0) + 1,
        }))
        return
      }
      if (sendAvailability !== 'ready') {
        restoreDraft()
        return
      }
      // Design briefing questions are TasteCode-owned and answered by the server,
      // so they work for every provider that can complete a text turn — no
      // structured-input capability gate here (that gates provider-originated
      // input only).
      const briefing = designMode
      const turnAttachments = briefing ? addDesignBriefing(attachments) : attachments
      let workspaceStartId = activeId
      let workspaceStartToken: number | undefined
      if (activePath && workspaceStartId) {
        workspaceStartToken = holdWorkspaceStart(workspaceStartId, activePath)
      }
      const releasePendingStart = () => {
        workspaceIdleProbe.current.submissionStarts.delete(optimisticItemId)
        if (workspaceStartId) {
          const path = releaseWorkspaceStart(workspaceStartId, workspaceStartToken)
          if (path) refreshWorkspaceAfterCompletion(path)
        }
      }
      // Typing first and having the session appear is the natural order. Making
      // the user press "new session" before they are allowed to type is the
      // app's bookkeeping leaking into their way of working.
      let threadId = activeId
      let optimisticAdded = false
      let optimisticTurnId: string | undefined
      const optimisticItemId = createOptimisticMessageId()
      const optimisticCreatedAt = Date.now()
      let titledOnCreate = false
      let interruptRequested = false
      if (!threadId) {
        if (!activePath) {
          restoreDraft()
          return
        }
        const provisionalId = `pending:${crypto.randomUUID()}`
        const provisional = beginOptimisticTurn(
          emptyThread,
          text,
          optimisticItemId,
          optimisticCreatedAt,
          attachments,
        )
        const choice = selectedModelChoice
        if (!choice) {
          restoreDraft()
          return
        }
        workspaceStartId = provisionalId
        workspaceStartToken = holdWorkspaceStart(provisionalId, activePath)
        optimisticTurnId = provisional.activeTurn?.id
        threadController.update(provisionalId, provisional)
        setProjects((current) =>
          current.map((project) =>
            project.path === activePath
              ? {
                  ...project,
                  sessions: [
                    {
                      id: provisionalId,
                      title: titleFrom(text),
                      provider: choice.provider,
                      ...(choice.agent
                        ? {
                            agent: choice.agent.id,
                          }
                        : {}),
                      createdAt: Date.now(),
                      statusSince: Date.now(),
                      status: 'starting',
                      lifecycle: { state: 'active', keepActive: false },
                      unread: false,
                    },
                    ...project.sessions,
                  ],
                }
              : project,
          ),
        )
        activeIdRef.current = provisionalId
        setActiveId(provisionalId)
        setThread(provisional)
        setThreadRevealRequest((request) => request + 1)
        const promise = createSession(activePath, provisionalId, titleFrom(text), text)
        pendingSession.current = { id: provisionalId, promise, title: titleFrom(text) }
        threadId = await promise
        interruptRequested = pendingInterruptThreadIds.current.delete(provisionalId)
        if (pendingSession.current?.id === provisionalId) pendingSession.current = undefined
        if (!threadId) {
          setStoppingThreadId((current) => (current === provisionalId ? undefined : current))
          const current = threadController.snapshot(provisionalId)
          if (current !== undefined && current.activeTurn?.id === optimisticTurnId) {
            const next: ThreadState = { ...current, running: false, activeTurn: undefined }
            threadController.update(provisionalId, next)
            if (activeIdRef.current === provisionalId) setThread(next)
          }
          releasePendingStart()
          restoreDraft()
          return
        }
        workspaceStartId = threadId
        if (interruptRequested) setStoppingThreadId(threadId)
        optimisticAdded = true
        titledOnCreate = true
      } else if (pendingSession.current?.id === threadId) {
        const pending = pendingSession.current
        const targetId = pending.threadId ?? pending.id
        const provisional = appendUserMessage(
          threadController.snapshot(targetId) ?? emptyThread,
          text,
          optimisticItemId,
          optimisticCreatedAt,
          attachments,
        )
        threadController.update(targetId, provisional)
        if (activeIdRef.current === targetId) setThread(provisional)
        setThreadRevealRequest((request) => request + 1)
        threadId = await pending.promise
        if (!threadId) {
          releasePendingStart()
          restoreDraft()
          return
        }
        workspaceStartId = threadId
        optimisticAdded = true
      }

      setNotice(undefined)
      setUndoRestore(undefined)

      const before = threadController.snapshot(threadId) ?? emptyThread
      const wasRunning = before.running && !optimisticAdded
      const steering = submission === 'steer'
      const optimisticQueueId = wasRunning && !steering ? optimisticItemId : undefined
      if (!wasRunning && !optimisticAdded) {
        const next = beginOptimisticTurn(
          before,
          text,
          optimisticItemId,
          optimisticCreatedAt,
          attachments,
        )
        optimisticTurnId = next.activeTurn?.id
        threadController.update(threadId, next)
        if (threadId === activeIdRef.current) {
          setThread(next)
          setThreadRevealRequest((request) => request + 1)
        }
      } else if (wasRunning && steering) {
        const next = appendUserMessage(
          before,
          text,
          optimisticItemId,
          optimisticCreatedAt,
          attachments,
        )
        threadController.update(threadId, next)
        if (threadId === activeIdRef.current) setThread(next)
      }
      if (optimisticQueueId) {
        updateQueue(threadId, (items) => [
          ...items,
          { id: optimisticQueueId, text, attachments, createdAt: Date.now() },
        ])
      }
      const optimisticState = threadController.snapshot(threadId) ?? emptyThread
      threadController.forgetDraft(threadId)
      const pendingOptimisticTurn = optimisticState.activeTurn
      const precedingTurn = wasRunning ? before.activeTurn : undefined
      const pendingSubmission: PendingSubmission = {
        id: optimisticItemId,
        text,
        attachments,
        createdAt: optimisticCreatedAt,
        kind: wasRunning ? (steering ? 'steer' : 'queue') : 'turn',
        accepted: false,
        indeterminate: false,
        ...(precedingTurn
          ? {
              precedingTurnId: precedingTurn.id,
            }
          : {}),
      }
      if (pendingOptimisticTurn && pendingOptimisticTurn.id === optimisticTurnId) {
        pendingSubmission.optimisticTurn = pendingOptimisticTurn
      }
      threadController.submit(threadId, pendingSubmission)
      if (workspaceStartToken !== undefined)
        workspaceIdleProbe.current.submissionStarts.set(optimisticItemId, {
          threadId,
          token: workspaceStartToken,
        })

      // A session named after what was asked of it is findable a week later;
      // "New session" is not. Named from the first message only.
      //
      // A session created a moment ago is untitled by definition — `projects`
      // here is still the value from this render and cannot know about it yet,
      // so asking it would answer no every time and nothing would be named.
      const existingSession = findSession(projects, threadId)?.session
      const untitled = !titledOnCreate && existingSession?.title === 'New session'
      if (untitled) {
        const title = titleFrom(text)
        setProjects((current) => promoteSession(renameSession(current, threadId, title), threadId))
        void transport
          .request('thread.rename', { threadId, title })
          .then(() => generateSessionTitle(threadId, text, title))
          .catch(() => undefined)
      }
      const turnChoice =
        !existingSession ||
        (selectedModelChoice &&
          sourceKey({
            provider: selectedModelChoice.provider,
            connectionId: selectedModelChoice.connectionId,
            agentId: selectedModelChoice.agent?.id,
          }) ===
            sourceKey({
              provider: existingSession.provider,
              agentId: existingSession.agent,
            }))
          ? selectedModelChoice
          : undefined
      let turnAccepted = false
      let queuedActionId: string | undefined
      try {
        const turnRequest = transport.request('thread.sendTurn', {
          threadId,
          text,
          clientSubmissionId: optimisticItemId,
          ...(turnAttachments.length > 0 ? { attachments: turnAttachments } : {}),
          ...(turnChoice?.model.id ? { model: turnChoice?.model.id } : {}),
          ...(turnChoice && selectedEffort ? { effort: selectedEffort } : {}),
          ...(turnChoice && selectedServiceTier
            ? {
                serviceTier: selectedServiceTier,
              }
            : {}),
        })
        // A new chat can be stopped while thread.start is still resolving.
        // Preserve that intent, put sendTurn on the wire first, then interrupt
        // the canonical thread; the server latches interrupts during startup.
        if (interruptRequested) requestInterrupt(threadId)
        const result = await turnRequest
        turnAccepted = true
        const current = threadController.snapshot(threadId) ?? emptyThread
        const pending = threadController.submission(threadId, optimisticItemId)
        threadController.updateSubmission(threadId, optimisticItemId, { accepted: true })
        if (result.queued) {
          threadController.updateSubmission(threadId, optimisticItemId, {
            kind: steering ? 'steer' : 'queue',
          })
          if (workspaceStartToken !== undefined)
            workspaceIdleProbe.current.queuedStarts.set(result.queuedTurn.id, {
              threadId,
              token: workspaceStartToken,
            })
          if (steering) {
            queuedActionId = result.queuedTurn.id
            holdQueueAction(queuedActionId, threadId, 'steer')
            await transport.request('thread.steerQueuedTurn', {
              threadId,
              queuedTurnId: result.queuedTurn.id,
            })
            settleQueueAction(queuedActionId, 'steer')
            workspaceIdleProbe.current.unknownQueues.delete(threadId)
            releaseQueuedStart(queuedActionId)
          } else {
            updateQueue(threadId, (items) => {
              const optimisticIndex = optimisticQueueId
                ? items.findIndex((item) => item.id === optimisticQueueId)
                : -1
              if (optimisticIndex < 0) {
                return items.some((item) => item.id === result.queuedTurn.id)
                  ? items
                  : [...items, result.queuedTurn]
              }
              const next = items.slice()
              const canonicalIndex = next.findIndex((item) => item.id === result.queuedTurn.id)
              if (canonicalIndex < 0 || canonicalIndex === optimisticIndex)
                next[optimisticIndex] = result.queuedTurn
              else next.splice(optimisticIndex, 1)
              return next
            })
            if (!wasRunning) {
              const reconciled = pending ? removePendingSubmission(current, pending) : current
              threadController.update(threadId, reconciled)
              if (threadId === activeIdRef.current) setThread(reconciled)
            }
            threadController.forgetSubmission(threadId, optimisticItemId)
          }
        } else if (!result.queued && wasRunning) {
          threadController.updateSubmission(threadId, optimisticItemId, { kind: 'turn' })
          if (optimisticQueueId) {
            updateQueue(threadId, (items) => items.filter((item) => item.id !== optimisticQueueId))
          }
        }
      } catch (error) {
        if (error instanceof IndeterminateRequestError) {
          threadController.updateSubmission(threadId, optimisticItemId, { indeterminate: true })
          if (queuedActionId) settleQueueAction(queuedActionId, 'steer', true)
          return
        }
        if (queuedActionId) settleQueueAction(queuedActionId, 'steer')
        threadController.forgetSubmission(threadId, optimisticItemId)
        if (optimisticQueueId) {
          updateQueue(threadId, (items) => items.filter((item) => item.id !== optimisticQueueId))
        }
        if (!turnAccepted) {
          releasePendingStart()
          const current = threadController.snapshot(threadId)
          if (current !== undefined) {
            // The server did not accept this prompt. Remove only its local
            // echo; a durable item already bound to a turn remains.
            let next = removeOptimisticMessage(current, optimisticItemId)
            if (current.activeTurn?.id === optimisticTurnId) {
              next = { ...next, running: false, activeTurn: undefined }
            }
            threadController.update(threadId, next)
            if (threadId === activeIdRef.current) setThread(next)
          }
          restoreRejectedDraft(threadId, { text, attachments })
        } else if (steering) {
          const current = threadController.snapshot(threadId)
          if (current) {
            const next = removeOptimisticMessage(current, optimisticItemId)
            threadController.update(threadId, next)
            if (threadId === activeIdRef.current) setThread(next)
          }
        }
        setNotice(error instanceof Error ? error.message : String(error))
      }
    },
    [
      transport,
      activeId,
      activePath,
      createSession,
      projects,
      selectedModelChoice,
      selectedEffort,
      selectedServiceTier,
      updateQueue,
      requestInterrupt,
      designMode,
      holdWorkspaceStart,
      releaseWorkspaceStart,
      refreshWorkspaceAfterCompletion,
      holdQueueAction,
      settleQueueAction,
      restoreRejectedDraft,
      sendAvailability,
      publishComposerDraft,
    ],
  )

  const interrupt = useCallback(() => {
    if (!activeId) return
    if (activeId.startsWith('pending:')) {
      pendingInterruptThreadIds.current.add(activeId)
      setStoppingThreadId(activeId)
      return
    }
    requestInterrupt(activeId)
  }, [activeId, requestInterrupt])

  // The turn ending — however it ended — clears the pending state. Switching
  // sessions does too: the badge belongs to the thread, not to the composer.
  const stopping = stoppingThreadId !== undefined && stoppingThreadId === activeId && thread.running
  const visibleRunning = thread.running && !stopping
  useEffect(() => {
    if (stoppingThreadId && !thread.running && stoppingThreadId === activeId) {
      setStoppingThreadId(undefined)
    }
  }, [thread.running, stoppingThreadId, activeId])

  const transcribeVoice = useCallback(
    async (requestId: string, recording: VoiceRecording): Promise<string> => {
      const { text } = await transport.request('voice.transcribe', {
        requestId,
        provider: 'codex',
        ...recording,
      })
      return text
    },
    [transport],
  )

  const cancelVoice = useCallback(
    (requestId: string) => {
      void transport.request('voice.cancel', { requestId }).catch(() => undefined)
    },
    [transport],
  )

  // Stable identity on purpose: this lands in effect dependency lists inside
  // Settings, where a per-render identity would re-trigger them every render.
  const refreshCatalog = useCallback(() => {
    setCatalogRequest((request) => request + 1)
    setAcpAgentsRequest((request) => request + 1)
  }, [])

  const handleAccountChange = useCallback(
    (changedProvider: ProviderId, changedAccount: Account) => {
      if (changedProvider === provider) {
        accountRequestRevision.current += 1
        setAccount(changedAccount)
        setAccountCheck({ provider: changedProvider, state: 'ready', account: changedAccount })
      }
    },
    [provider],
  )

  useEffect(() => {
    if (!providerLoginTerminal || providerLoginState?.phase !== 'succeeded') return
    const completed = providerLoginTerminal
    clearInstall(completed.installKey)
    setProviderLoginTerminal(undefined)
    setWorkspacePanelOpen(completed.restorePanelOpen)
    setWorkspacePanelExpanded(completed.restorePanelExpanded)
    if (completed.restoreSettings) {
      setSettingsSection('providers')
      setSettingsOpen(true)
    }
    if (completed.source === 'pull-requests') {
      setPullRequestSetupRefreshRevision((revision) => revision + 1)
      return
    }
    if (completed.operation === 'install') {
      refreshCatalog()
      return
    }
    const completedProvider = completed.provider
    if (!completedProvider) return
    setProviderAuthRefreshRevision((revision) => revision + 1)
    void transport
      .request('auth.status', { provider: completedProvider })
      .then((account) => handleAccountChange(completedProvider, account))
      .catch(() => undefined)
  }, [
    handleAccountChange,
    providerLoginState?.phase,
    providerLoginTerminal,
    refreshCatalog,
    transport,
  ])

  // prettier-ignore
  const deleteQueuedTurn = useCallback((queuedTurnId: string) => { if (!activeId) return; holdQueueAction(queuedTurnId, activeId, 'delete'); const projectPath = findSession(projectsRef.current, activeId)?.project.path; void transport.request('thread.deleteQueuedTurn', { threadId: activeId, queuedTurnId }).then(() => { updateQueue(activeId, (items) => items.filter((item) => item.id !== queuedTurnId)); settleQueueAction(queuedTurnId, 'delete'); workspaceIdleProbe.current.unknownQueues.delete(activeId); releaseQueuedStart(queuedTurnId); refreshWorkspaceAfterCompletion(projectPath) }).catch((error) => { settleQueueAction(queuedTurnId, 'delete', error instanceof IndeterminateRequestError); setNotice(error instanceof Error ? error.message : String(error)) }) }, [transport, activeId, updateQueue, releaseQueuedStart, refreshWorkspaceAfterCompletion, holdQueueAction, settleQueueAction])

  const moveQueuedTurn = useCallback(
    (queuedTurnId: string, direction: 'up' | 'down') => {
      if (!activeId) return Promise.resolve(false)
      return transport
        .request('thread.moveQueuedTurn', { threadId: activeId, queuedTurnId, direction })
        .then(() => true)
        .catch((error) => {
          setNotice(error instanceof Error ? error.message : String(error))
          return false
        })
    },
    [transport, activeId],
  )

  // prettier-ignore
  const steerQueuedTurn = useCallback((queuedTurnId: string) => { if (!activeId) return; holdQueueAction(queuedTurnId, activeId, 'steer'); const projectPath = findSession(projectsRef.current, activeId)?.project.path; void transport.request('thread.steerQueuedTurn', { threadId: activeId, queuedTurnId }).then(() => { updateQueue(activeId, (items) => items.filter((item) => item.id !== queuedTurnId)); settleQueueAction(queuedTurnId, 'steer'); workspaceIdleProbe.current.unknownQueues.delete(activeId); releaseQueuedStart(queuedTurnId); refreshWorkspaceAfterCompletion(projectPath) }).catch((error) => { settleQueueAction(queuedTurnId, 'steer', error instanceof IndeterminateRequestError); setNotice(error instanceof Error ? error.message : String(error)) }) }, [transport, activeId, updateQueue, releaseQueuedStart, refreshWorkspaceAfterCompletion, holdQueueAction, settleQueueAction])

  const selectProject = useCallback((path: string) => {
    setSurface('chat')
    if (path === activePathRef.current) return
    setActivePath(path)
    activeIdRef.current = undefined
    setActiveId(undefined)
    setThread(emptyThread)
    setUndoRestore(undefined)
    setRollbackOpen(false)
  }, [])

  const selectBranch = useCallback(
    async (branch: string) => {
      if (!activePath || activeId) return
      setNotice(undefined)
      try {
        const info = isolateSession
          ? undefined
          : await transport.request('workspace.switchBranch', {
              path: activePath,
              branch,
            })
        projectBranches.current.set(activePath, branch)
        writeSetting(`harness.branch:${activePath}`, branch)
        if (activePathRef.current !== activePath || activeIdRef.current) return
        setWorkspace((current) => info ?? (current ? { ...current, branch } : current))
        setBranches((current) => [branch, ...current.filter((item) => item !== branch)])
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      }
    },
    [transport, activePath, activeId, isolateSession],
  )

  // Stable identities, so the memo around Composer is not defeated by a fresh
  // arrow on every streamed frame — memo compares props shallowly, and an
  // inline arrow fails that comparison every single time.
  const changeBranch = useCallback((branch: string) => void selectBranch(branch), [selectBranch])
  const requireProject = useCallback(() => setNotice('Choose a project before sending.'), [])
  const sendTurn = useCallback((text: string, files: string[]) => void send(text, files), [send])
  const steerTurn = useCallback(
    (text: string, files: string[]) => void send(text, files, 'steer'),
    [send],
  )

  const selectSession = useCallback(
    async (id: string) => {
      setSurface('chat')
      const found = findSession(projectsRef.current, id)
      if (found?.session.provider) {
        const source = sourceKey({
          provider: found.session.provider,
          agentId: found.session.agent,
        })
        const matchesSource = (choice: ModelChoice) =>
          sourceKey({
            provider: choice.provider,
            connectionId: choice.connectionId,
            agentId: choice.agent?.id,
          }) === source
        const rememberedModelKey = readSourceSelections()[source]?.modelKey
        const matchingChoice =
          (selectedModelChoice && matchesSource(selectedModelChoice)
            ? selectedModelChoice
            : undefined) ??
          visibleModels.find(
            (choice) => choice.key === rememberedModelKey && matchesSource(choice),
          ) ??
          visibleModels.find(matchesSource)
        if (matchingChoice) {
          commitModelChoice(matchingChoice)
        } else {
          setProvider(found.session.provider)
          setAcpAgent(found.session.agent)
          setAcpAgentName(undefined)
          writeSetting(SETUP_KEY, found.session.provider)
          if (found.session.agent) {
            writeSetting(AGENT_KEY, found.session.agent)
            removeSetting(AGENT_NAME_KEY)
          } else {
            removeSetting(AGENT_KEY)
            removeSetting(AGENT_NAME_KEY)
          }
        }
      }
      setNotice(undefined)
      setUndoRestore(undefined)
      setRollbackOpen(false)
      activeIdRef.current = id
      setActiveId(id)
      setComposerFocusRequest((request) => request + 1)
      setThreadRevealRequest((request) => request + 1)
      setThreadEntryKey((key) => key + 1)
      setActivePath(found?.project.path)
      threadController.resetBackground(id)
      threadController.flush(id)
      const cached = threadController.touch(id)
      if (cached) {
        setThread(cached)
        setProjects((current) => updateSession(current, id, markSessionRead))
        if (threadController.hasPending(id)) {
          resync.current()
          return
        }
      } else {
        setThread(emptyThread)
      }

      setLoadingThreadId(id)
      try {
        await loadHistory(id, cached ? threadController.cursor(id) : undefined)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      } finally {
        setLoadingThreadId((current) => (current === id ? undefined : current))
      }
    },
    [visibleModels, selectedModelChoice, commitModelChoice, loadHistory, transport],
  )

  const inspectCheckpoint = useCallback(
    async (checkpoint: Checkpoint) => {
      if (!activeId) return
      setRollbackLoadingId(checkpoint.id)
      try {
        const { files } = await transport.request('thread.changedSince', {
          threadId: activeId,
          checkpointId: checkpoint.id,
        })
        setRollbackInspection({ checkpoint, files })
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      } finally {
        setRollbackLoadingId(undefined)
      }
    },
    [transport, activeId],
  )

  const decideApproval = useCallback(
    (approvalId: string, decision: ApprovalDecision) => {
      const threadId = activeIdRef.current
      if (!threadId) return
      void transport.request('thread.respondToApproval', { threadId, approvalId, decision })
    },
    [transport],
  )
  /**
   * The permission chip is the one control for the access level, so it has to
   * do both jobs at once: it is this provider's default for every new session,
   * and picking a different mode inside a live chat changes that chat now.
   */
  const changeApproval = useCallback(
    (mode: ApprovalMode) => {
      setApprovalByProvider((current) =>
        current[provider] === mode ? current : { ...current, [provider]: mode },
      )
      const threadId = activeIdRef.current
      if (!threadId || threadId.startsWith('pending:')) return
      void transport
        .request('thread.setApproval', { threadId, approval: mode })
        .catch((error) => setNotice(error instanceof Error ? error.message : String(error)))
    },
    [provider, transport],
  )
  const answerUserInput = useCallback(
    (requestId: string, answers: Record<string, string[]>) => {
      const threadId = activeIdRef.current
      if (!threadId) return Promise.reject(new Error('No active session'))
      return transport
        .request('thread.respondToUserInput', { threadId, requestId, answers })
        .then(() => undefined)
    },
    [transport],
  )
  const editMessage = useCallback((text: string) => {
    threadController.editDraft(threadController.draftOwner, { text })
    setComposerDraft((current) => ({ text, request: (current?.request ?? 0) + 1 }))
    setComposerFocusRequest((request) => request + 1)
  }, [])
  const revertCheckpoint = useCallback(
    (checkpoint: Checkpoint) => {
      setRollbackInspection(undefined)
      setRollbackOpen(true)
      void inspectCheckpoint(checkpoint)
    },
    [inspectCheckpoint],
  )

  const undoTurnChanges = useCallback(
    async (threadId: string, turnId: string, expectedDiff: string) => {
      setNotice(undefined)
      await transport.request('thread.undoTurnChanges', { threadId, turnId, expectedDiff })
      if (activeIdRef.current !== threadId) return
      setNotice('Changes undone.')
      const projectPath = findSession(projectsRef.current, threadId)?.project.path
      invalidateWorkspaceIdleProbe(projectPath)
      refreshWorkspaceAfterCompletion(projectPath)
    },
    [transport, invalidateWorkspaceIdleProbe, refreshWorkspaceAfterCompletion],
  )

  const restoreCheckpoint = useCallback(async () => {
    if (!activeId || !rollbackInspection) return
    setRollbackRestoring(true)
    try {
      threadController.invalidateHistory(activeId)
      const { undo } = await transport.request('thread.restore', {
        threadId: activeId,
        checkpointId: rollbackInspection.checkpoint.id,
      })
      await loadHistory(activeId)
      await refreshCheckpoints(activeId)
      if (activePath) setWorkspace(await transport.request('workspace.info', { path: activePath }))
      setUndoRestore({ threadId: activeId, token: undo })
      setNotice(`Restored to before “${rollbackInspection.checkpoint.label}”.`)
      setRollbackOpen(false)
      setRollbackInspection(undefined)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setRollbackRestoring(false)
    }
  }, [transport, activeId, activePath, rollbackInspection, loadHistory, refreshCheckpoints])

  const reverseRestore = useCallback(async () => {
    if (!undoRestore) return
    try {
      threadController.invalidateHistory(undoRestore.threadId)
      await transport.request('thread.undoRestore', {
        threadId: undoRestore.threadId,
        undo: undoRestore.token,
      })
      await loadHistory(undoRestore.threadId)
      await refreshCheckpoints(undoRestore.threadId)
      if (activePath) setWorkspace(await transport.request('workspace.info', { path: activePath }))
      setUndoRestore(undefined)
      setNotice('Restore undone.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }, [transport, undoRestore, activePath, loadHistory, refreshCheckpoints])

  const deleteSession = useCallback(
    async (id: string) => {
      await transport.request('thread.delete', { threadId: id })
      const projectPath = clearWorkspaceThread(id)
      threadController.discardSnapshot(id)
      threadController.invalidateHistory(id)
      setProjects((current) => removeSession(current, id))
      if (activeIdRef.current === id) {
        activeIdRef.current = undefined
        setActiveId(undefined)
        setThread(emptyThread)
      }
      threadController.forgetDraft(id)
      refreshWorkspaceAfterCompletion(projectPath)
    },
    [transport, clearWorkspaceThread, refreshWorkspaceAfterCompletion],
  )

  const queueArchive = useCallback(
    (id: string, commit: () => Promise<void>) => {
      setArchiveToastDismissed(false)
      enqueueArchive(id, async () => {
        try {
          await commit()
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error))
          await refreshProjects().catch(() => undefined)
        }
      })
      if (activeIdRef.current === id) {
        activeIdRef.current = undefined
        setActiveId(undefined)
        setThread(emptyThread)
      }
    },
    [enqueueArchive, refreshProjects],
  )

  const undoArchive = useCallback(() => {
    const id = undoQueuedArchives()
    if (id) void selectSession(id)
  }, [selectSession, undoQueuedArchives])

  const archiveSession = useCallback(
    async (id: string) => {
      const found = findSession(projectsRef.current, id)
      if (!found) return false
      try {
        const work = await transport.request('thread.unsavedWork', { threadId: id })
        if (work.isolated && work.uncommitted) {
          setCheckoutDelete({
            id,
            title: found.session.title,
            branch: found.session.worktreeBranch ?? 'isolated checkout',
          })
          return false
        }
        queueArchive(id, async () => {
          if (work.isolated) {
            await transport.request('thread.close', { threadId: id })
            await transport.request('thread.discardWorktree', { threadId: id })
          }
          await deleteSession(id)
        })
        return true
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
        await refreshProjects().catch(() => undefined)
        return false
      }
    },
    [transport, deleteSession, refreshProjects, queueArchive],
  )

  const discardAndArchive = useCallback(async () => {
    if (!checkoutDelete) return
    setCheckoutDeleteBusy(true)
    try {
      const id = checkoutDelete.id
      queueArchive(id, async () => {
        await transport.request('thread.close', { threadId: id })
        await transport.request('thread.discardWorktree', { threadId: id, force: true })
        await deleteSession(id)
      })
      setCheckoutDelete(undefined)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
      await refreshProjects().catch(() => undefined)
    } finally {
      setCheckoutDeleteBusy(false)
    }
  }, [transport, checkoutDelete, deleteSession, refreshProjects, queueArchive])

  const startNewChat = useCallback(() => {
    const currentProjects = projectsRef.current
    const currentPath = activePathRef.current
    if (sidebarSettings.mode === 'inbox' && currentProjects.length > 1) {
      setPreferredNewThreadProject(currentPath)
      setPaletteScope('new-thread')
      return
    }
    const path = currentPath ?? currentProjects[0]?.path
    if (path) beginSession(path)
    else void addProject()
  }, [beginSession, addProject, sidebarSettings.mode])

  const updateSidebarSettings = useCallback(
    (updates: Partial<SidebarSettings>) => {
      const revision = ++nextSidebarSettingsRevision.current
      sidebarSettingsUpdates.current.set(revision, updates)
      reconcileSidebarSettings()
      void transport
        .request('sidebar.updateSettings', updates)
        .then((settings) => {
          if (revision < confirmedSidebarSettingsRevision.current) return
          confirmedSidebarSettingsRevision.current = revision
          confirmedSidebarSettings.current = settings
          sidebarSettingsSourceRevision.current += 1
          for (const pendingRevision of sidebarSettingsUpdates.current.keys()) {
            if (pendingRevision <= revision) sidebarSettingsUpdates.current.delete(pendingRevision)
          }
          reconcileSidebarSettings()
        })
        .catch((error) => {
          sidebarSettingsUpdates.current.delete(revision)
          reconcileSidebarSettings()
          setNotice(error instanceof Error ? error.message : String(error))
        })
    },
    [transport, reconcileSidebarSettings],
  )

  const hideSessions = useCallback(
    async (ids: string[], action: 'settle' | 'snooze', wakeAt?: number) => {
      const targets = [...new Set(ids)]
      if (targets.length === 0 || (action === 'snooze' && wakeAt === undefined)) return
      try {
        const results = await Promise.all(
          targets.map(async (id) => {
            let result
            if (action === 'settle') {
              result = await transport.request('thread.settle', { threadId: id })
            } else {
              if (wakeAt === undefined) throw new Error('snooze time is required')
              result = await transport.request('thread.snooze', { threadId: id, wakeAt })
            }
            return [id, result.lifecycle] as const
          }),
        )
        const lifecycles = new Map(results)
        flushPendingLifecyclePushes.current?.()
        setProjects((current) =>
          updateSessions(current, lifecycles, (session, lifecycle) => ({
            ...session,
            lifecycle,
          })),
        )
        const activeId = activeIdRef.current
        if (!activeId || !targets.includes(activeId)) return
        const currentProjects = projectsRef.current
        const current = findSession(currentProjects, activeId)
        const hidden = new Set(targets)
        const next = currentProjects
          .flatMap((project) => project.sessions)
          .filter((session) => !hidden.has(session.id) && session.lifecycle.state === 'active')
          .sort((a, b) => b.createdAt - a.createdAt)[0]
        if (next) await selectSession(next.id)
        else if (current) beginSession(current.project.path)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
        await refreshProjects().catch(() => undefined)
      }
    },
    [transport, selectSession, beginSession, refreshProjects],
  )

  const hideSession = useCallback(
    (id: string, action: 'settle' | 'snooze', wakeAt?: number) =>
      hideSessions([id], action, wakeAt),
    [hideSessions],
  )

  const restoreSessions = useCallback(
    async (ids: string[], action: 'unsettle' | 'unsnooze') => {
      const targets = [...new Set(ids)]
      if (targets.length === 0) return
      try {
        const results = await Promise.all(
          targets.map(async (id) => {
            const result =
              action === 'unsettle'
                ? await transport.request('thread.unsettle', { threadId: id })
                : await transport.request('thread.unsnooze', { threadId: id })
            return [id, result.lifecycle] as const
          }),
        )
        const lifecycles = new Map(results)
        flushPendingLifecyclePushes.current?.()
        setProjects((current) =>
          updateSessions(current, lifecycles, (session, lifecycle) => ({
            ...session,
            lifecycle,
          })),
        )
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
        await refreshProjects().catch(() => undefined)
      }
    },
    [transport, refreshProjects],
  )

  const restoreSession = useCallback(
    (id: string, action: 'unsettle' | 'unsnooze') => restoreSessions([id], action),
    [restoreSessions],
  )

  const keepSessionActive = useCallback(
    async (id: string, keepActive: boolean) => {
      try {
        const { lifecycle } = await transport.request('thread.setKeepActive', {
          threadId: id,
          keepActive,
        })
        flushPendingLifecyclePushes.current?.()
        setProjects((current) =>
          updateSession(current, id, (session) => ({ ...session, lifecycle })),
        )
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      }
    },
    [transport],
  )

  const sidebarInbox = useMemo(
    () => ({
      onSettle: (id: string) => void hideSession(id, 'settle'),
      onSettleMany: (ids: string[]) => void hideSessions(ids, 'settle'),
      onUnsettle: (id: string) => void restoreSession(id, 'unsettle'),
      onUnsettleMany: (ids: string[]) => void restoreSessions(ids, 'unsettle'),
      onSnooze: (id: string, wakeAt: number) => void hideSession(id, 'snooze', wakeAt),
      onSnoozeMany: (ids: string[], wakeAt: number) => void hideSessions(ids, 'snooze', wakeAt),
      onUnsnooze: (id: string) => void restoreSession(id, 'unsnooze'),
      onUnsnoozeMany: (ids: string[]) => void restoreSessions(ids, 'unsnooze'),
      onKeepActive: (id: string, keepActive: boolean) => void keepSessionActive(id, keepActive),
    }),
    [hideSession, hideSessions, restoreSession, restoreSessions, keepSessionActive],
  )
  const closeSidebar = useCallback(() => setCollapsed(true), [])
  const resizeSidebar = useCallback((width: number) => {
    setRailWidth(width)
    writeSetting(RAIL_WIDTH_KEY, String(width))
  }, [])
  const addSidebarProject = useCallback(() => {
    setSurface('chat')
    void addProject()
  }, [addProject])
  const addDroppedSidebarProjects = useCallback(
    (paths: string[]) => {
      setSurface('chat')
      void addProjects(paths)
    },
    [addProjects],
  )
  const startSidebarSession = useCallback(
    (path?: string, chooseProject?: boolean) => {
      setSurface('chat')
      const currentProjects = projectsRef.current
      const currentPath = activePathRef.current
      if (chooseProject && currentProjects.length > 1) {
        setPreferredNewThreadProject(path ?? currentPath)
        setPaletteScope('new-thread')
      } else if (path) beginSession(path)
      else if (currentProjects.length === 1 && currentProjects[0]) {
        beginSession(currentProjects[0].path)
      } else {
        setPreferredNewThreadProject(currentPath)
        setPaletteScope('new-thread')
      }
    },
    [beginSession],
  )
  const selectSidebarSession = useCallback((id: string) => void selectSession(id), [selectSession])
  const openPullRequests = useCallback(() => {
    setSettingsOpen(false)
    setPaletteScope(null)
    setSurface('pull-requests')
  }, [])
  const openPullRequestChat = useCallback(
    (pullRequest: PullRequestListItem) => {
      if (!pullRequest.localProjectPath) return
      beginSession(
        pullRequest.localProjectPath,
        `I wanted to work on ${pullRequest.url} (${pullRequest.title}).`,
      )
      setComposerFocusRequest((request) => request + 1)
    },
    [beginSession],
  )
  const [sidebarMutations] = useState(() => new OptimisticMutations(setNotice))
  useEffect(
    () =>
      transport.onState((state) => {
        if (state === 'open') sidebarMutations.reconcile()
      }),
    [sidebarMutations, transport],
  )
  const recoverSidebarProject = useCallback(
    async (path: string, field: 'name' | 'pinned') => {
      const { projects: list } = await transport.request('projects.list', {})
      const saved = list.find((project) => project.path === path)
      return () =>
        setProjects((current) =>
          current.flatMap((project) =>
            project.path !== path
              ? [project]
              : saved
                ? [{ ...project, [field]: saved[field] }]
                : [],
          ),
        )
    },
    [transport],
  )
  const recoverSidebarSession = useCallback(
    async (id: string, field: 'title' | 'pinned') => {
      const { projects: list } = await transport.request('projects.list', {})
      const saved = list.flatMap((project) => project.sessions).find((session) => session.id === id)
      return () =>
        setProjects((current) =>
          saved
            ? updateSession(current, id, (session) => ({ ...session, [field]: saved[field] }))
            : removeSession(current, id),
        )
    },
    [transport],
  )
  const renameSidebarProject = useCallback(
    (path: string, name: string) => {
      setProjects((current) =>
        current.map((project) => (project.path === path ? { ...project, name } : project)),
      )
      void sidebarMutations.run(
        `project:${path}:name`,
        () => transport.request('projects.rename', { path, name }),
        () => recoverSidebarProject(path, 'name'),
      )
    },
    [recoverSidebarProject, sidebarMutations, transport],
  )
  const removeSidebarProject = useCallback(
    (path: string) => {
      const previousActivePath = activePathRef.current
      setProjects((current) => current.filter((project) => project.path !== path))
      if (previousActivePath === path) setActivePath(undefined)
      void transport
        .request('projects.remove', { path })
        .then(refreshProjects)
        .catch((error) => {
          setNotice(error instanceof Error ? error.message : String(error))
          // Put the selection back too, not just the list. Removal can now be
          // refused, and refreshProjects would otherwise fill the cleared
          // selection with an arbitrary other project while the open session
          // still belongs to this one.
          setActivePath(previousActivePath)
          void refreshProjects().catch(() => undefined)
        })
    },
    [transport, refreshProjects],
  )
  const toggleSidebarProjectPin = useCallback(
    (path: string) => {
      const pinned = !projectsRef.current.find((project) => project.path === path)?.pinned
      setProjects((current) =>
        current.map((project) => (project.path === path ? { ...project, pinned } : project)),
      )
      void sidebarMutations.run(
        `project:${path}:pinned`,
        () => transport.request('projects.pin', { path, pinned }),
        () => recoverSidebarProject(path, 'pinned'),
      )
    },
    [recoverSidebarProject, sidebarMutations, transport],
  )
  const renameSidebarSession = useCallback(
    (id: string, title: string) => {
      setProjects((current) => renameSession(current, id, title))
      const pending = pendingSession.current
      if (pending?.id === id) {
        pending.title = title
        if (!pending.threadId) return
        id = pending.threadId
      }
      void sidebarMutations.run(
        `thread:${id}:title`,
        () => transport.request('thread.rename', { threadId: id, title }),
        () => recoverSidebarSession(id, 'title'),
      )
    },
    [recoverSidebarSession, sidebarMutations, transport],
  )
  const toggleSidebarSessionPin = useCallback(
    (id: string) => {
      const pinned = !findSession(projectsRef.current, id)?.session.pinned
      setProjects((current) => updateSession(current, id, (session) => ({ ...session, pinned })))
      void sidebarMutations.run(
        `thread:${id}:pinned`,
        () => transport.request('thread.pin', { threadId: id, pinned }),
        () => recoverSidebarSession(id, 'pinned'),
      )
    },
    [recoverSidebarSession, sidebarMutations, transport],
  )
  const deleteSidebarSession = useCallback(
    (id: string) => void archiveSession(id),
    [archiveSession],
  )
  const archiveSidebarProject = useCallback(
    (sessionIds: string[]) => {
      void (async () => {
        for (const id of sessionIds) {
          if (!(await archiveSession(id))) break
        }
      })()
    },
    [archiveSession],
  )
  const reorderSidebarSession = useCallback(
    (projectPath: string, sourceId: string, targetId: string, position: 'before' | 'after') => {
      setProjects((current) =>
        current.map((project) => {
          if (project.path !== projectPath) return project
          const sourceIndex = project.sessions.findIndex((session) => session.id === sourceId)
          if (sourceIndex < 0) return project

          const sessions = [...project.sessions]
          const [moved] = sessions.splice(sourceIndex, 1)
          const targetIndex = sessions.findIndex((session) => session.id === targetId)
          if (!moved || targetIndex < 0) return project
          sessions.splice(targetIndex + (position === 'after' ? 1 : 0), 0, moved)
          return { ...project, sessions }
        }),
      )
    },
    [],
  )
  const reorderSidebarProject = useCallback(
    (sourcePath: string, targetPath: string, position: 'before' | 'after') => {
      setProjects((current) => {
        const sourceIndex = current.findIndex((project) => project.path === sourcePath)
        if (sourceIndex < 0) return current
        const next = [...current]
        const [moved] = next.splice(sourceIndex, 1)
        const targetIndex = next.findIndex((project) => project.path === targetPath)
        if (!moved || targetIndex < 0 || moved.pinned !== next[targetIndex]?.pinned) return current
        next.splice(targetIndex + (position === 'after' ? 1 : 0), 0, moved)
        return next
      })
    },
    [],
  )
  const openSidebarSearch = useCallback((projectPath?: string) => {
    sessionSearch.current?.open(projectPath)
  }, [])
  const cycleChat = useCallback(
    (direction: -1 | 1) => {
      const sessions = projectsRef.current.flatMap((project) => project.sessions)
      if (sessions.length === 0) return
      const activeId = activeIdRef.current
      const current = activeId ? sessions.findIndex((session) => session.id === activeId) : -1
      const nextIndex =
        current < 0
          ? direction > 0
            ? 0
            : sessions.length - 1
          : (current + direction + sessions.length) % sessions.length
      const next = sessions[nextIndex]
      if (next) void selectSession(next.id)
    },
    [selectSession],
  )
  const selectSessionSearchResult = useCallback(
    (threadId: string, turnId?: string) => {
      setSearchJump((current) =>
        turnId
          ? {
              threadId,
              turnId,
              request: (current?.request ?? 0) + 1,
            }
          : undefined,
      )
      void selectSession(threadId)
    },
    [selectSession],
  )
  const openSettings = useCallback((section: SettingsSection = 'providers') => {
    setSettingsSection(section)
    setSettingsOpen(true)
  }, [])
  const changeKeybinding = useCallback((action: KeybindingId, shortcut: Shortcut | null) => {
    setKeybindings((current) => {
      const next = { ...current, [action]: shortcut }
      writeKeybindings(next)
      return next
    })
  }, [])
  const resetKeybindings = useCallback(() => {
    const defaults = createDefaultKeybindings()
    writeKeybindings(defaults)
    setKeybindings(defaults)
  }, [])
  const openProviderSetup = useCallback(() => {
    refreshCatalog()
    openSettings('providers')
  }, [refreshCatalog, openSettings])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const resetSettings = useCallback(() => {
    cancelWorkspacePanelWidthPersistence()
    localStorage.clear()
    location.reload()
  }, [cancelWorkspacePanelWidthPersistence])
  const changeModelVisibility = useCallback((key: string, visible: boolean) => {
    // A click is an explicit preference even if live discovery is still
    // replacing a cached catalog. Never let late first-run defaults erase it.
    modelVisibilityInitialized.current = true
    setHiddenModels((current) => {
      const next = new Set(current)
      if (visible) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  const closePalette = useCallback(() => {
    setPaletteScope(null)
    setPreferredNewThreadProject(undefined)
  }, [])
  const toggleRail = useCallback(() => setCollapsed((current) => !current), [])
  const openRollback = useCallback(() => {
    setRollbackInspection(undefined)
    setRollbackOpen(true)
  }, [])
  const prepareBottomTerminal = useCallback(() => {
    // Loading follows intent instead of a launch timer. A closed app pays no
    // xterm parse, DOM, worker, or GPU cost, while hover/focus still gets a
    // head start before the click that mounts the terminal.
    void loadTerminalPane().catch(() => undefined)
  }, [])
  const toggleTerminal = useCallback(() => {
    setBottomTerminalHasMounted(true)
    setBottomTerminalPhase((phase) =>
      phase === 'closed' || phase === 'closing' ? 'opening' : 'closing',
    )
  }, [])
  const toggleDefaultTerminal = useCallback(() => {
    if (terminalPlacement === 'workspace') {
      if (!activePath) return
      setWorkspacePanelHasMounted(true)
      setWorkspaceTerminalToggleRequest((request) => request + 1)
      return
    }
    if (!activePath) return
    toggleTerminal()
  }, [activePath, terminalPlacement, toggleTerminal])
  const closeTerminal = useCallback(() => {
    setBottomTerminalPhase((phase) => (phase === 'opening' || phase === 'open' ? 'closing' : phase))
  }, [])
  const finishBottomTerminalMotion = useCallback((event: ReactTransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== 'transform') return
    setBottomTerminalPhase((phase) => (phase === 'closing' ? 'closed' : phase))
  }, [])
  const prepareWorkspacePanel = useCallback(() => {
    void loadWorkspacePanel().catch(() => undefined)
  }, [])
  const openWorkspacePanel = useCallback(() => {
    setWorkspacePanelHasMounted(true)
    setWorkspacePanelOpen(true)
  }, [])
  const closeWorkspacePanel = useCallback(() => {
    setWorkspacePanelOpen(false)
    setWorkspacePanelExpanded(false)
  }, [])
  const openProviderLoginTerminal = useCallback(
    (target: ProviderLoginTerminalTarget) => {
      setWorkspacePanelHasMounted(true)
      setProviderLoginTerminal({
        ...target,
        id: nextProviderLoginTerminalId.current++,
        visible: true,
        restorePanelOpen: workspacePanelOpen,
        restorePanelExpanded: workspacePanelExpanded,
        restoreSettings: settingsOpen,
      })
      setSettingsOpen(false)
      setWorkspacePanelOpen(true)
      setWorkspacePanelExpanded(true)
    },
    [settingsOpen, workspacePanelExpanded, workspacePanelOpen],
  )
  const closeProviderLoginTerminal = useCallback(
    (id: number) => {
      if (!providerLoginTerminal || providerLoginTerminal.id !== id) return
      setProviderLoginTerminal(
        providerLoginState?.phase === 'running'
          ? { ...providerLoginTerminal, visible: false }
          : undefined,
      )
      setWorkspacePanelOpen(providerLoginTerminal.restorePanelOpen)
      setWorkspacePanelExpanded(providerLoginTerminal.restorePanelExpanded)
      if (providerLoginTerminal.restoreSettings) {
        setSettingsSection('providers')
        setSettingsOpen(true)
      }
    },
    [providerLoginState?.phase, providerLoginTerminal],
  )
  const toggleWorkspacePanel = useCallback(() => {
    if (workspacePanelOpen) setWorkspacePanelExpanded(false)
    else setWorkspacePanelHasMounted(true)
    setWorkspacePanelOpen((open) => !open)
  }, [workspacePanelOpen])
  const toggleExpandedWorkspacePanel = useCallback(() => {
    if (!workspacePanelOpen) {
      setWorkspacePanelHasMounted(true)
      setWorkspacePanelOpen(true)
      setWorkspacePanelExpanded(true)
      return
    }
    setWorkspacePanelExpanded((expanded) => !expanded)
  }, [workspacePanelOpen])
  const toggleFastMode = useCallback(() => {
    const model = selectedModelChoice?.model
    const fast = getFastServiceTier(model)
    if (!fast) return
    setServiceTier((current) => (current === fast.id ? getFastModeOffValue(model) : fast.id))
  }, [selectedModelChoice])
  const active = useMemo(() => findSession(projects, activeId), [projects, activeId])
  const activeProject = useMemo(
    () => projects.find((project) => project.path === activePath),
    [projects, activePath],
  )
  const keybindingActions = useMemo<Record<KeybindingId, () => void>>(
    () => ({
      commandPalette: () => {
        setSettingsOpen(false)
        setPaletteScope('all')
      },
      settings: () => {
        setPaletteScope(null)
        openSettings('providers')
      },
      keybindings: () => {
        setPaletteScope(null)
        openSettings('keybinds')
      },
      toggleSidebar: toggleRail,
      newChat: startNewChat,
      searchSessions: () => {
        setPaletteScope(null)
        sessionSearch.current?.open()
      },
      focusComposer: () => {
        if (!activePath) return
        setPaletteScope(null)
        setComposerFocusRequest((request) => request + 1)
      },
      interrupt: () => {
        if (thread.running) interrupt()
      },
      previousChat: () => cycleChat(-1),
      nextChat: () => cycleChat(1),
      toggleSessionPin: () => {
        if (activeId) toggleSidebarSessionPin(activeId)
      },
      archiveSession: () => {
        if (activeId) deleteSidebarSession(activeId)
      },
      rollback: () => {
        if (activeId && checkpoints.length > 0) openRollback()
      },
      switchProject: () => {
        setSettingsOpen(false)
        setPaletteScope('projects')
      },
      newProject: () => void addProject(),
      openPullRequests,
      toggleTerminal: toggleDefaultTerminal,
      toggleWorkspace: () => {
        if (activePath) toggleWorkspacePanel()
      },
      expandWorkspace: () => {
        if (activePath) toggleExpandedWorkspacePanel()
      },
      toggleFastMode,
      toggleDesignMode: () => {
        if (!thread.running) setDesignMode((enabled) => !enabled)
      },
      toggleIsolatedSession: () => {
        if (!activeId) setIsolateSession((enabled) => !enabled)
      },
    }),
    [
      activeId,
      activePath,
      addProject,
      checkpoints.length,
      cycleChat,
      deleteSidebarSession,
      interrupt,
      openPullRequests,
      openRollback,
      openSettings,
      startNewChat,
      thread.running,
      toggleExpandedWorkspacePanel,
      toggleFastMode,
      toggleRail,
      toggleSidebarSessionPin,
      toggleDefaultTerminal,
      toggleWorkspacePanel,
    ],
  )

  useEffect(() => syncNativeMenuShortcuts(keybindings), [keybindings])

  useEffect(() => onNativeMenuAction((action) => keybindingActions[action]()), [keybindingActions])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return

      // Settings owns all keys while open. Its two app shortcuts can close
      // the sheet or jump directly to the keybind editor.
      if (settingsOpen) {
        if (matchesShortcut(event, keybindings.settings)) {
          event.preventDefault()
          setSettingsOpen(false)
        } else if (matchesShortcut(event, keybindings.keybindings)) {
          event.preventDefault()
          setSettingsSection('keybinds')
        }
        return
      }
      if (paletteScope || rollbackOpen || checkoutDelete) return

      // Number keys open the newest sessions in the first sidebar project.
      const primaryOnly = macOS ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (primaryOnly && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
        const currentProjects = projectsRef.current
        const project = currentProjects.find((candidate) => candidate.pinned) ?? currentProjects[0]
        const session = project?.sessions
          .slice()
          .sort((left, right) => right.createdAt - left.createdAt)[Number(event.key) - 1]
        event.preventDefault()
        if (session) void selectSession(session.id)
        return
      }

      const definition = KEYBINDING_DEFINITIONS.find((candidate) =>
        matchesShortcut(event, keybindings[candidate.id]),
      )
      if (!definition) return

      event.preventDefault()
      keybindingActions[definition.id]()
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    checkoutDelete,
    keybindingActions,
    keybindings,
    macOS,
    paletteScope,
    rollbackOpen,
    selectSession,
    settingsOpen,
  ])

  const sideChatParentStatus: SideChatParentStatus =
    thread.approvals.length > 0
      ? 'approval'
      : thread.userInputs.length > 0
        ? 'input'
        : thread.running
          ? 'working'
          : thread.items.at(-1)?.type === 'error'
            ? 'failed'
            : 'idle'
  const sideChatStartOptions = useMemo<SideChatStartOptions>(
    () => ({
      ...(selectedModelChoice?.model.id
        ? {
            model: selectedModelChoice?.model.id,
          }
        : {}),
      ...(selectedEffort ? { effort: selectedEffort } : {}),
      ...(selectedServiceTier ? { serviceTier: selectedServiceTier } : {}),
      approval: approval === 'auto-review' && !autoReviewSupported ? 'ask' : approval,
    }),
    [
      selectedModelChoice?.model.id,
      selectedEffort,
      selectedServiceTier,
      approval,
      autoReviewSupported,
    ],
  )
  const paletteChatSearch = useMemo(
    () =>
      createPaletteChatSearch(
        () => projectsRef.current,
        displayName,
        (threadId) => void selectSession(threadId),
        PALETTE_CHAT_SEARCH_CACHE,
      ),
    [selectSession],
  )
  const commands = useMemo<PaletteCommand[]>(() => {
    if (!paletteScope) return EMPTY_PALETTE_COMMANDS
    const keybind = (id: KeybindingId) => {
      const shortcut = keybindings[id]
      return shortcut ? shortcutLabel(shortcut, macOS) : undefined
    }
    return [
      {
        id: 'search-sessions',
        title: 'Search all chats',
        detail: 'Titles, messages, commands, and tool output across projects',
        group: 'Actions',
        shortcut: keybind('searchSessions'),
        run: () => {
          sessionSearch.current?.open()
        },
      },
      {
        id: 'new-chat',
        title: 'New chat',
        detail: activePath ? `Start in ${basename(activePath)}` : 'Choose a project folder',
        group: 'Actions',
        keywords: 'session conversation',
        shortcut: keybind('newChat'),
        run: startNewChat,
      },
      {
        id: 'switch-project',
        title: 'Switch project…',
        detail: 'Choose another workspace',
        group: 'Actions',
        keywords: 'folder workspace',
        shortcut: keybind('switchProject'),
        run: () => setPaletteScope('projects'),
      },
      {
        id: 'new-project',
        title: 'New project',
        detail: 'Add a folder to the sidebar',
        group: 'Actions',
        keywords: 'add open folder workspace',
        projectCommand: true,
        shortcut: keybind('newProject'),
        run: () => void addProject(),
      },
      ...(activePath
        ? [
            {
              id: 'focus-composer',
              title: 'Focus composer',
              detail: 'Move the cursor to your prompt',
              group: 'Actions' as const,
              keywords: 'prompt message type',
              shortcut: keybind('focusComposer'),
              run: () => setComposerFocusRequest((request) => request + 1),
            },
          ]
        : []),
      {
        id: 'toggle-sidebar',
        title: collapsed ? 'Show sidebar' : 'Hide sidebar',
        group: 'Actions',
        keywords: 'rail navigation',
        shortcut: keybind('toggleSidebar'),
        run: () => setCollapsed((current) => !current),
      },
      {
        id: 'open-settings',
        title: 'Settings',
        detail: 'General, appearance, keybinds, providers, and data',
        group: 'Actions',
        shortcut: keybind('settings'),
        run: () => openSettings(),
      },
      {
        id: 'keyboard-shortcuts',
        title: 'Keybinds',
        detail: 'View and customize every app keybind',
        group: 'Actions',
        keywords: 'help keyboard shortcuts hotkeys key bindings',
        shortcut: keybind('keybindings'),
        run: () => openSettings('keybinds'),
      },
      {
        id: 'open-pull-requests',
        title: 'Pull requests',
        detail: 'Open the pull request inbox',
        group: 'Actions',
        keywords: 'github prs review',
        shortcut: keybind('openPullRequests'),
        run: openPullRequests,
      },
      ...(activeId || activePath
        ? [
            {
              id: 'toggle-terminal',
              title:
                terminalPlacement === 'workspace'
                  ? 'Toggle right sidebar terminal'
                  : terminalOpen
                    ? 'Hide terminal'
                    : 'Show terminal',
              detail: terminalPlacement === 'workspace' ? 'Right sidebar' : 'Bottom panel',
              group: 'Actions' as const,
              keywords: 'console shell',
              shortcut: keybind('toggleTerminal'),
              run: toggleDefaultTerminal,
            },
          ]
        : []),
      ...(activeId
        ? [
            {
              id: 'toggle-chat-pin',
              title: active?.session.pinned ? 'Unpin current chat' : 'Pin current chat',
              group: 'Actions' as const,
              shortcut: keybind('toggleSessionPin'),
              run: () => toggleSidebarSessionPin(activeId),
            },
            ...(thread.running
              ? [
                  {
                    id: 'stop-response',
                    title: 'Stop response',
                    group: 'Actions' as const,
                    shortcut: keybind('interrupt'),
                    run: interrupt,
                  },
                ]
              : []),
            ...(checkpoints.length > 0
              ? [
                  {
                    id: 'open-restore-points',
                    title: 'Restore points',
                    detail: 'Review chat checkpoints',
                    group: 'Actions' as const,
                    shortcut: keybind('rollback'),
                    run: openRollback,
                  },
                ]
              : []),
          ]
        : []),
      ...(activePath
        ? [
            {
              id: 'toggle-workspace',
              title: workspacePanelOpen ? 'Hide workspace tools' : 'Show workspace tools',
              detail: 'Files, review, browser, and side chat',
              group: 'Actions' as const,
              shortcut: keybind('toggleWorkspace'),
              run: toggleWorkspacePanel,
            },
          ]
        : []),
      ...projectChoices.map((project): PaletteCommand => ({
        id: `project-${encodeURIComponent(project.path)}`,
        title: displayName(project),
        detail: project.path,
        group: 'Projects',
        keywords: 'switch folder workspace',
        projectCommand: true,
        run: () => selectProject(project.path),
      })),
      ...projectChoices.map((project): PaletteCommand => ({
        id: `new-chat-${encodeURIComponent(project.path)}`,
        title: `New thread in ${displayName(project)}`,
        detail: project.path,
        group: 'Projects',
        keywords: 'session conversation',
        newThreadProject: true,
        run: () => beginSession(project.path),
      })),
    ]
  }, [
    paletteScope,
    activePath,
    startNewChat,
    addProject,
    openSettings,
    openPullRequests,
    active?.session.pinned,
    activeId,
    collapsed,
    checkpoints.length,
    interrupt,
    keybindings,
    macOS,
    projectChoices,
    selectProject,
    beginSession,
    terminalOpen,
    terminalPlacement,
    thread.running,
    toggleSidebarSessionPin,
    toggleDefaultTerminal,
    toggleWorkspacePanel,
    workspacePanelOpen,
  ])

  const RenderedTerminalPane = resolvedTerminalPane ?? TerminalPane
  const RenderedWorkspacePanel = resolvedWorkspacePanel ?? WorkspacePanel

  return (
    <div
      className={`shell ${collapsed ? 'is-narrow' : ''}${isDesktop && macOS ? ' is-macos' : ''}`}
      style={shellStyle(railWidth)}
    >
      <TitleBar collapsed={collapsed} keybindings={keybindings} onToggleRail={toggleRail} />
      {surface === 'chat' ? (
        <PanelToggles
          projectPath={activePath}
          terminalOpen={terminalOpen}
          workspacePanelOpen={workspacePanelOpen}
          terminalShortcutActive={terminalPlacement === 'bottom'}
          keybindings={keybindings}
          onPrepareTerminal={prepareBottomTerminal}
          onPrepareWorkspace={prepareWorkspacePanel}
          onToggleWorkspace={workspacePanelOpen ? closeWorkspacePanel : openWorkspacePanel}
          onToggleTerminal={toggleTerminal}
        />
      ) : null}
      {isDesktop ? <ZoomHud /> : null}

      <div className="shell__body">
        <Sidebar
          projects={archiveProjects}
          activeProjectPath={activePath}
          activeSessionId={surface === 'chat' ? activeId : undefined}
          pullRequestsActive={surface === 'pull-requests'}
          providerName={providerName(provider, acpAgentName)}
          keybindings={keybindings}
          usageStates={usageState}
          onRetryUsage={refreshUsage}
          onConsumeReset={consumeReset}
          mode={sidebarSettings.mode}
          inbox={sidebarInbox}
          collapsed={collapsed}
          width={railWidth}
          account={account}
          profileIdentity={profileIdentity}
          onClose={closeSidebar}
          onWidthChange={resizeSidebar}
          onAddProject={addSidebarProject}
          onAddDroppedProjects={addDroppedSidebarProjects}
          onNewSession={startSidebarSession}
          onSelectSession={selectSidebarSession}
          onRenameProject={renameSidebarProject}
          onRemoveProject={removeSidebarProject}
          onTogglePin={toggleSidebarProjectPin}
          onRenameSession={renameSidebarSession}
          onToggleSessionPin={toggleSidebarSessionPin}
          onDeleteSession={deleteSidebarSession}
          onArchiveProject={archiveSidebarProject}
          onReorderProject={reorderSidebarProject}
          onReorderSession={reorderSidebarSession}
          onOpenSearch={openSidebarSearch}
          onOpenPullRequests={openPullRequests}
          onOpenSettings={openSettings}
        />

        <div
          className={`workspace-layout${workspacePanelOpen ? ' is-panel-open' : ''}${workspacePanelExpanded ? ' is-panel-expanded' : ''}`}
          style={workspaceLayoutStyle(workspacePanelWidth)}
        >
          <main className="stage">
            {surface === 'pull-requests' ? (
              <Suspense fallback={null}>
                <PullRequestsView
                  transport={transport}
                  onOpenChat={openPullRequestChat}
                  onSetupTerminalOpen={openProviderLoginTerminal}
                  setupRefreshRevision={pullRequestSetupRefreshRevision}
                />
              </Suspense>
            ) : (
              <>
                <StageHeader
                  sessionId={active?.session.id}
                  title={active?.session.title}
                  pinned={active?.session.pinned ?? false}
                  projectPath={activePath}
                  checkpointCount={thread.running ? 0 : checkpoints.length}
                  worktreeBranch={active?.session.worktreeBranch}
                  keybindings={keybindings}
                  menuActions={keybindingActions}
                  onOpenRollback={openRollback}
                  onRenameSession={renameSidebarSession}
                  onToggleSessionPin={toggleSidebarSessionPin}
                  onArchiveSession={deleteSidebarSession}
                />

                <div
                  className={`stage__body${activeId ? '' : ' is-new-session'}${activePath && terminalOpen ? ' has-terminal' : ''}`}
                >
                  <div className={`stage__conversation${activeId ? '' : ' is-new-session'}`}>
                    {activeId ? (
                      <Suspense
                        fallback={
                          <div className="empty" role="status">
                            Loading conversation…
                          </div>
                        }
                      >
                        <LazyThread
                          key={threadEntryKey}
                          frameStore={threadFrameStore}
                          stopping={stopping}
                          loading={loadingThreadId === activeId}
                          projectPath={activePath}
                          threadId={activeId}
                          transport={transport}
                          searchJump={searchJump?.threadId === activeId ? searchJump : undefined}
                          revealRequest={threadRevealRequest}
                          checkpoints={checkpoints}
                          onDecide={decideApproval}
                          onAnswerUserInput={answerUserInput}
                          onEditMessage={editMessage}
                          onRevertCheckpoint={revertCheckpoint}
                          onUndoChanges={undoTurnChanges}
                        />
                      </Suspense>
                    ) : (
                      <Empty
                        projects={projects}
                        activePath={activePath}
                        status={projectsStatus}
                        onAddProject={addSidebarProject}
                        onRetry={retryProjects}
                      />
                    )}

                    <Composer
                      transport={transport}
                      provider={provider}
                      projects={projectChoices}
                      projectPath={activePath}
                      projectName={activeProject ? displayName(activeProject) : undefined}
                      branch={
                        (!activeId && activePath
                          ? projectBranches.current.get(activePath)
                          : undefined) ??
                        active?.session.worktreeBranch ??
                        workspace?.branch ??
                        branches[0]
                      }
                      branches={branches}
                      models={selectableModels}
                      modelsLoaded={modelsLoaded}
                      modelId={selectedModelChoice?.key}
                      effort={selectedEffort}
                      serviceTier={selectedServiceTier}
                      usage={thread.usage}
                      approval={
                        approval === 'auto-review' && !autoReviewSupported ? 'ask' : approval
                      }
                      autoReviewSupported={autoReviewSupported}
                      attachmentsSupported={attachmentsSupported}
                      voiceAvailable={isDesktop && provider === 'codex' && voiceAvailable}
                      disabled={stopping}
                      sendAvailability={sendAvailability}
                      running={visibleRunning}
                      newSession={!activeId}
                      isolate={active?.session.worktreeBranch ? true : isolateSession}
                      designMode={designMode}
                      keybindings={keybindings}
                      focusRequest={composerFocusRequest}
                      draftRequest={composerDraft}
                      onDraftChange={updateComposerDraftText}
                      onAttachmentsChange={updateComposerDraftAttachments}
                      onResourcesChange={updateComposerDraftResources}
                      onReady={handleComposerReady}
                      queuedTurns={queuedTurns}
                      canSteerQueue={canSteerQueue}
                      onModelChange={selectModel}
                      onEffortChange={setEffort}
                      onServiceTierChange={setServiceTier}
                      onApprovalChange={changeApproval}
                      onIsolateChange={setIsolateSession}
                      onDesignModeChange={setDesignMode}
                      onTranscribeVoice={transcribeVoice}
                      onCancelVoice={cancelVoice}
                      onProjectChange={selectProject}
                      onBranchChange={changeBranch}
                      onProjectRequired={requireProject}
                      onSetupProvider={openProviderSetup}
                      onSend={sendTurn}
                      onSteer={steerTurn}
                      onInterrupt={interrupt}
                      stopping={stopping}
                      onDeleteQueuedTurn={deleteQueuedTurn}
                      onMoveQueuedTurn={moveQueuedTurn}
                      onSteerQueuedTurn={steerQueuedTurn}
                    />
                  </div>

                  {activePath && bottomTerminalMounted ? (
                    <div
                      className={`bottom-terminal${terminalOpen ? ' is-open' : ''}${bottomTerminalPhase === 'closing' ? ' is-closing' : ''}${bottomTerminalPhase === 'closed' ? ' is-parked' : ''}`}
                      style={{ height: terminalHeight }}
                      data-testid="bottom-terminal"
                      aria-hidden={bottomTerminalPhase === 'closed' ? true : undefined}
                      inert={
                        bottomTerminalPhase === 'closing' || bottomTerminalPhase === 'closed'
                          ? true
                          : undefined
                      }
                      onTransitionEnd={finishBottomTerminalMotion}
                    >
                      <Suspense fallback={null}>
                        {active ? (
                          <RenderedTerminalPane
                            key={`thread:${active.session.id}`}
                            transport={transport}
                            threadId={active.session.id}
                            height={terminalHeight}
                            theme={themeColorScheme}
                            active={terminalOpen}
                            onHeightChange={setTerminalHeight}
                            onClose={closeTerminal}
                          />
                        ) : (
                          <RenderedTerminalPane
                            key={`project:${activePath}`}
                            transport={transport}
                            projectPath={activePath}
                            height={terminalHeight}
                            theme={themeColorScheme}
                            active={terminalOpen}
                            onHeightChange={setTerminalHeight}
                            onClose={closeTerminal}
                          />
                        )}
                      </Suspense>
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </main>

          {workspacePanelHasMounted ? (
            <Suspense fallback={null}>
              <RenderedWorkspacePanel
                open={workspacePanelOpen}
                expanded={workspacePanelExpanded}
                width={workspacePanelWidth}
                transport={transport}
                threadId={activeId}
                projectPath={activePath}
                projectName={activeProject ? displayName(activeProject) : undefined}
                branch={active?.session.worktreeBranch ?? workspace?.branch ?? branches[0]}
                theme={themeColorScheme}
                sideChatParentStatus={sideChatParentStatus}
                sideChatStartOptions={sideChatStartOptions}
                sideChatPromptRequest={sideChatPromptRequest}
                nativeSurfacesVisible={
                  !settingsOpen && paletteScope === null && !rollbackOpen && !checkoutDelete
                }
                onOpen={openWorkspacePanel}
                onClose={closeWorkspacePanel}
                onExpandedChange={setWorkspacePanelExpanded}
                onWidthChange={setWorkspacePanelWidth}
                terminalToggleRequest={workspaceTerminalToggleRequest}
                externalToolRequest={workspaceToolRequest}
                designPreviewRequest={workspaceDesignPreviewRequest}
                providerLogin={
                  providerLoginTerminal?.visible
                    ? {
                        id: providerLoginTerminal.id,
                        title: `${providerLoginTerminal.displayName} ${providerLoginTerminal.operation === 'install' ? 'install' : 'login'}`,
                        installKey: providerLoginTerminal.installKey,
                        showCodeInput: providerLoginTerminal.operation !== 'install',
                      }
                    : undefined
                }
                onProviderLoginClose={closeProviderLoginTerminal}
              />
            </Suspense>
          ) : null}
        </div>
      </div>

      {settingsOpen ? (
        <Suspense fallback={null}>
          <Settings
            initialSection={settingsSection}
            provider={provider}
            providerName={providerName(provider, acpAgentName)}
            transport={transport}
            projectPath={activePath}
            projectName={activeProject ? displayName(activeProject) : undefined}
            account={account}
            profileIdentity={profileIdentity}
            onProfileIdentityChange={updateProfileIdentity}
            providerStatuses={providerStatuses}
            acpAgents={acpAgents}
            modelConnections={modelConnections}
            models={rosterModels}
            hiddenModels={hiddenModels}
            onModelVisibilityChange={changeModelVisibility}
            onConnectionsChanged={refreshCatalog}
            projectCount={projects.length}
            sidebarSettings={sidebarSettings}
            onSidebarSettingsChange={updateSidebarSettings}
            themePreference={themePreference}
            onThemePreferenceChange={setThemePreference}
            fontPreference={fontPreference}
            onFontPreferenceChange={setFontPreference}
            accentPreference={accentPreference}
            onAccentPreferenceChange={setAccentPreference}
            backdropPreference={backdropPreference}
            onBackdropPreferenceChange={setBackdropPreference}
            sidebarGlass={sidebarGlass}
            onSidebarGlassChange={setSidebarGlass}
            showMacOSFontSmoothing={macOS}
            macOSFontSmoothing={macOSFontSmoothing}
            onMacOSFontSmoothingChange={setMacOSFontSmoothing}
            macOS={macOS}
            keybindings={keybindings}
            onKeybindingChange={changeKeybinding}
            onKeybindingsReset={resetKeybindings}
            showMacOSHaptics={isDesktop && macOS}
            onAccountChange={handleAccountChange}
            authRefreshRevision={providerAuthRefreshRevision}
            onProviderLoginTerminalOpen={openProviderLoginTerminal}
            onReset={resetSettings}
            onClose={closeSettings}
          />
        </Suspense>
      ) : null}

      {isDesktop &&
      projectsStatus === 'ready' &&
      projects.length === 0 &&
      !onboardingDismissed &&
      !settingsOpen ? (
        <Suspense fallback={null}>
          <WelcomeDialog
            providerStatuses={providerStatuses}
            onAddProject={() => void addProject()}
            onOpenProviders={() => openSettings('providers')}
            onDismiss={() => {
              writeSetting(ONBOARDING_KEY, 'done')
              setOnboardingDismissed(true)
            }}
          />
        </Suspense>
      ) : null}

      {paletteScope ? (
        <Suspense fallback={null}>
          <CommandPalette
            commands={commands}
            scope={paletteScope}
            deferredSearch={paletteChatSearch}
            preferredCommandId={
              paletteScope === 'new-thread' && preferredNewThreadProject
                ? `new-chat-${encodeURIComponent(preferredNewThreadProject)}`
                : undefined
            }
            onClose={closePalette}
          />
        </Suspense>
      ) : null}

      <SessionSearchHost
        ref={sessionSearch}
        transport={transport}
        projects={projects}
        onSelect={selectSessionSearchResult}
      />

      {rollbackOpen ? (
        <Suspense fallback={null}>
          <RollbackDialog
            checkpoints={checkpoints}
            inspection={rollbackInspection}
            loadingId={rollbackLoadingId}
            restoring={rollbackRestoring}
            onInspect={(checkpoint) => void inspectCheckpoint(checkpoint)}
            onRestore={() => void restoreCheckpoint()}
            onClose={() => {
              setRollbackOpen(false)
              setRollbackInspection(undefined)
            }}
          />
        </Suspense>
      ) : null}

      {checkoutDelete ? (
        <Suspense fallback={null}>
          <CheckoutDiscardDialog
            title={checkoutDelete.title}
            branch={checkoutDelete.branch}
            busy={checkoutDeleteBusy}
            onDiscard={() => void discardAndArchive()}
            onClose={() => setCheckoutDelete(undefined)}
          />
        </Suspense>
      ) : null}

      {/* A dropped connection used to be invisible: requests queued, pushes
          stopped, the working rail kept counting, and nothing said why. */}
      <ProviderUpdateNotice
        transport={transport}
        onUpdated={refreshCatalog}
        suppressed={offline || Boolean(notice)}
      />
      {pendingArchives.length > 0 ? (
        <Suspense fallback={null}>
          <ArchiveToast
            count={pendingArchives.length}
            visible={!archiveToastDismissed}
            onView={() => {
              const id = pendingArchives.at(-1)
              if (id) void selectSession(id)
            }}
            onUndo={undoArchive}
            onDismiss={() => setArchiveToastDismissed(true)}
          />
        </Suspense>
      ) : null}
      <NoticePresence className="notice notice--offline" role="status" visible={offline}>
        <LoaderCircle className="spinner" size={12} aria-hidden />
        <span className="notice__text">Reconnecting to the server…</span>
      </NoticePresence>

      <NoticePresence
        className={`notice${undoRestore || notice === 'Restore undone.' ? ' notice--success' : ''}`}
        role="alert"
        visible={Boolean(notice)}
      >
        <span className="notice__text">{notice}</span>
        {undoRestore ? (
          <button className="ghost" onClick={() => void reverseRestore()}>
            Undo restore
          </button>
        ) : null}
        <button
          className="ghost"
          onClick={() => {
            setNotice(undefined)
            setUndoRestore(undefined)
          }}
        >
          Dismiss
        </button>
      </NoticePresence>
    </div>
  )
}

function readRailWidth(): number {
  const stored = Number(readSetting(RAIL_WIDTH_KEY))
  if (stored === 248 || stored === 276) return DEFAULT_RAIL_WIDTH
  return Number.isFinite(stored) && stored >= 176 && stored <= 420 ? stored : DEFAULT_RAIL_WIDTH
}

function Empty(props: {
  projects: Project[]
  activePath: string | undefined
  status: 'loading' | 'ready' | 'failed'
  onAddProject: () => void
  onRetry: () => void
}) {
  const activeProject = props.projects.find((project) => project.path === props.activePath)

  // Before the first projects.list reply, "no projects" is not a fact yet —
  // flashing the add-a-project prompt for one round trip reads as a glitch.
  if (props.status === 'loading') {
    return (
      <div className="empty" role="status">
        <div className="empty__prompt">Loading projects…</div>
      </div>
    )
  }

  if (props.status === 'failed') {
    return (
      <div className="empty">
        <div className="empty__prompt" role="heading" aria-level={1}>
          Projects could not be loaded.
        </div>
        <button className="btn" type="button" onClick={props.onRetry}>
          Retry
        </button>
      </div>
    )
  }

  if (props.projects.length === 0) {
    return (
      <div className="empty">
        <div className="empty__prompt" role="heading" aria-level={1}>
          Add a project to start building.
        </div>
        <button className="btn" type="button" onClick={props.onAddProject}>
          Add project
        </button>
      </div>
    )
  }

  return (
    <div className="empty">
      <div className="empty__prompt" role="heading" aria-level={1}>
        What should we build in {activeProject ? displayName(activeProject) : 'a project'}?
      </div>
    </div>
  )
}

function providerName(id: ProviderId, sourceName?: string): string {
  if (sourceName) return sourceName
  // ACP is how we talk to the agent, not who the agent is. Showing "ACP" would
  // name our plumbing instead of the thing the user chose.
  if (id === 'acp') return 'ACP agent'
  return providerDisplayName(id)
}

/**
 * A finished design run — built, failed, or rejected — releases the toggle,
 * so the next prompt in the thread is a normal turn instead of restarting
 * the whole design flow from scratch.
 */
function endsDesignBriefing(event: DomainEvent): boolean {
  if (event.type === 'thread.error') return event.message.startsWith('Design mode failed')
  if (event.type !== 'item.completed' || event.item.role !== 'assistant') return false
  const text = event.item.text ?? ''
  return (
    text.trim() ===
      'Design mode was turned off because this request is not a website design task.' ||
    text.startsWith('Website built.') ||
    text.includes('DEBUG FINISHED · NO WEBSITE BUILT')
  )
}

function affectsSessionStatus(event: DomainEvent): boolean {
  return (
    event.type === 'turn.started' ||
    event.type === 'turn.completed' ||
    event.type === 'approval.requested' ||
    event.type === 'approval.resolved' ||
    event.type === 'thread.error'
  )
}

function statusFor(
  state: ThreadState,
  event: DomainEvent,
  background: boolean,
): Project['sessions'][number]['status'] {
  if (event.type === 'thread.error') return 'failed'
  if (event.type === 'turn.completed')
    return event.status === 'failed' ? 'failed' : background ? 'ready' : 'idle'
  if (state.approvals.length > 0) return 'approval'
  return state.running ? 'working' : 'idle'
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function readTerminalHeight(): number {
  const stored = Number(readSetting(TERMINAL_HEIGHT_KEY))
  const height = Number.isFinite(stored) && stored >= 160 ? stored : 260
  return Math.min(height, Math.max(160, Math.floor(window.innerHeight * 0.72)))
}

function readWorkspacePanelWidth(): number {
  const stored = Number(readSetting(WORKSPACE_PANEL_WIDTH_KEY))
  if (!Number.isFinite(stored) || stored < 360) return 520
  return Math.min(stored, Math.max(360, Math.floor(window.innerWidth * 0.78)))
}

function displayName(project: { path: string; name?: string | undefined }): string {
  return project.name ?? basename(project.path)
}

/** The first thing a user types is the best title we get for free. */
function titleFrom(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  return clean.length > 40 ? `${clean.slice(0, 40)}…` : clean
}

/**
 * Applied locally as well as sent to the server, so the rail updates as the
 * message is sent rather than a round trip later.
 */
function renameSession(projects: Project[], threadId: string, title: string): Project[] {
  return updateSession(projects, threadId, (session) =>
    session.title === title ? session : { ...session, title },
  )
}

function loadProjectOrder(): string[] {
  return parseStoredProjectOrder(readSetting(PROJECT_ORDER_KEY))
}

let lastSavedProjectOrder: string[] | undefined

function saveProjectOrder(projects: Project[]): void {
  if (lastSavedProjectOrder?.length === projects.length) {
    let unchanged = true
    for (let index = 0; index < projects.length; index += 1) {
      if (lastSavedProjectOrder[index] !== projects[index]?.path) {
        unchanged = false
        break
      }
    }
    if (unchanged) return
  }

  lastSavedProjectOrder = projects.map((project) => project.path)
  writeSetting(PROJECT_ORDER_KEY, JSON.stringify(lastSavedProjectOrder))
}

function loadSessionOrder() {
  return parseStoredSessionOrder(readSetting(SESSION_ORDER_KEY))
}

const serializeSessionOrder = createSessionOrderSerializer()

function saveSessionOrder(projects: Project[]): void {
  const serialized = serializeSessionOrder(projects)
  if (serialized === undefined) return
  writeSetting(SESSION_ORDER_KEY, serialized)
}

type SourceSelection = {
  modelKey: string
  effort?: string
  serviceTier?: string
}

type ApprovalPreferences = Partial<Record<ProviderId, ApprovalMode>>

function readApprovalPreferences(activeProvider: ProviderId) {
  const preferences: ApprovalPreferences = {}
  try {
    const stored: unknown = JSON.parse(readSetting(APPROVAL_BY_PROVIDER_KEY) ?? '{}')
    if (isRecord(stored)) {
      for (const [storedProvider, mode] of Object.entries(stored)) {
        if (isProviderId(storedProvider) && isApprovalMode(mode)) {
          preferences[storedProvider] = mode
        }
      }
    }
  } catch {
    // A malformed map should not discard the valid preference from older versions.
  }

  if (preferences[activeProvider] === undefined) {
    const legacy = readSetting(APPROVAL_KEY)
    if (isApprovalMode(legacy)) preferences[activeProvider] = legacy
  }
  return preferences
}

function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === 'ask' || value === 'auto' || value === 'auto-review' || value === 'full'
}

function readSourceSelections(): Record<string, SourceSelection> {
  try {
    const stored: unknown = JSON.parse(readSetting(MODEL_BY_SOURCE_KEY) ?? '{}')
    if (!isRecord(stored)) return {}
    const selections: Array<[string, SourceSelection]> = []
    for (const [source, selection] of Object.entries(stored)) {
      if (
        !isRecord(selection) ||
        typeof selection['modelKey'] !== 'string' ||
        (selection['effort'] !== undefined && typeof selection['effort'] !== 'string') ||
        (selection['serviceTier'] !== undefined && typeof selection['serviceTier'] !== 'string')
      ) {
        return {}
      }
      selections.push([
        source,
        {
          modelKey: selection['modelKey'],
          ...(selection['effort'] !== undefined ? { effort: selection['effort'] } : {}),
          ...(selection['serviceTier'] !== undefined
            ? { serviceTier: selection['serviceTier'] }
            : {}),
        },
      ])
    }
    return Object.fromEntries(selections)
  } catch {
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDER_ID_SET.has(value as ProviderId)
}

/**
 * The versioned catalog cache does not exist on the first launch after this
 * feature ships. Rebuild the one selected entry from existing preferences so
 * that upgrade launch is instant too; the full validated catalog replaces it
 * as soon as discovery finishes.
 */
function readStoredModelChoice(customModels: CustomModel[] = []): ModelChoice | undefined {
  const storedProvider = readSetting(SETUP_KEY)
  const provider = PROVIDER_IDS.find((id) => id === storedProvider)
  if (!provider) return undefined
  const storedKey = readSetting(MODEL_KEY)
  if (!storedKey) return undefined
  // A custom selection survives a cache miss: rebuild its choice straight
  // from the stored entry instead of treating the key as a raw model id.
  if (storedKey.startsWith('custom:')) {
    const custom = customModels.find((entry) => customModelKey(entry) === storedKey)
    if (!custom) return undefined
    return customModelChoice(
      custom,
      providerDisplayName(custom.provider),
      providerMark(custom.provider),
    )
  }
  const storedAgentId = provider !== 'api' ? (readSetting(AGENT_KEY) ?? undefined) : undefined
  const agentId =
    provider === 'acp' || provider === 'pi'
      ? storedAgentId
      : storedAgentId && storedKey.startsWith(`${provider}:${storedAgentId}:`)
        ? storedAgentId
        : undefined
  if ((provider === 'acp' || provider === 'pi') && !agentId) return undefined
  const agentName = agentId ? (readSetting(AGENT_NAME_KEY) ?? agentId) : undefined
  const separator = storedKey.lastIndexOf(':')
  const storedSource = separator > 0 ? storedKey.slice(0, separator) : undefined
  const connectionId =
    provider === 'api' && storedSource?.startsWith('api:')
      ? storedSource.slice('api:'.length)
      : undefined
  if (provider === 'api' && !connectionId) return undefined
  const expectedSource = sourceKey({ provider, connectionId, agentId })
  const canonical = storedKey.startsWith(`${expectedSource}:`)
  if (provider === 'api' && !canonical) return undefined

  let modelId: string
  if (canonical) {
    const encodedModelId = storedKey.slice(expectedSource.length + 1)
    if (!encodedModelId) return undefined
    try {
      modelId = encodedModelId === 'automatic' ? '' : decodeURIComponent(encodedModelId)
    } catch {
      return undefined
    }
  } else {
    // Older builds stored only the raw model id. Keeping this migration path
    // avoids making the very first cache-enabled launch the one slow launch.
    modelId = storedKey
  }
  const key = canonical ? storedKey : modelChoiceKey(expectedSource, modelId)

  const effort = readSetting(EFFORT_KEY) ?? undefined
  const agent = agentId && agentName ? { id: agentId, name: agentName } : undefined
  return {
    key,
    provider,
    sourceName: provider === 'api' ? 'API connection' : providerName(provider, agentName),
    mark: provider === 'acp' && agentId ? agentMark(agentId) : providerMark(provider),
    ...(connectionId ? { connectionId } : {}),
    ...(agent ? { agent } : {}),
    model: {
      id: modelId,
      displayName: modelId || 'Provider default',
      isDefault: true,
      reasoningEfforts: effort ? [effort] : [],
      ...(effort ? { defaultReasoningEffort: effort } : {}),
      serviceTiers: [],
    },
  }
}

/**
 * Skip an initial write only when storage already contains the normalized
 * value. Missing defaults and invalid saved values keep their old self-healing
 * write, while later state transitions stay unconditional. The pending marker
 * also survives Strict Mode's repeated effect setup and delayed writes.
 */
function usePersistedSettingChange(
  key: string,
  value: string | undefined,
  delayMs = 0,
): () => void {
  const [initialStored] = useState(() => readSetting(key))
  const previous = useRef({ key, value })
  const initialPersistencePending = useRef(true)
  const pending = useRef<
    | {
        timeout: number
        persist: () => void
      }
    | undefined
  >(undefined)
  const cancelPending = useCallback(() => {
    const current = pending.current
    if (!current) return
    window.clearTimeout(current.timeout)
    pending.current = undefined
  }, [])
  const flushPending = useCallback(() => {
    const current = pending.current
    if (!current) return
    window.clearTimeout(current.timeout)
    pending.current = undefined
    current.persist()
  }, [])

  useEffect(() => {
    if (delayMs <= 0) return
    window.addEventListener('pagehide', flushPending)
    return () => window.removeEventListener('pagehide', flushPending)
  }, [delayMs, flushPending])

  useEffect(() => {
    const changed = previous.current.key !== key || previous.current.value !== value
    previous.current = { key, value }
    const initial = initialPersistencePending.current
    const serialized = value ?? null
    if (initial ? initialStored === serialized : !changed) {
      initialPersistencePending.current = false
      return
    }

    const persist = () => {
      initialPersistencePending.current = false
      if (value === undefined) removeSetting(key)
      else writeSetting(key, value)
    }
    if (delayMs <= 0) {
      persist()
      return
    }
    const timeout = window.setTimeout(() => {
      if (pending.current?.timeout !== timeout) return
      pending.current = undefined
      persist()
    }, delayMs)
    pending.current = { timeout, persist }
    return () => {
      if (pending.current?.timeout !== timeout) return
      window.clearTimeout(timeout)
      pending.current = undefined
    }
  }, [delayMs, initialStored, key, value])
  return cancelPending
}

/**
 * localStorage writes fail in private windows and at quota — several of ours
 * ran inside layout effects, where an uncaught throw unmounts the whole app.
 * Reads were always defensive; writes get the same courtesy.
 */
function writeSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // A lost preference beats a white screen.
  }
}

/** With site data blocked, merely touching localStorage throws SecurityError —
 *  and most reads run inside useState initializers on first render. */
function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function removeSetting(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // Nothing to lose.
  }
}
