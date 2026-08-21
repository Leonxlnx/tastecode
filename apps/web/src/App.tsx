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
import { LoaderCircle } from 'lucide-react'
import { ProviderIdSchema } from '@harness/contracts'
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
import { z } from 'zod'
import {
  isDesktop,
  isMacOS,
  onNativeMenuAction,
  pickFolder,
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
import { warmHighlighter } from './ui/highlighter.js'
import { IndeterminateRequestError, Transport } from './transport.js'
import {
  activeTurnIsSearching,
  appendUserMessage,
  beginOptimisticTurn,
  createOptimisticMessageId,
  emptyThread,
  reduce,
  reduceDeltas,
  reduceEventLog,
  removeOptimisticMessage,
  type ItemDeltaEvent,
  type ThreadState,
} from './thread-store.js'
import { CommandPalette, type CommandScope, type PaletteCommand } from './ui/CommandPalette.js'
import { CheckoutDiscardDialog } from './ui/CheckoutDiscardDialog.js'
import { Composer, type SendAvailability, type WorkspaceInfo } from './ui/Composer.js'
import {
  getFastModeOffValue,
  getFastServiceTier,
  getNextServiceTierForModel,
} from './ui/ModelSelector.js'
import { RollbackDialog, type Checkpoint } from './ui/RollbackDialog.js'
import { SessionSearchHost, type SessionSearchHandle } from './ui/SessionSearchHost.js'
import { Settings, type SettingsSection } from './ui/Settings.js'
import { Sidebar, type Project } from './ui/Sidebar.js'
import { PanelToggles, StageHeader } from './ui/StageHeader.js'
import { NoticePresence } from './ui/NoticePresence.js'
import { Thread } from './ui/Thread.js'
import { TitleBar } from './ui/TitleBar.js'
import { ZoomHud } from './ui/ZoomHud.js'
import { WelcomeDialog } from './ui/WelcomeDialog.js'
import { serverBaseUrl } from './server-url.js'
import { addDesignBriefing } from './design-agent/briefing.js'
import { sourceSupportsAttachments } from './attachment-capability.js'
import { canCaptureVoice, type VoiceRecording } from './voice-recorder.js'
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
import { parseModelCatalogCache, serializeModelCatalogCache } from './model-catalog-cache.js'
import { parseSideChatCommand } from './side-chat-command.js'
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
/** Stable identity: a fresh [] every render re-renders every thread row. */
const EMPTY_CHECKPOINTS: Checkpoint[] = []
const EMPTY_PALETTE_COMMANDS: PaletteCommand[] = []
const HIDDEN_MODELS_KEY = 'harness.hiddenModels'
const MODEL_VISIBILITY_VERSION_KEY = 'harness.modelVisibilityVersion'
const MODEL_VISIBILITY_VERSION = '3'
const EFFORT_KEY = 'harness.effort'
const SERVICE_TIER_KEY = 'harness.serviceTier'
const APPROVAL_KEY = 'harness.approval'
const MACOS_FONT_SMOOTHING_KEY = 'harness.macosFontSmoothing'
const TERMINAL_OPEN_KEY = 'harness.terminal.open'
const TERMINAL_HEIGHT_KEY = 'harness.terminal.height'
const BOTTOM_TERMINAL_MOTION_MS = 260
const RAIL_WIDTH_KEY = 'harness.rail.width'
const WORKSPACE_PANEL_WIDTH_KEY = 'harness.workspacePanel.width'
const NOTICE_AUTO_DISMISS_MS = 5_000
const DEFAULT_SIDEBAR_SETTINGS: SidebarSettings = { mode: 'classic', autoSettleDays: 3 }
type BottomTerminalPhase = 'closed' | 'opening' | 'open' | 'closing'
const loadTerminalPane = () => import('./ui/TerminalPane.js')
const TerminalPane = lazy(() =>
  loadTerminalPane().then((module) => ({ default: module.TerminalPane })),
)
const PullRequestsView = lazy(() =>
  import('./ui/pull-requests/PullRequestsView.js').then((module) => ({
    default: module.PullRequestsView,
  })),
)
const loadWorkspacePanel = () => import('./ui/workspace/WorkspacePanel.js')
const WorkspacePanel = lazy(() =>
  loadWorkspacePanel().then((module) => ({
    default: module.WorkspacePanel,
  })),
)

async function preloadDockSurfaces(): Promise<void> {
  await Promise.allSettled([
    loadTerminalPane().then((module) => module.preloadTerminalRuntime()),
    loadWorkspacePanel(),
  ])
}

const LegacyProjectsSchema = z.array(z.object({ path: z.string(), name: z.string().optional() }))

/**
 * Projects and sessions used to live here. The server owns them now, so this
 * only exists to hand what it finds over once and then get out of the way —
 * dropping it would silently lose the projects of anyone upgrading.
 */
function takeLegacyProjects(): Array<{ path: string; name?: string }> {
  try {
    const raw = readSetting(PROJECTS_KEY)
    if (!raw) return []
    return LegacyProjectsSchema.parse(JSON.parse(raw)).map(({ path, name }) => ({
      path,
      ...(name ? { name } : {}),
    }))
  } catch {
    return []
  }
}

type CustomModel = {
  provider: ProviderId
  modelId: string
  displayName: string
}

const CustomModelSchema: z.ZodType<CustomModel> = z.object({
  provider: ProviderIdSchema.refine((provider) => DIRECT_PROVIDER_ID_SET.has(provider)),
  modelId: z.string().trim().min(1),
  displayName: z
    .string()
    .catch('')
    .transform((name) => name.trim()),
})
const CustomModelsInputSchema = z.array(z.unknown())

type RecoverableDraft = { text: string; attachments: string[] }
type PendingSubmission = RecoverableDraft & {
  id: string
  createdAt: number
  kind: 'turn' | 'queue' | 'steer'
  accepted: boolean
  indeterminate: boolean
  optimisticTurn?: NonNullable<ThreadState['activeTurn']>
  precedingTurnId?: string
}
type PendingThreadDeltaBatch = { events: ItemDeltaEvent[]; sequence?: number }

type CatalogAvailability = 'loading' | 'ready' | 'failed'
type AccountCheck = { provider: ProviderId; state: CatalogAvailability; account?: Account }

type WorkspaceIdleProbe = {
  inFlight: Promise<void> | undefined
  pendingPath: string | undefined
  idlePath: string | undefined
  blockedPath: string | undefined
  pendingStarts: Map<string, { path: string; tokens: number[] }>
  submissionStarts: Map<string, { threadId: string; token: number }>
  queuedStarts: Map<string, { threadId: string; token: number }>
  claimedStarts: Set<string>
  queueActions: Map<string, { threadId: string; count: number; pending: number; steers: number }>
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
    const entries = CustomModelsInputSchema.parse(JSON.parse(raw))
    const models: CustomModel[] = []
    for (const entry of entries) {
      const model = CustomModelSchema.safeParse(entry)
      if (model.success) models.push(model.data)
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

function latestSequence(
  entries: ReadonlyArray<{ seq: number | undefined }>,
  initial: number,
): number {
  let latest = initial
  for (const entry of entries) {
    if (entry.seq !== undefined) latest = Math.max(latest, entry.seq)
  }
  return latest
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
  const [activeId, setActiveId] = useState<string | undefined>()
  const [activePath, setActivePath] = useState<string | undefined>()
  const [thread, setThread] = useState<ThreadState>(emptyThread)
  const [loadingThreadId, setLoadingThreadId] = useState<string | undefined>()
  /** A fresh array every streamed frame would defeat any memo below it. */
  const reviewList = useMemo(() => Object.values(thread.reviews), [thread.reviews])
  // Every live session keeps reducing events while it is off screen. A ref is
  // intentional: streamed deltas for a background session should not rerender
  // the active thread, while selecting it still gets the latest state at once.
  const threadStates = useRef(new Map<string, ThreadState>())
  /** Highest durable event already reduced into each complete thread cache. */
  const durableSequences = useRef(new Map<string, number>())
  const pendingSubmissions = useRef(new Map<string, Map<string, PendingSubmission>>())
  const rejectedDrafts = useRef(new Map<string, RecoverableDraft>())
  const rejectedDraftOwner = useRef<string | undefined>(undefined)
  const injectedDraftTransition = useRef(false)
  /** Live events parked while a history fetch for the thread is in flight. */
  const historyBuffers = useRef(
    new Map<string, Set<Array<{ seq: number | undefined; event: DomainEvent }>>>(),
  )
  const historyOwners = useRef(
    new Map<string, Array<{ seq: number | undefined; event: DomainEvent }>>(),
  )
  const pendingThreadDeltas = useRef(new Map<string, PendingThreadDeltaBatch>())
  const queueStates = useRef(new Map<string, { items: QueuedTurn[]; canSteer: boolean }>())
  const localQueueRevisions = useRef(new Map<string, number>())
  const serverQueueRevisions = useRef(new Map<string, number>())
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
      const restored = cached === undefined ? readStoredModelChoice(customModels) : undefined
      return {
        models: cached ?? (restored ? [restored] : []),
        loaded: cached !== undefined || restored !== undefined,
        // The upgrade fallback only knows the previously stored effort. Until
        // discovery provides real metadata it cannot validate a service tier.
        unvalidatedModelKeys: new Set(
          restored && !isCustomModelChoice(restored) ? [restored.key] : [],
        ),
      }
    })
  const [providerStatuses, setProviderStatuses] = useState<ProviderStatus[]>([])
  const [acpAgents, setAcpAgents] = useState<ResultOf<'acp.agents'>['agents']>([])
  const [customHarnessIds, setCustomHarnessIds] = useState<Set<string>>(() => new Set())
  const [modelConnections, setModelConnections] = useState<ModelConnection[]>([])
  const [catalogRequest, setCatalogRequest] = useState(0)
  const [catalogAvailability, setCatalogAvailability] = useState<CatalogAvailability>('loading')
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(() => {
    try {
      return new Set(z.array(z.string()).parse(JSON.parse(readSetting(HIDDEN_MODELS_KEY) ?? '[]')))
    } catch {
      return new Set()
    }
  })
  const modelVisibilityInitialized = useRef(readSetting(HIDDEN_MODELS_KEY) !== null)
  // Read via ref inside the catalog effect so toggling visibility does not
  // refetch every provider's model list.
  const hiddenModelsRef = useRef(hiddenModels)
  hiddenModelsRef.current = hiddenModels
  const [autoReviewSupported, setAutoReviewSupported] = useState(false)
  const [modelId, setModelId] = useState<string | undefined>(
    () => readSetting(MODEL_KEY) ?? undefined,
  )
  const [effort, setEffort] = useState<string | undefined>(
    () => readSetting(EFFORT_KEY) ?? undefined,
  )
  const [serviceTier, setServiceTier] = useState<string | undefined>(
    () => readSetting(SERVICE_TIER_KEY) ?? undefined,
  )
  const [approval, setApproval] = useState<ApprovalMode>(() => {
    const stored = readSetting(APPROVAL_KEY)
    return stored === 'auto' || stored === 'auto-review' || stored === 'full' ? stored : 'ask'
  })
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
    { text: string; attachments?: string[]; request: number } | undefined
  >()
  const [threadRevealRequest, setThreadRevealRequest] = useState(0)
  const [notice, setNotice] = useState<string | undefined>()
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
  const [macOSFontSmoothing, setMacOSFontSmoothing] = useState(
    () => readSetting(MACOS_FONT_SMOOTHING_KEY) !== 'false',
  )
  const [bottomTerminalPhase, setBottomTerminalPhase] = useState<BottomTerminalPhase>(() =>
    readSetting(TERMINAL_OPEN_KEY) === 'true' ? 'open' : 'closed',
  )
  const terminalOpen = bottomTerminalPhase === 'opening' || bottomTerminalPhase === 'open'
  const bottomTerminalMounted = bottomTerminalPhase !== 'closed'
  const [bottomTerminalPrepared, setBottomTerminalPrepared] = useState(false)
  const stageBody = useRef<HTMLDivElement>(null)
  const bottomTerminalComposerOrigin = useRef<{ left: number; top: number } | undefined>(undefined)
  const bottomTerminalComposerAnimation = useRef<Animation | null>(null)
  const terminalPlacement = useSyncExternalStore(
    subscribeTerminalPlacement,
    readTerminalPlacement,
    readTerminalPlacement,
  )
  const [terminalHeight, setTerminalHeight] = useState(readTerminalHeight)
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false)
  const [workspacePanelExpanded, setWorkspacePanelExpanded] = useState(false)
  const [workspacePanelWidth, setWorkspacePanelWidth] = useState(readWorkspacePanelWidth)
  const [workspaceTerminalToggleRequest, setWorkspaceTerminalToggleRequest] = useState(0)
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

  // Syntax grammars load in the background from the first frame, so the first
  // code block an agent produces is already coloured.
  useEffect(warmHighlighter, [])

  useEffect(() => {
    let active = true
    const prepare = () => {
      void preloadDockSurfaces().then(() => {
        if (active) setBottomTerminalPrepared(true)
      })
    }
    const idle = globalThis.requestIdleCallback?.(prepare, { timeout: 1_000 })
    const timeout = idle === undefined ? globalThis.setTimeout(prepare, 200) : undefined
    return () => {
      active = false
      if (idle !== undefined) globalThis.cancelIdleCallback(idle)
      if (timeout !== undefined) globalThis.clearTimeout(timeout)
    }
  }, [])

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

  useEffect(() => {
    writeSetting(THEME_KEY, themePreference)
  }, [themePreference])

  useLayoutEffect(() => {
    applyFontPreference(fontPreference)
    writeSetting(FONT_KEY, fontPreference)
  }, [fontPreference])

  useLayoutEffect(() => {
    applyAccentPreference(accentPreference)
    writeSetting(ACCENT_KEY, accentPreference)
  }, [accentPreference])

  useLayoutEffect(() => {
    applyBackdropPreference(backdropPreference)
    writeSetting(BACKDROP_KEY, backdropPreference)
  }, [backdropPreference])

  useLayoutEffect(() => {
    applyGlassPreference(sidebarGlass)
    writeSetting(GLASS_KEY, String(sidebarGlass))
  }, [sidebarGlass])

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

  useEffect(() => {
    if (macOS) writeSetting(MACOS_FONT_SMOOTHING_KEY, String(macOSFontSmoothing))
  }, [macOS, macOSFontSmoothing])

  useEffect(() => {
    writeSetting(TERMINAL_OPEN_KEY, String(terminalOpen))
  }, [terminalOpen])

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

  useLayoutEffect(() => {
    const origin = bottomTerminalComposerOrigin.current
    bottomTerminalComposerOrigin.current = undefined
    const composer = stageBody.current?.querySelector<HTMLElement>('.composer__box')
    if (!origin || !composer) return

    const next = composer.getBoundingClientRect()
    const x = origin.left - next.left
    const y = origin.top - next.top
    const reduceMotion =
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    if (reduceMotion || !composer.animate || (Math.abs(x) < 0.5 && Math.abs(y) < 0.5)) return

    const animation = composer.animate(
      [{ transform: `translate3d(${x}px, ${y}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
      { duration: BOTTOM_TERMINAL_MOTION_MS, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
    )
    animation.id = 'harness-terminal-composer'
    bottomTerminalComposerAnimation.current = animation
    void animation.finished
      .catch(() => undefined)
      .then(() => {
        if (bottomTerminalComposerAnimation.current === animation) {
          bottomTerminalComposerAnimation.current = null
        }
      })
  }, [terminalOpen])

  useEffect(
    () => () => {
      bottomTerminalComposerAnimation.current?.cancel()
    },
    [],
  )

  useEffect(() => {
    writeSetting(TERMINAL_HEIGHT_KEY, String(terminalHeight))
  }, [terminalHeight])

  useEffect(() => {
    const timeout = window.setTimeout(
      () => writeSetting(WORKSPACE_PANEL_WIDTH_KEY, String(workspacePanelWidth)),
      120,
    )
    return () => window.clearTimeout(timeout)
  }, [workspacePanelWidth])

  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const activePathRef = useRef(activePath)
  activePathRef.current = activePath
  const restoreRejectedDraft = useCallback((threadId: string, rejected: RecoverableDraft) => {
    const current = rejectedDrafts.current.get(threadId)
    const draft = {
      text: current ? `${current.text}\n\n${rejected.text}` : rejected.text,
      attachments: [...new Set([...(current?.attachments ?? []), ...rejected.attachments])],
    }
    rejectedDrafts.current.set(threadId, draft)
    if (threadId === activeIdRef.current) {
      rejectedDraftOwner.current = threadId
      setComposerDraft((request) => ({ ...draft, request: (request?.request ?? 0) + 1 }))
    }
  }, [])
  useEffect(() => {
    if (injectedDraftTransition.current) {
      injectedDraftTransition.current = false
      return
    }
    const draft = activeId ? rejectedDrafts.current.get(activeId) : undefined
    if (draft === undefined && rejectedDraftOwner.current === undefined) return
    rejectedDraftOwner.current = draft === undefined ? undefined : activeId
    setComposerDraft((current) => ({
      text: draft?.text ?? '',
      attachments: draft?.attachments ?? [],
      request: (current?.request ?? 0) + 1,
    }))
  }, [activeId])
  const updateRejectedDraft = useCallback((text: string) => {
    const owner = rejectedDraftOwner.current
    const draft = owner ? rejectedDrafts.current.get(owner) : undefined
    if (owner && draft) rejectedDrafts.current.set(owner, { ...draft, text })
  }, [])
  const updateRejectedAttachments = useCallback((attachments: string[]) => {
    const owner = rejectedDraftOwner.current
    const draft = owner ? rejectedDrafts.current.get(owner) : undefined
    if (owner && draft) rejectedDrafts.current.set(owner, { ...draft, attachments })
  }, [])
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const workspaceIdleProbe = useRef<WorkspaceIdleProbe>({
    inFlight: undefined,
    pendingPath: undefined,
    idlePath: undefined,
    blockedPath: undefined,
    pendingStarts: new Map(),
    submissionStarts: new Map(),
    queuedStarts: new Map(),
    claimedStarts: new Set(),
    queueActions: new Map(),
    unknownQueues: new Set(),
    nextStart: 0,
    revision: 0,
    transportRevision: 0,
    refreshedRevision: -1,
    refreshedPath: undefined,
  })
  useEffect(() => {
    workspaceIdleProbe.current.revision += 1
  }, [activePath])
  // prettier-ignore
  const invalidateWorkspaceIdleProbe = useCallback((projectPath: string | undefined) => { if (!projectPath || projectPath !== activePathRef.current) return; workspaceIdleProbe.current.revision += 1; workspaceIdleProbe.current.idlePath = undefined; if (workspaceIdleProbe.current.blockedPath === projectPath) workspaceIdleProbe.current.blockedPath = undefined }, [])
  // prettier-ignore
  const releaseWorkspaceStart = useCallback((threadId: string, token?: number) => { const probe = workspaceIdleProbe.current, pending = probe.pendingStarts.get(threadId); if (!pending) return; const index = token === undefined ? 0 : pending.tokens.indexOf(token); if (index < 0) return; pending.tokens.splice(index, 1); if (pending.tokens.length > 0) return; probe.pendingStarts.delete(threadId); if (probe.blockedPath !== pending.path || [...probe.pendingStarts.values()].some((entry) => entry.path === pending.path)) return; probe.blockedPath = undefined; return pending.path }, [])
  // prettier-ignore
  const holdWorkspaceStart = useCallback((threadId: string, path: string) => { const probe = workspaceIdleProbe.current, current = probe.pendingStarts.get(threadId), token = ++probe.nextStart; probe.idlePath = probe.refreshedPath = undefined; probe.pendingStarts.set(threadId, { path, tokens: [...(current?.tokens ?? []), token] }); return token }, [])
  // prettier-ignore
  const refreshWorkspaceAfterCompletion = useCallback((projectPath: string | undefined) => { if (!projectPath || projectPath !== activePathRef.current) return; const probe = workspaceIdleProbe.current; if (probe.refreshedPath === projectPath && probe.refreshedRevision === probe.revision) return; probe.pendingPath = projectPath; if (probe.inFlight) return; const drain = async () => { const transportRevision = probe.transportRevision; let retryPath: string | undefined, retryAvailable = true; while (probe.pendingPath && transportRevision === probe.transportRevision) { const path = probe.pendingPath; if (path !== retryPath) { retryPath = path; retryAvailable = true }; const revision = probe.revision; probe.pendingPath = undefined; let retry = false; try { const { projects } = await transport.request('projects.list', {}); if (revision !== probe.revision || transportRevision !== probe.transportRevision) continue; if (activePathRef.current !== path) continue; const project = projects.find((candidate) => candidate.path === path); if (!project) retry = probe.idlePath !== path; else { const pending = [...probe.pendingStarts.values()].some((entry) => entry.path === path), unknown = project.sessions.some((session) => probe.unknownQueues.has(session.id)), actions = [...probe.queueActions.values()].filter((action) => project.sessions.some((session) => session.id === action.threadId)), queued = project.sessions.some((session) => session.status === 'queued' || (queueStates.current.get(session.id)?.items.length ?? 0) > 0) || actions.length > 0; if (unknown || actions.some((action) => action.pending === 0)) resync.current(); const blocked = project.sessions.some((session) => session.running) || pending || queued || unknown; if (blocked) probe.blockedPath = path; else if (probe.blockedPath === path) probe.blockedPath = undefined; probe.idlePath = blocked ? undefined : path } } catch { retry = transportRevision === probe.transportRevision && revision === probe.revision && probe.idlePath !== path }; if (!retry || !retryAvailable || probe.pendingPath) continue; retryAvailable = false; probe.pendingPath = path }; const path = probe.idlePath, blocked = [...probe.pendingStarts.values()].some((pending) => pending.path === path); if (path === activePathRef.current && blocked) probe.blockedPath = path; probe.idlePath = undefined; if (path === activePathRef.current && !blocked) { probe.refreshedPath = path; probe.refreshedRevision = probe.revision; setWorkspaceRefreshRevision((revision) => revision + 1) } }; const inFlight = drain(); probe.inFlight = inFlight; void inFlight.finally(() => { if (probe.inFlight === inFlight) probe.inFlight = undefined }) }, [transport])
  // prettier-ignore
  const releaseQueuedStart = useCallback((queuedTurnId: string) => { const probe = workspaceIdleProbe.current, owner = probe.queuedStarts.get(queuedTurnId); if (!owner) return; probe.queuedStarts.delete(queuedTurnId); probe.claimedStarts.delete(queuedTurnId); for (const [id, start] of probe.submissionStarts) if (start.threadId === owner.threadId && start.token === owner.token) probe.submissionStarts.delete(id); const path = releaseWorkspaceStart(owner.threadId, owner.token); if (path) refreshWorkspaceAfterCompletion(path) }, [releaseWorkspaceStart, refreshWorkspaceAfterCompletion])
  // prettier-ignore
  const holdQueueAction = useCallback((id: string, threadId: string, kind: 'delete' | 'steer') => { const probe = workspaceIdleProbe.current, action = probe.queueActions.get(id) ?? { threadId, count: 0, pending: 0, steers: 0 }; action.count += 1; action.pending += 1; if (kind === 'steer') action.steers += 1; probe.queueActions.set(id, action) }, [])
  // prettier-ignore
  const settleQueueAction = useCallback((id: string, kind: 'delete' | 'steer', indeterminate = false) => { const action = workspaceIdleProbe.current.queueActions.get(id); if (!action) return; action.pending -= 1; if (!indeterminate) { action.count -= 1; if (kind === 'steer') action.steers -= 1 }; if (action.count === 0) workspaceIdleProbe.current.queueActions.delete(id) }, [])
  // prettier-ignore
  const releaseDirectStart = useCallback((threadId: string) => { const probe = workspaceIdleProbe.current, queued = new Set([...probe.queuedStarts.values()].filter((owner) => owner.threadId === threadId).map((owner) => owner.token)), token = probe.pendingStarts.get(threadId)?.tokens.find((candidate) => !queued.has(candidate)); if (token === undefined) return; for (const [id, start] of probe.submissionStarts) if (start.threadId === threadId && start.token === token) probe.submissionStarts.delete(id); releaseWorkspaceStart(threadId, token) }, [releaseWorkspaceStart])
  // prettier-ignore
  const clearWorkspaceThread = useCallback((threadId: string) => { const probe = workspaceIdleProbe.current, path = probe.pendingStarts.get(threadId)?.path ?? findSession(projectsRef.current, threadId)?.project.path; probe.pendingStarts.delete(threadId); probe.unknownQueues.delete(threadId); queueStates.current.delete(threadId); pendingSubmissions.current.delete(threadId); threadStates.current.delete(threadId); durableSequences.current.delete(threadId); pendingThreadDeltas.current.delete(threadId); historyOwners.current.delete(threadId); historyBuffers.current.delete(threadId); localQueueRevisions.current.delete(threadId); serverQueueRevisions.current.delete(threadId); for (const [id, owner] of probe.submissionStarts) if (owner.threadId === threadId) probe.submissionStarts.delete(id); for (const [id, owner] of probe.queuedStarts) if (owner.threadId === threadId) { probe.queuedStarts.delete(id); probe.claimedStarts.delete(id) }; for (const [id, action] of probe.queueActions) if (action.threadId === threadId) probe.queueActions.delete(id); if (activeIdRef.current === threadId) { activeIdRef.current = undefined; setActiveId(undefined); setThread(emptyThread) }; return path }, [])
  /** Refetch after an outage. Held in a ref because the transport effect is
   *  set up before the fetchers it needs are declared. */
  const resync = useRef<(retry?: boolean) => void>(() => {})
  const resyncRevision = useRef(0)
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
      const pending = pendingSubmissions.current.get(threadId)
      if (!pending) return
      const queuedIds = new Set(items.map((item) => item.id))
      let next = threadStates.current.get(threadId) ?? emptyThread
      const rejected: PendingSubmission[] = []
      for (const submission of pending.values()) {
        const durable = next.items.some((item) => item.id === submission.id && item.turnId !== '')
        if (durable || queuedIds.has(submission.id)) {
          pending.delete(submission.id)
          if (queuedIds.has(submission.id) && submission.kind !== 'queue') {
            next = removePendingSubmission(next, submission)
          }
        } else if (
          submission.indeterminate &&
          !submission.accepted &&
          snapshot !== undefined &&
          (!snapshot.running ||
            (submission.kind !== 'turn' &&
              snapshot.activeTurn?.id !== undefined &&
              snapshot.activeTurn.id === submission.precedingTurnId))
        ) {
          pending.delete(submission.id)
          next = removePendingSubmission(next, submission)
          rejected.push(submission)
        }
      }
      if (pending.size === 0) pendingSubmissions.current.delete(threadId)
      threadStates.current.set(threadId, next)
      if (threadId === activeIdRef.current) setThread(next)
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
    let liveFlush: number | undefined
    const applyPendingDeltas = (threadId: string) => {
      const pending = pendingThreadDeltas.current.get(threadId)
      const current = threadStates.current.get(threadId) ?? emptyThread
      if (!pending || pending.events.length === 0) return current
      pendingThreadDeltas.current.delete(threadId)
      const next = reduceDeltas(current, pending.events)
      threadStates.current.set(threadId, next)
      if (pending.sequence !== undefined && durableSequences.current.has(threadId)) {
        durableSequences.current.set(
          threadId,
          Math.max(durableSequences.current.get(threadId) ?? 0, pending.sequence),
        )
      }
      return next
    }
    const flushLive = () => {
      liveFlush = undefined
      for (const threadId of pendingThreadDeltas.current.keys()) applyPendingDeltas(threadId)
      const id = activeIdRef.current
      if (id) setThread(threadStates.current.get(id) ?? emptyThread)
    }
    const offEvents = transport.on('thread.event', ({ threadId, event, seq }) => {
      const durableSequence = durableSequences.current.get(threadId)
      const pendingDeltas = pendingThreadDeltas.current.get(threadId)
      const pendingSequence = pendingDeltas?.sequence
      if (
        seq !== undefined &&
        durableSequence !== undefined &&
        seq <= Math.max(durableSequence, pendingSequence ?? durableSequence)
      ) {
        return
      }
      // Compatibility pushes without a durable position cannot safely extend
      // a cursor. Keep rendering them, then force the next recovery to reload.
      if (seq === undefined) {
        durableSequences.current.delete(threadId)
      }
      // While a history load is in flight, the fetched state will replace the
      // cache — record the event so it can be replayed on top. Non-deltas
      // apply immediately below; deltas join the same frame batch as rendering.
      for (const buffer of historyBuffers.current.get(threadId) ?? []) {
        buffer.push({ seq, event })
      }
      if (event.type === 'item.delta') {
        if (pendingDeltas) {
          pendingDeltas.events.push(event)
          if (seq !== undefined && durableSequence !== undefined) {
            pendingDeltas.sequence = Math.max(pendingSequence ?? durableSequence, seq)
          }
        } else {
          const nextDeltas: PendingThreadDeltaBatch = { events: [event] }
          if (seq !== undefined && durableSequence !== undefined) nextDeltas.sequence = seq
          pendingThreadDeltas.current.set(threadId, nextDeltas)
        }
        liveFlush ??= requestAnimationFrame(flushLive)
        return
      }

      const next = reduce(applyPendingDeltas(threadId), event)
      threadStates.current.set(threadId, next)
      if (seq !== undefined && durableSequence !== undefined) {
        durableSequences.current.set(threadId, Math.max(durableSequence, seq))
      }
      if (
        (event.type === 'item.started' || event.type === 'item.completed') &&
        event.item.role === 'user'
      ) {
        deletePendingSubmission(pendingSubmissions.current, threadId, event.item.id)
      }

      if (threadId === activeIdRef.current) {
        if (liveFlush !== undefined && pendingThreadDeltas.current.size === 0) {
          cancelAnimationFrame(liveFlush)
          liveFlush = undefined
        }
        setThread(next)
      }
      if (threadId === activeIdRef.current && endsDesignBriefing(event)) setDesignMode(false)
      if (
        event.type === 'turn.started' ||
        event.type === 'turn.completed' ||
        event.type === 'thread.error'
      ) {
        // prettier-ignore
        const projectPath = findSession(projectsRef.current, threadId)?.project.path ?? (threadId === activeIdRef.current ? activePathRef.current : undefined)
        if (event.type === 'turn.started') {
          const probe = workspaceIdleProbe.current
          probe.unknownQueues.delete(threadId)
          // prettier-ignore
          const queued = [...probe.queuedStarts].find(([id, owner]) => owner.threadId === threadId && (probe.claimedStarts.has(id) || !queueStates.current.get(threadId)?.items.some((item) => item.id === id)))?.[0]
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
    })
    const offQueue = transport.on('thread.queue', ({ threadId, items, canSteer }) => {
      // prettier-ignore
      const previous = new Set(queueStates.current.get(threadId)?.items.map((item) => item.id)), current = new Set(items.map((item) => item.id)), probe = workspaceIdleProbe.current
      if ([...previous].some((id) => !current.has(id))) probe.unknownQueues.add(threadId)
      else probe.unknownQueues.delete(threadId)
      // prettier-ignore
      { for (const [id, owner] of probe.queuedStarts) if (owner.threadId === threadId) { if (current.has(id)) probe.claimedStarts.delete(id); else if (previous.has(id) && !probe.queueActions.has(id)) probe.claimedStarts.add(id) }; for (const [id, action] of probe.queueActions) if (action.threadId === threadId && action.pending === 0 && current.has(id) && !previous.has(id)) probe.queueActions.delete(id) }
      serverQueueRevisions.current.set(
        threadId,
        (serverQueueRevisions.current.get(threadId) ?? 0) + 1,
      )
      queueStates.current.set(threadId, { items, canSteer })
      settleQueuedSubmissions(threadId, items)
      const projectPath = findSession(projectsRef.current, threadId)?.project.path
      if (items.length === 0 && probe.blockedPath === projectPath)
        refreshWorkspaceAfterCompletion(projectPath)
      if (threadId !== activeIdRef.current) return
      setQueuedTurns(items)
      setCanSteerQueue(canSteer)
    })
    const offLifecycle = transport.on('thread.lifecycle', ({ threadId, lifecycle }) => {
      setProjects((current) =>
        updateSession(current, threadId, (session) => ({ ...session, lifecycle })),
      )
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
            queueStates.current.size > 0 ||
            workspaceIdleProbe.current.unknownQueues.size > 0)
        ) {
          missedPushes = false
          resync.current()
        }
      }
    })
    transport.connect()
    return () => {
      if (liveFlush !== undefined) cancelAnimationFrame(liveFlush)
      for (const threadId of pendingThreadDeltas.current.keys()) applyPendingDeltas(threadId)
      window.clearTimeout(announce)
      const probe = workspaceIdleProbe.current
      probe.revision += 1
      probe.transportRevision += 1
      resyncRevision.current += 1
      probe.inFlight = probe.pendingPath = probe.idlePath = probe.blockedPath = undefined
      offEvents()
      offQueue()
      offLifecycle()
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
  ])

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
      const auxiliaryCatalog = Promise.all([
        transport.request('connections.list', {}).catch(() => ({ connections: [] })),
        transport.request('acp.agents', {}).catch(() => ({ agents: [] })),
        transport.request('harnesses.list', {}).catch(() => ({ harnesses: [] })),
      ])
      const providersResult = await transport.request('providers.list', {})
      const providers = providersResult?.providers ?? []
      if (cancelled) return
      setProviderStatuses(providers)
      setCatalogAvailability('ready')
      const storedProvider = ProviderIdSchema.safeParse(readSetting(SETUP_KEY))
      if (
        !activeIdRef.current &&
        (!storedProvider.success || !PUBLIC_BETA_PROVIDER_IDS.has(storedProvider.data))
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
      const unknownKeys = new Set<string>()
      const directPromise = Promise.all(
        providers
          .filter((entry) => entry.installed && entry.id !== 'acp' && entry.id !== 'api')
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
      const [connectionsResult, agentsResult, harnessesResult] = await auxiliaryCatalog
      const connections = connectionsResult?.connections ?? []
      const harnesses = harnessesResult?.harnesses ?? []
      setCustomHarnessIds(new Set(harnesses.map((harness) => harness.id)))
      const customSourcesPromise = Promise.all(
        harnesses.map(async (harness) => {
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
            return choicesFor(input, result.models, true)
          } catch {
            const source = sourceKey({ provider: harness.provider, agentId: harness.id })
            const preserved = catalogModelsRef.current.filter(
              (choice) => !isCustomModelChoice(choice) && modelSource(choice) === source,
            )
            if (preserved.length > 0) return preserved
            const fallback = choicesFor(input, [], true)
            for (const choice of fallback) unknownKeys.add(choice.key)
            return fallback
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
      const catalog = [...publicCatalog, ...customSources.flat()]
      const publicCatalogReady =
        publicDiscoveries.length > 0 && publicDiscoveries.every((entry) => entry.discovered)
      setAcpAgents(agentsResult?.agents ?? [])
      setModelConnections(connections)
      setModelCatalog({ models: catalog, loaded: true, unvalidatedModelKeys: unknownKeys })
      // A synthetic cache-miss entry has no tier metadata. Do not persist it
      // as an authoritative snapshot after a transient discovery failure.
      if (unknownKeys.size === 0 && direct.every((entry) => entry.discovered)) {
        writeSetting(MODEL_CATALOG_KEY, serializeModelCatalogCache(catalog))
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
        setModelCatalog((current) => ({ ...current, loaded: true }))
        setCatalogAvailability((current) => (current === 'ready' ? current : 'failed'))
      }
    })
    return () => {
      cancelled = true
    }
  }, [transport, catalogRequest])

  useEffect(() => {
    if (!isDesktop || !canCaptureVoice() || selectedModelChoice?.agent) {
      setVoiceAvailable(false)
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
  }, [transport, provider, account?.signedIn, modelConnections, selectedModelChoice?.agent])

  useEffect(() => {
    let cancelled = false
    setAutoReviewSupported(false)
    void transport
      .request('providers.list', {})
      .then(({ providers }) => {
        if (cancelled) return
        setAutoReviewSupported(
          providers.find((entry) => entry.id === provider)?.capabilities?.autoReview === true,
        )
      })
      .catch(() => {
        if (!cancelled) setAutoReviewSupported(false)
      })
    return () => {
      cancelled = true
    }
  }, [transport, provider])

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
    const { projects: list } = await transport.request('projects.list', {})
    const savedOrder = loadSessionOrder()
    const nextProjects = applyProjectOrder(
      list.map((project) => ({
        path: project.path,
        name: project.name,
        pinned: project.pinned,
        sessions: applySessionOrder(
          project.path,
          project.sessions.map((session) => {
            const status = session.status ?? (session.running ? 'working' : 'idle')
            return {
              id: session.id,
              title: session.title,
              provider: session.provider,
              ...(session.agent ? { agent: session.agent } : {}),
              createdAt: session.createdAt,
              statusSince: session.running ? Date.now() : session.createdAt,
              status,
              lifecycle: session.lifecycle ?? { state: 'active', keepActive: false },
              unread: session.unread ?? false,
              pinned: session.pinned ?? false,
              ...(session.worktreeBranch
                ? {
                    worktreeBranch: session.worktreeBranch,
                  }
                : {}),
            }
          }),
          savedOrder,
        ),
      })),
      loadProjectOrder(),
    )
    setProjects(nextProjects)
    setActivePath((current) => current ?? nextProjects[0]?.path)
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
      if (afterSeq === undefined) durableSequences.current.delete(threadId)
      // Live pushes landing during this round trip are buffered (see the
      // thread.event handler) and re-applied on top of the fetched history —
      // overwriting the cache blindly used to silently drop them.
      const buffer: Array<{ seq: number | undefined; event: DomainEvent }> = []
      const buffers = historyBuffers.current.get(threadId) ?? new Set()
      buffers.add(buffer)
      historyBuffers.current.set(threadId, buffers)
      historyOwners.current.set(threadId, buffer)
      const base =
        afterSeq === undefined ? emptyThread : (threadStates.current.get(threadId) ?? emptyThread)
      try {
        const { events, running } = await transport.request(
          'thread.history',
          afterSeq === undefined ? { threadId } : { threadId, afterSeq },
        )
        // A reconnect may have started a fresher request. The older response
        // still owns its live-event buffer, but it must not replace newer
        // durable history after resolving last.
        if (historyOwners.current.get(threadId) !== buffer) return
        const restored = reduceEventLog(base, events, afterSeq)
        const lastSeq = events.at(-1)?.seq ?? afterSeq ?? 0
        const authoritative = {
          ...restored,
          running,
          activeTurn: running ? restored.activeTurn : undefined,
        }
        const live = reduceEventLog(authoritative, buffer, lastSeq)
        if (buffer.some((entry) => entry.seq === undefined)) {
          durableSequences.current.delete(threadId)
        } else {
          durableSequences.current.set(threadId, latestSequence(buffer, lastSeq))
        }
        const withLive = preservePendingSubmissions(live, pendingSubmissions.current, threadId)
        // The buffered events above already include any deltas still waiting
        // for a frame, so do not apply that pending batch a second time.
        pendingThreadDeltas.current.delete(threadId)
        threadStates.current.set(threadId, withLive)
        if (activeIdRef.current === threadId) {
          setProjects((current) => updateSession(current, threadId, markSessionRead))
          setThread(withLive)
        }
        if (afterSeq === undefined) return live
        // Queue settlement may use an active-turn id as rejection evidence.
        // Only a boundary returned by this read (or its live buffer) is fresh
        // authority; the cached prefix must not settle an indeterminate send.
        const suffix = reduceEventLog(reduceEventLog(emptyThread, events), buffer, lastSeq)
        const crossedTurnBoundary = [...events, ...buffer].some(
          ({ event }) => event.type === 'turn.started' || event.type === 'turn.completed',
        )
        return {
          ...live,
          activeTurn: crossedTurnBoundary ? suffix.activeTurn : live.activeTurn,
        }
      } finally {
        buffers.delete(buffer)
        if (buffers.size === 0) historyBuffers.current.delete(threadId)
        if (historyOwners.current.get(threadId) === buffer) {
          historyOwners.current.delete(threadId)
        }
      }
    },
    [transport],
  )

  resync.current = (retry = true) => {
    const revision = ++resyncRevision.current
    workspaceIdleProbe.current.revision += 1
    const activeId = activeIdRef.current
    const path = activePathRef.current
    const threadIds = new Set(pendingSubmissions.current.keys())
    // prettier-ignore
    const ownerPaths = new Map([...workspaceIdleProbe.current.pendingStarts].filter(([id]) => !id.startsWith('pending:')).map(([id, owner]) => [id, { path: owner.path, tokens: [...owner.tokens] }]))
    for (const id of ownerPaths.keys()) threadIds.add(id)
    for (const action of workspaceIdleProbe.current.queueActions.values())
      threadIds.add(action.threadId)
    for (const session of projectsRef.current.find((project) => project.path === path)?.sessions ??
      [])
      if (
        !['failed', 'ready', 'idle'].includes(session.status) ||
        (queueStates.current.get(session.id)?.items.length ?? 0) > 0 ||
        workspaceIdleProbe.current.unknownQueues.has(session.id)
      )
        threadIds.add(session.id)
    if (activeId && !activeId.startsWith('pending:')) threadIds.add(activeId)
    // prettier-ignore
    const resyncThread = (id: string, retry = true): Promise<{ id: string; thread: ThreadState; queue: QueuedTurn[] } | undefined> => {
      const history = loadHistory(id, durableSequences.current.get(id)).catch(() => undefined)
      const localQueueRevision = localQueueRevisions.current.get(id) ?? 0
      const serverQueueRevision = serverQueueRevisions.current.get(id) ?? 0
      return transport
        .request('thread.queue', { threadId: id })
        .then(async (state) => {
          const loaded = await history
          if (
            revision !== resyncRevision.current ||
            (localQueueRevisions.current.get(id) ?? 0) !== localQueueRevision ||
            (serverQueueRevisions.current.get(id) ?? 0) !== serverQueueRevision
          ) {
            if (revision !== resyncRevision.current) return
            if (retry) return resyncThread(id, false)
            workspaceIdleProbe.current.unknownQueues.add(id)
            return
          }
          // prettier-ignore
          for (const [queuedId, owner] of workspaceIdleProbe.current.queuedStarts) if (owner.threadId === id) { if (state.items.some((item) => item.id === queuedId)) workspaceIdleProbe.current.claimedStarts.delete(queuedId); else if (queueStates.current.get(id)?.items.some((item) => item.id === queuedId)) workspaceIdleProbe.current.claimedStarts.add(queuedId) }
          for (const item of state.items) {
            const start = workspaceIdleProbe.current.submissionStarts.get(item.id)
            if (start?.threadId === id) workspaceIdleProbe.current.queuedStarts.set(item.id, start)
          }
          queueStates.current.set(id, state)
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
        })
        .catch(() => {
          if (revision === resyncRevision.current) workspaceIdleProbe.current.unknownQueues.add(id)
          return undefined
        })
    }
    void Promise.all([
      refreshProjects().catch(() => undefined),
      ...[...threadIds].map((id) => resyncThread(id)),
    ]).then(([projects, ...threads]) => {
      if (revision !== resyncRevision.current) return
      const states = threads.filter((state) => state !== undefined)
      const probe = workspaceIdleProbe.current
      const project = projects?.find((candidate) => candidate.path === path)
      if (!projects) {
        for (const id of ownerPaths.keys()) probe.unknownQueues.add(id)
        if (retry) resync.current(false)
        return
      }
      setProjectsStatus('ready')
      if (projects)
        for (const id of ownerPaths.keys())
          if (
            !projects.some((candidate) => candidate.sessions.some((session) => session.id === id))
          )
            clearWorkspaceThread(id)
      for (const state of states) {
        const session = projects
          ?.flatMap((candidate) => candidate.sessions)
          .find((candidate) => candidate.id === state.id)
        const captured = ownerPaths.get(state.id)
        const current = probe.pendingStarts.get(state.id)
        // prettier-ignore
        const durable = new Set(state.thread.items.filter((item) => item.turnId !== '').map((item) => item.id))
        for (const [id, start] of probe.submissionStarts)
          if (start.threadId === state.id && durable.has(id)) {
            probe.submissionStarts.delete(id)
            probe.queuedStarts.delete(id)
            probe.claimedStarts.delete(id)
            releaseWorkspaceStart(state.id, start.token)
          }
        for (const [id, owner] of probe.queuedStarts)
          if (owner.threadId === state.id && durable.has(id)) releaseQueuedStart(id)
        // prettier-ignore
        for (const [id, action] of probe.queueActions) if (action.threadId === state.id && action.pending === 0 && !state.queue.some((item) => item.id === id)) { if (action.steers > 0 && state.thread.running && !durable.has(id)) continue; probe.queueActions.delete(id); releaseQueuedStart(id) }
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
          // prettier-ignore
          const protectedTokens = new Set([...probe.queuedStarts].filter(([id, owner]) => owner.threadId === state.id && (probe.claimedStarts.has(id) || probe.queueActions.has(id)) && !durable.has(id)).map(([, owner]) => owner.token)), remainingTokens = current.tokens.filter((token) => !tokens.has(token) || protectedTokens.has(token))
          current.tokens = remainingTokens
          for (const [id, start] of probe.submissionStarts)
            if (
              start.threadId === state.id &&
              tokens.has(start.token) &&
              !remainingTokens.includes(start.token)
            )
              probe.submissionStarts.delete(id)
          if (current.tokens.length === 0) probe.pendingStarts.delete(state.id)
          for (const [queuedId, owner] of probe.queuedStarts)
            if (
              owner.threadId === state.id &&
              tokens.has(owner.token) &&
              !protectedTokens.has(owner.token)
            ) {
              probe.queuedStarts.delete(queuedId)
              probe.claimedStarts.delete(queuedId)
            }
        }
      }
      // prettier-ignore
      const activeIds = new Set([...threadIds].filter((id) => project?.sessions.some((session) => session.id === id) && (ownerPaths.get(id)?.path === path || findSession(projectsRef.current, id)?.project.path === path)))
      const activeStates = states.filter((state) => activeIds.has(state.id))
      const idle =
        path &&
        project &&
        activeStates.length === activeIds.size &&
        !project.sessions.some(
          (session) =>
            session.running ||
            session.status === 'queued' ||
            probe.unknownQueues.has(session.id) ||
            (queueStates.current.get(session.id)?.items.length ?? 0) > 0,
        ) &&
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

    const cached = queueStates.current.get(activeId)
    setQueuedTurns(cached?.items ?? [])
    setCanSteerQueue(cached?.canSteer ?? false)
    let cancelled = false
    const localRevision = localQueueRevisions.current.get(activeId) ?? 0
    const serverRevision = serverQueueRevisions.current.get(activeId) ?? 0
    void transport
      .request('thread.queue', { threadId: activeId })
      .then((state) => {
        if (
          cancelled ||
          (localQueueRevisions.current.get(activeId) ?? 0) !== localRevision ||
          (serverQueueRevisions.current.get(activeId) ?? 0) !== serverRevision
        )
          return
        queueStates.current.set(activeId, state)
        settleQueuedSubmissions(activeId, state.items)
        if (activeIdRef.current !== activeId) return
        setQueuedTurns(state.items)
        setCanSteerQueue(state.canSteer)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [transport, activeId, settleQueuedSubmissions])

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

  useEffect(() => {
    if (modelId) writeSetting(MODEL_KEY, modelId)
    else removeSetting(MODEL_KEY)
  }, [modelId])

  useEffect(() => {
    if (!modelVisibilityInitialized.current) return
    writeSetting(HIDDEN_MODELS_KEY, JSON.stringify([...hiddenModels]))
  }, [hiddenModels])

  useEffect(() => {
    if (effort) {
      writeSetting(EFFORT_KEY, effort)
    } else {
      removeSetting(EFFORT_KEY)
    }
  }, [effort])

  useEffect(() => {
    if (serviceTier) {
      writeSetting(SERVICE_TIER_KEY, serviceTier)
    } else {
      removeSetting(SERVICE_TIER_KEY)
    }
  }, [serviceTier])

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

  useEffect(() => {
    writeSetting(APPROVAL_KEY, approval)
  }, [approval])

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

  const addProject = useCallback(async () => {
    const path = await pickFolder()
    if (!path) return
    await transport.request('projects.add', { path })
    await refreshProjects()
    setActivePath(path)
    activeIdRef.current = undefined
    setActiveId(undefined)
    setThread(emptyThread)
  }, [transport, refreshProjects])

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
        const sessionApproval =
          approval === 'auto-review' && !autoReviewSupported ? 'ask' : approval
        const { threadId } = await transport.request('thread.start', {
          provider: choice.provider,
          workspacePath: projectPath,
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
        const provisional = threadStates.current.get(provisionalId) ?? emptyThread
        threadStates.current.delete(provisionalId)
        threadStates.current.set(threadId, provisional)
        durableSequences.current.set(threadId, 0)
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
        threadStates.current.delete(provisionalId)
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
        rejectedDraftOwner.current = undefined
        injectedDraftTransition.current = activeIdRef.current !== undefined
        setComposerDraft((current) => ({
          text: draft,
          attachments: [],
          request: (current?.request ?? 0) + 1,
        }))
      }
      // A session nobody typed into is bookkeeping, not history. Pressing "new
      // session" twice should not leave a trail of empty ones.
      const untouched = projects
        .find((project) => project.path === projectPath)
        ?.sessions.filter((session) => session.title === 'New session')
      for (const session of untouched ?? []) {
        threadStates.current.delete(session.id)
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
    ],
  )

  const updateQueue = useCallback(
    (threadId: string, update: (items: QueuedTurn[]) => QueuedTurn[]) => {
      const current = queueStates.current.get(threadId) ?? { items: [], canSteer: false }
      const next = { ...current, items: update(current.items) }
      localQueueRevisions.current.set(
        threadId,
        (localQueueRevisions.current.get(threadId) ?? 0) + 1,
      )
      queueStates.current.set(threadId, next)
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
      const restoreDraft = () =>
        setComposerDraft((current) => ({
          text,
          attachments,
          request: (current?.request ?? 0) + 1,
        }))
      const sideChatCommand = parseSideChatCommand(text)
      if (sideChatCommand) {
        if (!activeId || activeId.startsWith('pending:')) {
          restoreDraft()
          setNotice('Start the main chat before opening a side chat.')
          return
        }
        const parent = threadStates.current.get(activeId)
        if (!parent?.items.some((item) => item.type === 'message' && item.role === 'user')) {
          restoreDraft()
          setNotice('Send a message in the main chat before opening a side chat.')
          return
        }
        setNotice(undefined)
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
        threadStates.current.set(provisionalId, provisional)
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
          const current = threadStates.current.get(provisionalId)
          if (current !== undefined && current.activeTurn?.id === optimisticTurnId) {
            const next: ThreadState = { ...current, running: false, activeTurn: undefined }
            threadStates.current.set(provisionalId, next)
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
          threadStates.current.get(targetId) ?? emptyThread,
          text,
          optimisticItemId,
          optimisticCreatedAt,
          attachments,
        )
        threadStates.current.set(targetId, provisional)
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

      const before = threadStates.current.get(threadId) ?? emptyThread
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
        threadStates.current.set(threadId, next)
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
        threadStates.current.set(threadId, next)
        if (threadId === activeIdRef.current) setThread(next)
      }
      if (optimisticQueueId) {
        updateQueue(threadId, (items) => [
          ...items,
          { id: optimisticQueueId, text, attachments, createdAt: Date.now() },
        ])
      }
      const optimisticState = threadStates.current.get(threadId) ?? emptyThread
      rejectedDrafts.current.delete(threadId)
      if (rejectedDraftOwner.current === threadId) rejectedDraftOwner.current = undefined
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
      putPendingSubmission(pendingSubmissions.current, threadId, pendingSubmission)
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
        const current = threadStates.current.get(threadId) ?? emptyThread
        const pending = pendingSubmissions.current.get(threadId)?.get(optimisticItemId)
        if (pending) pending.accepted = true
        if (result.queued) {
          if (pending) pending.kind = steering ? 'steer' : 'queue'
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
              threadStates.current.set(threadId, reconciled)
              if (threadId === activeIdRef.current) setThread(reconciled)
            }
            deletePendingSubmission(pendingSubmissions.current, threadId, optimisticItemId)
          }
        } else if (!result.queued && wasRunning) {
          if (pending) pending.kind = 'turn'
          if (optimisticQueueId) {
            updateQueue(threadId, (items) => items.filter((item) => item.id !== optimisticQueueId))
          }
        }
      } catch (error) {
        if (error instanceof IndeterminateRequestError) {
          const pending = pendingSubmissions.current.get(threadId)?.get(optimisticItemId)
          if (pending) pending.indeterminate = true
          if (queuedActionId) settleQueueAction(queuedActionId, 'steer', true)
          return
        }
        if (queuedActionId) settleQueueAction(queuedActionId, 'steer')
        deletePendingSubmission(pendingSubmissions.current, threadId, optimisticItemId)
        if (optimisticQueueId) {
          updateQueue(threadId, (items) => items.filter((item) => item.id !== optimisticQueueId))
        }
        if (!turnAccepted) {
          releasePendingStart()
          const current = threadStates.current.get(threadId)
          if (current !== undefined) {
            // The server did not accept this prompt. Remove only its local
            // echo; a durable item already bound to a turn remains.
            let next = removeOptimisticMessage(current, optimisticItemId)
            if (current.activeTurn?.id === optimisticTurnId) {
              next = { ...next, running: false, activeTurn: undefined }
            }
            threadStates.current.set(threadId, next)
            if (threadId === activeIdRef.current) setThread(next)
          }
          restoreRejectedDraft(threadId, { text, attachments })
        } else if (steering) {
          const current = threadStates.current.get(threadId)
          if (current) {
            const next = removeOptimisticMessage(current, optimisticItemId)
            threadStates.current.set(threadId, next)
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
  const refreshCatalog = useCallback(() => setCatalogRequest((request) => request + 1), [])

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
    setSettingsSection('providers')
    setSettingsOpen(true)
    setProviderAuthRefreshRevision((revision) => revision + 1)
    void transport
      .request('auth.status', { provider: completed.provider })
      .then((account) => handleAccountChange(completed.provider, account))
      .catch(() => undefined)
  }, [handleAccountChange, providerLoginState?.phase, providerLoginTerminal, transport])

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

  const selectProject = useCallback(
    (path: string) => {
      setSurface('chat')
      if (path === activePath) return
      setActivePath(path)
      activeIdRef.current = undefined
      setActiveId(undefined)
      setThread(emptyThread)
      setUndoRestore(undefined)
      setRollbackOpen(false)
    },
    [activePath],
  )

  const selectBranch = useCallback(
    async (branch: string) => {
      if (!activePath || activeId) return
      setNotice(undefined)
      try {
        const info = await transport.request('workspace.switchBranch', {
          path: activePath,
          branch,
        })
        setWorkspace(info)
        setBranches((current) => [branch, ...current.filter((item) => item !== branch)])
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      }
    },
    [transport, activePath, activeId],
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
      const found = findSession(projects, id)
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
      setActivePath(found?.project.path)
      const cached = threadStates.current.get(id)
      if (cached) {
        setThread(cached)
        setProjects((current) => updateSession(current, id, markSessionRead))
        if (pendingSubmissions.current.has(id)) {
          resync.current()
          return
        }
      } else {
        setThread(emptyThread)
      }

      setLoadingThreadId(id)
      try {
        await loadHistory(id, cached ? durableSequences.current.get(id) : undefined)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      } finally {
        setLoadingThreadId((current) => (current === id ? undefined : current))
      }
    },
    [projects, visibleModels, selectedModelChoice, commitModelChoice, loadHistory, transport],
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
   * do both jobs at once: it is the default every new session starts with,
   * and picking a different mode inside a live chat changes that chat now.
   */
  const changeApproval = useCallback(
    (mode: ApprovalMode) => {
      setApproval(mode)
      const threadId = activeIdRef.current
      if (!threadId || threadId.startsWith('pending:')) return
      void transport
        .request('thread.setApproval', { threadId, approval: mode })
        .catch((error) => setNotice(error instanceof Error ? error.message : String(error)))
    },
    [transport],
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
      durableSequences.current.delete(activeId)
      historyOwners.current.delete(activeId)
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
      durableSequences.current.delete(undoRestore.threadId)
      historyOwners.current.delete(undoRestore.threadId)
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
      threadStates.current.delete(id)
      durableSequences.current.delete(id)
      pendingThreadDeltas.current.delete(id)
      pendingSubmissions.current.delete(id)
      setProjects((current) =>
        current.map((project) => ({
          ...project,
          sessions: project.sessions.filter((session) => session.id !== id),
        })),
      )
      if (activeIdRef.current === id) {
        activeIdRef.current = undefined
        setActiveId(undefined)
        setThread(emptyThread)
      }
      rejectedDrafts.current.delete(id)
      refreshWorkspaceAfterCompletion(projectPath)
    },
    [transport, clearWorkspaceThread, refreshWorkspaceAfterCompletion],
  )

  const archiveSession = useCallback(
    async (id: string) => {
      const found = findSession(projects, id)
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
        if (work.isolated) {
          await transport.request('thread.close', { threadId: id })
          await transport.request('thread.discardWorktree', { threadId: id })
        }
        await deleteSession(id)
        return true
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
        await refreshProjects().catch(() => undefined)
        return false
      }
    },
    [transport, projects, deleteSession, refreshProjects],
  )

  const discardAndArchive = useCallback(async () => {
    if (!checkoutDelete) return
    setCheckoutDeleteBusy(true)
    try {
      await transport.request('thread.close', { threadId: checkoutDelete.id })
      await transport.request('thread.discardWorktree', {
        threadId: checkoutDelete.id,
        force: true,
      })
      await deleteSession(checkoutDelete.id)
      setCheckoutDelete(undefined)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
      await refreshProjects().catch(() => undefined)
    } finally {
      setCheckoutDeleteBusy(false)
    }
  }, [transport, checkoutDelete, deleteSession, refreshProjects])

  const startNewChat = useCallback(() => {
    if (sidebarSettings.mode === 'inbox' && projects.length > 1) {
      setPreferredNewThreadProject(activePath)
      setPaletteScope('new-thread')
      return
    }
    const path = activePath ?? projects[0]?.path
    if (path) beginSession(path)
    else void addProject()
  }, [activePath, projects, beginSession, addProject, sidebarSettings.mode])

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
        setProjects((current) =>
          current.map((project) => ({
            ...project,
            sessions: project.sessions.map((session) => {
              const lifecycle = lifecycles.get(session.id)
              return lifecycle ? { ...session, lifecycle } : session
            }),
          })),
        )
        const activeId = activeIdRef.current
        if (!activeId || !targets.includes(activeId)) return
        const current = findSession(projects, activeId)
        const hidden = new Set(targets)
        const next = projects
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
    [transport, projects, selectSession, beginSession, refreshProjects],
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
        setProjects((current) =>
          current.map((project) => ({
            ...project,
            sessions: project.sessions.map((session) => {
              const lifecycle = lifecycles.get(session.id)
              return lifecycle ? { ...session, lifecycle } : session
            }),
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
  const startSidebarSession = useCallback(
    (path?: string, chooseProject?: boolean) => {
      setSurface('chat')
      if (chooseProject && projects.length > 1) {
        setPreferredNewThreadProject(path ?? activePath)
        setPaletteScope('new-thread')
      } else if (path) beginSession(path)
      else if (projects.length === 1 && projects[0]) beginSession(projects[0].path)
      else {
        setPreferredNewThreadProject(activePath)
        setPaletteScope('new-thread')
      }
    },
    [projects, activePath, beginSession],
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
  const renameSidebarProject = useCallback(
    (path: string, name: string) => {
      setProjects((current) =>
        current.map((project) => (project.path === path ? { ...project, name } : project)),
      )
      void transport.request('projects.rename', { path, name }).catch(() => undefined)
    },
    [transport],
  )
  const removeSidebarProject = useCallback(
    (path: string) => {
      const previousActivePath = activePath
      setProjects((current) => current.filter((project) => project.path !== path))
      if (activePath === path) setActivePath(undefined)
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
    [transport, activePath, refreshProjects],
  )
  const toggleSidebarProjectPin = useCallback(
    (path: string) => {
      const pinned = !projects.find((project) => project.path === path)?.pinned
      setProjects((current) =>
        current.map((project) => (project.path === path ? { ...project, pinned } : project)),
      )
      void transport.request('projects.pin', { path, pinned }).catch(() => undefined)
    },
    [transport, projects],
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
      void transport.request('thread.rename', { threadId: id, title }).catch(() => undefined)
    },
    [transport],
  )
  const toggleSidebarSessionPin = useCallback(
    (id: string) => {
      const pinned = !findSession(projects, id)?.session.pinned
      setProjects((current) => updateSession(current, id, (session) => ({ ...session, pinned })))
      void transport.request('thread.pin', { threadId: id, pinned }).catch(() => undefined)
    },
    [transport, projects],
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
      const sessions = projects.flatMap((project) => project.sessions)
      if (sessions.length === 0) return
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
    [projects, activeId, selectSession],
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
    localStorage.clear()
    location.reload()
  }, [])
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
  const prepareBottomTerminalComposerMotion = useCallback(() => {
    const composer = stageBody.current?.querySelector<HTMLElement>('.composer__box')
    if (!composer) return
    const current = composer.getBoundingClientRect()
    bottomTerminalComposerOrigin.current = { left: current.left, top: current.top }
    for (const animation of composer.getAnimations?.() ?? []) {
      if (
        animation.id === 'harness-composer-dock' ||
        animation.id === 'harness-terminal-composer'
      ) {
        animation.cancel()
      }
    }
    bottomTerminalComposerAnimation.current = null
  }, [])
  const toggleTerminal = useCallback(() => {
    prepareBottomTerminalComposerMotion()
    setBottomTerminalPhase((phase) =>
      phase === 'closed' || phase === 'closing' ? 'opening' : 'closing',
    )
  }, [prepareBottomTerminalComposerMotion])
  const toggleDefaultTerminal = useCallback(() => {
    if (terminalPlacement === 'workspace') {
      if (!activePath) return
      setWorkspaceTerminalToggleRequest((request) => request + 1)
      return
    }
    if (!activePath) return
    toggleTerminal()
  }, [activePath, terminalPlacement, toggleTerminal])
  const closeTerminal = useCallback(() => {
    prepareBottomTerminalComposerMotion()
    setBottomTerminalPhase((phase) => (phase === 'opening' || phase === 'open' ? 'closing' : phase))
  }, [prepareBottomTerminalComposerMotion])
  const finishBottomTerminalMotion = useCallback((event: ReactTransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== 'transform') return
    setBottomTerminalPhase((phase) => (phase === 'closing' ? 'closed' : phase))
  }, [])
  const openWorkspacePanel = useCallback(() => {
    setWorkspacePanelOpen(true)
  }, [])
  const closeWorkspacePanel = useCallback(() => {
    setWorkspacePanelOpen(false)
    setWorkspacePanelExpanded(false)
  }, [])
  const openProviderLoginTerminal = useCallback(
    (target: ProviderLoginTerminalTarget) => {
      setProviderLoginTerminal({
        ...target,
        id: nextProviderLoginTerminalId.current++,
        visible: true,
        restorePanelOpen: workspacePanelOpen,
        restorePanelExpanded: workspacePanelExpanded,
      })
      setSettingsOpen(false)
      setWorkspacePanelOpen(true)
      setWorkspacePanelExpanded(true)
    },
    [workspacePanelExpanded, workspacePanelOpen],
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
      setSettingsSection('providers')
      setSettingsOpen(true)
    },
    [providerLoginState?.phase, providerLoginTerminal],
  )
  const toggleWorkspacePanel = useCallback(() => {
    if (workspacePanelOpen) setWorkspacePanelExpanded(false)
    setWorkspacePanelOpen((open) => !open)
  }, [workspacePanelOpen])
  const toggleExpandedWorkspacePanel = useCallback(() => {
    if (!workspacePanelOpen) {
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

      const definition = KEYBINDING_DEFINITIONS.find((candidate) =>
        matchesShortcut(event, keybindings[candidate.id]),
      )
      if (!definition) return

      event.preventDefault()
      keybindingActions[definition.id]()
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [checkoutDelete, keybindingActions, keybindings, paletteScope, rollbackOpen, settingsOpen])

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
  const searching = activeTurnIsSearching(
    thread.items,
    thread.activeTurn?.id,
    thread.liveItems,
    thread.liveStart,
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
      ...projects.map((project): PaletteCommand => ({
        id: `project-${encodeURIComponent(project.path)}`,
        title: displayName(project),
        detail: project.path,
        group: 'Projects',
        keywords: 'switch folder workspace',
        projectCommand: true,
        run: () => selectProject(project.path),
      })),
      ...projects.map((project): PaletteCommand => ({
        id: `new-chat-${encodeURIComponent(project.path)}`,
        title: `New thread in ${displayName(project)}`,
        detail: project.path,
        group: 'Projects',
        keywords: 'session conversation',
        newThreadProject: true,
        run: () => beginSession(project.path),
      })),
      ...projects.flatMap((project) =>
        project.sessions.map((session): PaletteCommand => ({
          id: `chat-${session.id}`,
          title: session.title,
          detail: displayName(project),
          group: 'Chats',
          keywords: `${project.path} open session conversation`,
          run: () => void selectSession(session.id),
        })),
      ),
    ]
  }, [
    paletteScope,
    activePath,
    startNewChat,
    addProject,
    openSettings,
    openPullRequests,
    active,
    activeId,
    collapsed,
    checkpoints.length,
    interrupt,
    keybindings,
    macOS,
    projects,
    selectProject,
    beginSession,
    selectSession,
    terminalOpen,
    terminalPlacement,
    thread.running,
    toggleSidebarSessionPin,
    toggleDefaultTerminal,
    toggleWorkspacePanel,
    workspacePanelOpen,
  ])

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
          onToggleWorkspace={workspacePanelOpen ? closeWorkspacePanel : openWorkspacePanel}
          onToggleTerminal={toggleTerminal}
        />
      ) : null}
      {isDesktop ? <ZoomHud /> : null}

      <div className="shell__body">
        <Sidebar
          projects={projects}
          activeProjectPath={activePath}
          activeSessionId={surface === 'chat' ? activeId : undefined}
          pullRequestsActive={surface === 'pull-requests'}
          providerName={providerName(provider, acpAgentName)}
          keybindings={keybindings}
          usageStates={usageState}
          onRetryUsage={refreshUsage}
          mode={sidebarSettings.mode}
          inbox={sidebarInbox}
          collapsed={collapsed}
          width={railWidth}
          account={account}
          profileIdentity={profileIdentity}
          onClose={closeSidebar}
          onWidthChange={resizeSidebar}
          onAddProject={addSidebarProject}
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
                <PullRequestsView transport={transport} onOpenChat={openPullRequestChat} />
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
                  ref={stageBody}
                  className={`stage__body${activeId ? '' : ' is-new-session'}${activePath && terminalOpen ? ' has-terminal' : ''}`}
                >
                  {activeId ? (
                    <Thread
                      items={thread.items}
                      loading={loadingThreadId === activeId}
                      liveItems={thread.liveItems}
                      itemVersion={thread.itemVersion}
                      liveStart={thread.liveStart}
                      projectPath={activePath}
                      running={visibleRunning}
                      searching={searching}
                      activeTurn={thread.activeTurn}
                      turnTiming={thread.turnTiming}
                      plan={thread.plan}
                      diff={thread.diff}
                      diffTurnId={thread.diffTurnId}
                      threadId={activeId}
                      transport={transport}
                      searchJump={searchJump?.threadId === activeId ? searchJump : undefined}
                      revealRequest={threadRevealRequest}
                      approvals={thread.approvals}
                      userInputs={thread.userInputs}
                      reviews={reviewList}
                      checkpoints={thread.running ? EMPTY_CHECKPOINTS : checkpoints}
                      onDecide={decideApproval}
                      onAnswerUserInput={answerUserInput}
                      onEditMessage={editMessage}
                      onRevertCheckpoint={revertCheckpoint}
                      onUndoChanges={undoTurnChanges}
                    />
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
                    projects={projects}
                    projectPath={activePath}
                    projectName={activeProject ? displayName(activeProject) : undefined}
                    branch={active?.session.worktreeBranch ?? workspace?.branch ?? branches[0]}
                    branches={branches}
                    models={selectableModels}
                    modelsLoaded={modelsLoaded}
                    modelId={selectedModelChoice?.key}
                    effort={selectedEffort}
                    serviceTier={selectedServiceTier}
                    usage={thread.usage}
                    approval={approval === 'auto-review' && !autoReviewSupported ? 'ask' : approval}
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
                    onDraftChange={updateRejectedDraft}
                    onAttachmentsChange={updateRejectedAttachments}
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

                  {activePath && (bottomTerminalMounted || bottomTerminalPrepared) ? (
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
                          <TerminalPane
                            key={`thread:${active.session.id}`}
                            transport={transport}
                            threadId={active.session.id}
                            height={terminalHeight}
                            theme={theme}
                            active={terminalOpen}
                            onHeightChange={setTerminalHeight}
                            onClose={closeTerminal}
                          />
                        ) : (
                          <TerminalPane
                            key={`project:${activePath}`}
                            transport={transport}
                            projectPath={activePath}
                            height={terminalHeight}
                            theme={theme}
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

          <Suspense fallback={null}>
            <WorkspacePanel
              open={workspacePanelOpen}
              expanded={workspacePanelExpanded}
              width={workspacePanelWidth}
              transport={transport}
              threadId={activeId}
              projectPath={activePath}
              projectName={activeProject ? displayName(activeProject) : undefined}
              branch={active?.session.worktreeBranch ?? workspace?.branch ?? branches[0]}
              theme={theme}
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
              providerLogin={
                providerLoginTerminal?.visible
                  ? {
                      id: providerLoginTerminal.id,
                      title: `${providerLoginTerminal.displayName} login`,
                      installKey: providerLoginTerminal.installKey,
                    }
                  : undefined
              }
              onProviderLoginClose={closeProviderLoginTerminal}
            />
          </Suspense>
        </div>
      </div>

      {settingsOpen ? (
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
      ) : null}

      {isDesktop &&
      projectsStatus === 'ready' &&
      projects.length === 0 &&
      !onboardingDismissed &&
      !settingsOpen ? (
        <WelcomeDialog
          providerStatuses={providerStatuses}
          onAddProject={() => void addProject()}
          onOpenProviders={() => openSettings('providers')}
          onDismiss={() => {
            writeSetting(ONBOARDING_KEY, 'done')
            setOnboardingDismissed(true)
          }}
        />
      ) : null}

      {paletteScope ? (
        <CommandPalette
          commands={commands}
          scope={paletteScope}
          preferredCommandId={
            paletteScope === 'new-thread' && preferredNewThreadProject
              ? `new-chat-${encodeURIComponent(preferredNewThreadProject)}`
              : undefined
          }
          onClose={closePalette}
        />
      ) : null}

      <SessionSearchHost
        ref={sessionSearch}
        transport={transport}
        projects={projects}
        onSelect={selectSessionSearchResult}
      />

      {rollbackOpen ? (
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
      ) : null}

      {checkoutDelete ? (
        <CheckoutDiscardDialog
          title={checkoutDelete.title}
          branch={checkoutDelete.branch}
          busy={checkoutDeleteBusy}
          onDiscard={() => void discardAndArchive()}
          onClose={() => setCheckoutDelete(undefined)}
        />
      ) : null}

      {/* A dropped connection used to be invisible: requests queued, pushes
          stopped, the working rail kept counting, and nothing said why. */}
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
  return Number.isFinite(stored) && stored >= 176 && stored <= 420 ? stored : 248
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

function findSession(projects: Project[], id: string | undefined) {
  if (!id) return undefined
  for (const project of projects) {
    const session = project.sessions.find((s) => s.id === id)
    if (session) return { project, session }
  }
  return undefined
}

function updateSession(
  projects: Project[],
  threadId: string,
  update: (session: Project['sessions'][number]) => Project['sessions'][number],
): Project[] {
  return projects.map((project) => ({
    ...project,
    sessions: project.sessions.map((session) =>
      session.id === threadId ? update(session) : session,
    ),
  }))
}

function markSessionRead(session: Project['sessions'][number]): Project['sessions'][number] {
  return {
    ...session,
    unread: false,
    status: session.status === 'ready' ? 'idle' : session.status,
    lifecycle:
      session.lifecycle.state === 'active' && session.lifecycle.wokeAt !== undefined
        ? { state: 'active', keepActive: session.lifecycle.keepActive }
        : session.lifecycle,
  }
}

function promoteSession(projects: Project[], threadId: string): Project[] {
  return projects.map((project) => {
    const index = project.sessions.findIndex((session) => session.id === threadId)
    if (index <= 0) return project
    const sessions = [...project.sessions]
    const [session] = sessions.splice(index, 1)
    return session ? { ...project, sessions: [session, ...sessions] } : project
  })
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

function putPendingSubmission(
  pending: Map<string, Map<string, PendingSubmission>>,
  threadId: string,
  submission: PendingSubmission,
): void {
  const thread = pending.get(threadId) ?? new Map()
  thread.set(submission.id, submission)
  pending.set(threadId, thread)
}

function deletePendingSubmission(
  pending: Map<string, Map<string, PendingSubmission>>,
  threadId: string,
  submissionId: string,
): void {
  const thread = pending.get(threadId)
  if (!thread) return
  thread.delete(submissionId)
  if (thread.size === 0) pending.delete(threadId)
}

function preservePendingSubmissions(
  state: ThreadState,
  pending: Map<string, Map<string, PendingSubmission>>,
  threadId: string,
): ThreadState {
  const thread = pending.get(threadId)
  if (!thread) return state
  let next = state
  for (const submission of thread.values()) {
    const existing = next.items.find((item) => item.id === submission.id)
    if (existing) {
      if (existing.turnId !== '') thread.delete(submission.id)
      continue
    }
    if (submission.kind === 'queue') continue
    next = appendUserMessage(
      next,
      submission.text,
      submission.id,
      submission.createdAt,
      submission.attachments,
    )
    if (!next.running && submission.optimisticTurn) {
      next = { ...next, running: true, activeTurn: submission.optimisticTurn }
    }
  }
  if (thread.size === 0) pending.delete(threadId)
  return next
}

function removePendingSubmission(state: ThreadState, submission: PendingSubmission): ThreadState {
  const next = removeOptimisticMessage(state, submission.id)
  return submission.optimisticTurn && next.activeTurn?.id === submission.optimisticTurn.id
    ? { ...next, running: false, activeTurn: undefined }
    : next
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

function displayName(project: Project): string {
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
  return projects.map((project) => ({
    ...project,
    sessions: project.sessions.map((session) =>
      session.id === threadId ? { ...session, title } : session,
    ),
  }))
}

type SessionOrder = Record<string, string[]>
const ProjectOrderSchema = z.array(z.string())
const SessionOrderSchema = z.record(z.string(), z.array(z.string()))

function loadProjectOrder(): string[] {
  try {
    return ProjectOrderSchema.parse(JSON.parse(readSetting(PROJECT_ORDER_KEY) ?? '[]'))
  } catch {
    return []
  }
}

function applyProjectOrder(projects: Project[], order: string[]): Project[] {
  const byPath = new Map(projects.map((project) => [project.path, project]))
  const known = order.flatMap((path) => {
    const project = byPath.get(path)
    if (!project) return []
    byPath.delete(path)
    return [project]
  })
  return [...byPath.values(), ...known]
}

let lastSavedProjectOrder: string | undefined

function saveProjectOrder(projects: Project[]): void {
  const serialized = JSON.stringify(projects.map((project) => project.path))
  if (serialized === lastSavedProjectOrder) return
  lastSavedProjectOrder = serialized
  writeSetting(PROJECT_ORDER_KEY, serialized)
}

function loadSessionOrder(): SessionOrder {
  try {
    return SessionOrderSchema.parse(JSON.parse(readSetting(SESSION_ORDER_KEY) ?? '{}'))
  } catch {
    return {}
  }
}

function applySessionOrder(
  projectPath: string,
  sessions: Project['sessions'],
  savedOrder: SessionOrder,
): Project['sessions'] {
  const order = savedOrder[projectPath] ?? []
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const known = order.flatMap((id) => {
    const session = byId.get(id)
    if (!session) return []
    byId.delete(id)
    return [session]
  })
  return [...byId.values(), ...known]
}

let lastSavedSessionOrder: string | undefined

function saveSessionOrder(projects: Project[]): void {
  const serialized = JSON.stringify(
    Object.fromEntries(
      projects.map((project) => [project.path, project.sessions.map((session) => session.id)]),
    ),
  )
  // `projects` is replaced on every status event of every thread; skipping
  // unchanged orders keeps this from writing to disk on each streamed frame.
  if (serialized === lastSavedSessionOrder) return
  lastSavedSessionOrder = serialized
  writeSetting(SESSION_ORDER_KEY, serialized)
}

const SourceSelectionSchema = z.object({
  modelKey: z.string(),
  effort: z.string().optional(),
  serviceTier: z.string().optional(),
})
const SourceSelectionsSchema = z.record(z.string(), SourceSelectionSchema)
type SourceSelection = z.infer<typeof SourceSelectionSchema>

function readSourceSelections(): Record<string, SourceSelection> {
  try {
    return SourceSelectionsSchema.parse(JSON.parse(readSetting(MODEL_BY_SOURCE_KEY) ?? '{}'))
  } catch {
    return {}
  }
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
