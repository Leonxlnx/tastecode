import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CSSProperties } from 'react'
import { LoaderCircle } from 'lucide-react'
import type {
  Account,
  ApprovalDecision,
  ApprovalMode,
  DomainEvent,
  ModelConnection,
  ProviderId,
  ProviderStatus,
  QueuedTurn,
  ResultOf,
  SidebarSettings,
} from '@harness/contracts'
import { isDesktop, isMacOS, pickFolder, setDesktopTheme } from './bridge.js'
import { isEditableTarget, matchesShortcut, SHORTCUTS, shortcutLabel } from './shortcuts.js'
import { warmHighlighter } from './ui/highlighter.js'
import { Transport } from './transport.js'
import {
  appendUserMessage,
  beginOptimisticTurn,
  emptyThread,
  reduce,
  reduceDeltas,
  reduceEventLog,
  removeQueuedOptimisticMessage,
  type ItemDeltaEvent,
  type ThreadState,
} from './thread-store.js'
import { CommandPalette, type CommandScope, type PaletteCommand } from './ui/CommandPalette.js'
import { CheckoutDiscardDialog } from './ui/CheckoutDiscardDialog.js'
import { Composer, type WorkspaceInfo } from './ui/Composer.js'
import { Onboarding } from './ui/Onboarding.js'
import { RollbackDialog, type Checkpoint } from './ui/RollbackDialog.js'
import { SessionSearch } from './ui/SessionSearch.js'
import { Settings } from './ui/Settings.js'
import { Sidebar, type Project } from './ui/Sidebar.js'
import { StageHeader } from './ui/StageHeader.js'
import { Thread } from './ui/Thread.js'
import { TitleBar } from './ui/TitleBar.js'
import { ZoomHud } from './ui/ZoomHud.js'
import { serverUrl } from './server-url.js'
import { addDesignBriefing } from './design-agent/briefing.js'
import { canCaptureVoice, type VoiceRecording } from './voice-recorder.js'
import {
  agentMark,
  choicesFor,
  connectionMark,
  providerMark,
  resolveReasoningEffort,
  sourceKey,
  type ModelChoice,
} from './model-catalog.js'
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

const SERVER_BASE_URL = import.meta.env.VITE_HARNESS_SERVER_URL ?? 'ws://127.0.0.1:4311'
const SETUP_KEY = 'harness.provider'
/** Which ACP agent was chosen. Meaningless unless the provider is `acp`. */
const AGENT_KEY = 'harness.acpAgent'
const AGENT_NAME_KEY = 'harness.acpAgentName'
const PROJECTS_KEY = 'harness.projects'
const SESSION_ORDER_KEY = 'harness.sessionOrder'
const MODEL_KEY = 'harness.model'
/** Stable identity: a fresh [] every render re-renders every thread row. */
const EMPTY_CHECKPOINTS: Checkpoint[] = []
const EMPTY_PALETTE_COMMANDS: PaletteCommand[] = []
const HIDDEN_MODELS_KEY = 'harness.hiddenModels'
const EFFORT_KEY = 'harness.effort'
const SERVICE_TIER_KEY = 'harness.serviceTier'
const APPROVAL_KEY = 'harness.approval'
const MACOS_FONT_SMOOTHING_KEY = 'harness.macosFontSmoothing'
const TERMINAL_OPEN_KEY = 'harness.terminal.open'
const TERMINAL_HEIGHT_KEY = 'harness.terminal.height'
const RAIL_WIDTH_KEY = 'harness.rail.width'
const DEFAULT_SIDEBAR_SETTINGS: SidebarSettings = { mode: 'inbox', autoSettleDays: 3 }
const TerminalPane = lazy(() =>
  import('./ui/TerminalPane.js').then((module) => ({ default: module.TerminalPane })),
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
    const parsed = JSON.parse(raw) as Array<{ path?: string; name?: string }>
    return parsed
      .filter((entry): entry is { path: string; name?: string } => typeof entry.path === 'string')
      .map(({ path, name }) => ({ path, ...(name ? { name } : {}) }))
  } catch {
    return []
  }
}

export function App() {
  const [connectionUrl, setConnectionUrl] = useState(() => serverUrl(SERVER_BASE_URL))
  const transport = useMemo(() => new Transport(connectionUrl), [connectionUrl])
  const [provider, setProvider] = useState<ProviderId | null>(() => {
    // Validated like every other stored key: a provider id from an older
    // build would skip onboarding and send every request somewhere the
    // server rejects — a broken app whose only cure was a full reset.
    const stored = readSetting(SETUP_KEY)
    const known: string[] = ['codex', 'claude-code', 'cursor', 'opencode', 'acp', 'api']
    return stored !== null && known.includes(stored) ? (stored as ProviderId) : null
  })
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
  const [projectsLoaded, setProjectsLoaded] = useState(false)
  /** The thread whose interrupt has been sent but not yet acknowledged. */
  const [stoppingThreadId, setStoppingThreadId] = useState<string | undefined>()
  const [offline, setOffline] = useState(false)
  const [activeId, setActiveId] = useState<string | undefined>()
  const [activePath, setActivePath] = useState<string | undefined>()
  const [thread, setThread] = useState<ThreadState>(emptyThread)
  /** A fresh array every streamed frame would defeat any memo below it. */
  const reviewList = useMemo(() => Object.values(thread.reviews), [thread.reviews])
  const [usageSummary, setUsageSummary] = useState<ResultOf<'usage.summary'> | undefined>()
  // Every live session keeps reducing events while it is off screen. A ref is
  // intentional: streamed deltas for a background session should not rerender
  // the active thread, while selecting it still gets the latest state at once.
  const threadStates = useRef(new Map<string, ThreadState>())
  /** Live events parked while a history fetch for the thread is in flight. */
  const historyBuffers = useRef(
    new Map<string, Array<{ seq: number | undefined; event: DomainEvent }>>(),
  )
  const pendingThreadDeltas = useRef(new Map<string, ItemDeltaEvent[]>())
  const queueStates = useRef(new Map<string, { items: QueuedTurn[]; canSteer: boolean }>())
  const pendingSession = useRef<
    | {
        id: string
        promise: Promise<string | undefined>
        threadId?: string | undefined
      }
    | undefined
  >(undefined)
  const [queuedTurns, setQueuedTurns] = useState<QueuedTurn[]>([])
  const [canSteerQueue, setCanSteerQueue] = useState(false)
  const [models, setModels] = useState<ModelChoice[]>([])
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [providerStatuses, setProviderStatuses] = useState<ProviderStatus[]>([])
  const [acpAgents, setAcpAgents] = useState<ResultOf<'acp.agents'>['agents']>([])
  const [modelConnections, setModelConnections] = useState<ModelConnection[]>([])
  const [catalogRequest, setCatalogRequest] = useState(0)
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(readSetting(HIDDEN_MODELS_KEY) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
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
  const [account, setAccount] = useState<Account | undefined>()
  const [voiceAvailable, setVoiceAvailable] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarSettings, setSidebarSettings] = useState(DEFAULT_SIDEBAR_SETTINGS)
  const [paletteScope, setPaletteScope] = useState<CommandScope | null>(null)
  const [preferredNewThreadProject, setPreferredNewThreadProject] = useState<string>()
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false)
  const [sessionSearchProject, setSessionSearchProject] = useState<string>()
  const [searchJump, setSearchJump] = useState<{
    threadId: string
    turnId: string
    request: number
  }>()
  const [composerFocusRequest, setComposerFocusRequest] = useState(0)
  const [composerDraft, setComposerDraft] = useState<{ text: string; request: number }>()
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
  const [terminalOpen, setTerminalOpen] = useState(() => readSetting(TERMINAL_OPEN_KEY) === 'true')
  const [terminalHeight, setTerminalHeight] = useState(readTerminalHeight)
  const visibleModels = useMemo(
    () => models.filter((choice) => !hiddenModels.has(choice.key)),
    [models, hiddenModels],
  )
  // Memoised for identity: while the catalog is empty this is the selected
  // choice, and a fresh object per render would give every consumer downstream
  // (including effects that write settings) a new dependency each frame.
  const implicitChoice = useMemo(
    () =>
      provider && provider !== 'api'
        ? choicesFor(
            {
              provider,
              sourceName: providerName(provider, acpAgentName),
              mark: provider === 'acp' && acpAgent ? agentMark(acpAgent) : providerMark(provider),
              ...(provider === 'acp' && acpAgent
                ? { agent: { id: acpAgent, name: acpAgentName ?? acpAgent } }
                : {}),
            },
            [],
            true,
          )[0]
        : undefined,
    [provider, acpAgent, acpAgentName],
  )
  const selectedModelChoice =
    models.find((choice) => choice.key === modelId) ??
    visibleModels[0] ??
    models[0] ??
    implicitChoice

  // Syntax grammars load in the background from the first frame, so the first
  // code block an agent produces is already coloured.
  useEffect(warmHighlighter, [])

  useEffect(() => {
    const reconnectWithCurrentToken = () => setConnectionUrl(serverUrl(SERVER_BASE_URL))
    window.addEventListener('hashchange', reconnectWithCurrentToken)
    return () => window.removeEventListener('hashchange', reconnectWithCurrentToken)
  }, [])

  useLayoutEffect(() => {
    applyTheme(theme)
    void setDesktopTheme(theme)
  }, [theme])

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
    writeSetting(TERMINAL_HEIGHT_KEY, String(terminalHeight))
  }, [terminalHeight])

  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  /** Refetch after an outage. Held in a ref because the transport effect is
   *  set up before the fetchers it needs are declared. */
  const resync = useRef<() => void>(() => {})
  const sidebarSettingsRef = useRef(sidebarSettings)
  sidebarSettingsRef.current = sidebarSettings

  useEffect(() => {
    // Deltas arrive far faster than frames are drawn. Fold and render one batch
    // per animation frame so a provider burst copies the item list once, not
    // once per token. A non-delta first flushes its thread synchronously, which
    // preserves event order and keeps approvals, boundaries, and completions
    // immediate.
    let liveFlush: number | undefined
    const applyPendingDeltas = (threadId: string) => {
      const deltas = pendingThreadDeltas.current.get(threadId)
      const current = threadStates.current.get(threadId) ?? emptyThread
      if (!deltas || deltas.length === 0) return current
      pendingThreadDeltas.current.delete(threadId)
      const next = reduceDeltas(current, deltas)
      threadStates.current.set(threadId, next)
      return next
    }
    const flushLive = () => {
      liveFlush = undefined
      for (const threadId of pendingThreadDeltas.current.keys()) applyPendingDeltas(threadId)
      const id = activeIdRef.current
      if (id) setThread(threadStates.current.get(id) ?? emptyThread)
    }
    const offEvents = transport.on('thread.event', ({ threadId, event, seq }) => {
      // While a history load is in flight, the fetched state will replace the
      // cache — record the event so it can be replayed on top. Non-deltas
      // apply immediately below; deltas join the same frame batch as rendering.
      historyBuffers.current.get(threadId)?.push({ seq, event })
      if (event.type === 'item.delta') {
        const pending = pendingThreadDeltas.current.get(threadId)
        if (pending) pending.push(event)
        else pendingThreadDeltas.current.set(threadId, [event])
        liveFlush ??= requestAnimationFrame(flushLive)
        return
      }

      const next = reduce(applyPendingDeltas(threadId), event)
      threadStates.current.set(threadId, next)

      if (threadId === activeIdRef.current) {
        if (liveFlush !== undefined && pendingThreadDeltas.current.size === 0) {
          cancelAnimationFrame(liveFlush)
          liveFlush = undefined
        }
        setThread(next)
      }
      if (threadId === activeIdRef.current && endsDesignBriefing(event)) setDesignMode(false)

      if (affectsSessionStatus(event)) {
        setProjects((current) => {
          const updated = updateSession(current, threadId, (session) => {
            const status = statusFor(next, event, threadId !== activeIdRef.current)
            return {
              ...session,
              status,
              statusSince: status === session.status ? session.statusSince : Date.now(),
              ...(event.type === 'turn.completed'
                ? { unread: threadId !== activeIdRef.current }
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
          void transport
            .request('usage.summary', { threadId })
            .then((summary) => {
              if (threadId === activeIdRef.current) setUsageSummary(summary)
            })
            .catch(() => undefined)
        }
      }
    })
    const offQueue = transport.on('thread.queue', ({ threadId, items, canSteer }) => {
      queueStates.current.set(threadId, { items, canSteer })
      if (threadId !== activeIdRef.current) return
      setQueuedTurns(items)
      setCanSteerQueue(canSteer)
    })
    const offLifecycle = transport.on('thread.lifecycle', ({ threadId, lifecycle }) => {
      setProjects((current) =>
        updateSession(current, threadId, (session) => ({ ...session, lifecycle })),
      )
    })
    const offSidebarSettings = transport.on('sidebar.settings', setSidebarSettings)
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
        // Pushes sent while the socket was down are in the durable log but
        // were never delivered, and sequence numbers restart per connection
        // so the gap detector cannot see it. Without this the thread stays
        // silently truncated — an answer cut mid-sentence, an approval that
        // was already resolved still asking — until the user switches
        // sessions and back.
        if (state === 'open' && missedPushes) {
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
      offEvents()
      offQueue()
      offLifecycle()
      offSidebarSettings()
      offState()
      transport.close()
    }
  }, [transport])

  useEffect(() => {
    let cancelled = false
    void transport
      .request('sidebar.settings', {})
      .then((settings) => {
        if (!cancelled) setSidebarSettings(settings)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [transport])

  // Build one catalog from every connected source. Model ids are not globally
  // unique, so each choice keeps the provider/connection that will pay for it.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [providersResult, connectionsResult, agentsResult] = await Promise.all([
        transport.request('providers.list', {}),
        transport.request('connections.list', {}).catch(() => ({ connections: [] })),
        transport.request('acp.agents', {}).catch(() => ({ agents: [] })),
      ])
      const providers = providersResult?.providers ?? []
      const connections = connectionsResult?.connections ?? []
      const direct = await Promise.all(
        providers
          .filter((entry) => entry.installed && entry.id !== 'acp' && entry.id !== 'api')
          .map(async (entry) => {
            const result = await transport
              .request('models.list', { provider: entry.id })
              .catch(() => ({ models: [] }))
            return choicesFor(
              {
                provider: entry.id,
                sourceName: entry.displayName,
                mark: providerMark(entry.id),
              },
              result.models,
              false,
            )
          }),
      )
      const acp = (agentsResult?.agents ?? [])
        .filter((agent) => agent.installed)
        .map(async (agent) => {
          const result = await transport
            .request('models.list', { provider: 'acp', agent: agent.id })
            .catch(() => ({ models: [] }))
          return choicesFor(
            {
              provider: 'acp',
              sourceName: agent.name,
              mark: agentMark(agent.id),
              agent: { id: agent.id, name: agent.name },
            },
            result.models,
            false,
          )
        })
      const api = (
        await Promise.all(
          connections
            .filter((connection) => connection.enabled && connection.credentialConfigured)
            .map(async (connection) => {
              const result = await transport
                .request('connections.models', { connectionId: connection.id })
                .catch(() => ({ models: [] }))
              return choicesFor(
                {
                  provider: 'api',
                  connectionId: connection.id,
                  sourceName: connection.displayName,
                  mark: connectionMark(connection.preset),
                },
                result.models.length > 0
                  ? result.models
                  : connection.defaultModel
                    ? [
                        {
                          id: connection.defaultModel,
                          displayName: connection.defaultModel,
                          isDefault: true,
                          reasoningEfforts: [],
                          serviceTiers: [],
                        },
                      ]
                    : [],
              )
            }),
        )
      ).flat()
      if (cancelled) return
      const catalog = [...direct.flat(), ...(await Promise.all(acp)).flat(), ...api]
      setProviderStatuses(providers)
      setAcpAgents(agentsResult?.agents ?? [])
      setModelConnections(connections)
      setModels(catalog)
      setModelsLoaded(true)
      const stored = readSetting(MODEL_KEY)
      // Fallbacks respect hidden models: adding an API key must not silently
      // switch the user onto a model they explicitly hid. An explicit stored
      // choice still wins — hiding is about the list, not about revoking a
      // selection the user made themselves.
      const hidden = hiddenModelsRef.current
      const visible = catalog.filter((choice) => !hidden.has(choice.key))
      const pool = visible.length > 0 ? visible : catalog
      const selected =
        catalog.find((choice) => choice.key === stored) ??
        catalog.find((choice) => choice.model.id === stored) ??
        pool.find((choice) => choice.model.isDefault) ??
        pool[0]
      if (!selected) return
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
      setEffort((current) =>
        resolveReasoningEffort({ currentEffort: current, nextModel: selected.model }),
      )
      setServiceTier((current) =>
        current && selected.model.serviceTiers.some((tier) => tier.id === current)
          ? current
          : (selected.model.defaultServiceTier ?? undefined),
      )
    })().catch(() => {
      if (!cancelled) setModelsLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [transport, catalogRequest])

  useEffect(() => {
    if (!isDesktop || !provider || !canCaptureVoice()) {
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
  }, [transport, provider, account?.signedIn])

  useEffect(() => {
    if (!provider) return
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

  // Branches and uncommitted size for the composer shelf. Re-read after every
  // turn, because the agent is exactly what changes them.
  useEffect(() => {
    if (!activePath) {
      setWorkspace(undefined)
      setBranches([])
      return
    }
    let cancelled = false
    void (async () => {
      const info = await transport
        .request('workspace.info', { path: activePath })
        .catch(() => undefined)
      if (cancelled) return
      setWorkspace(info)

      const result = await transport
        .request('workspace.branches', { path: activePath })
        .catch(() => undefined)
      if (cancelled) return
      setBranches(result?.branches ?? (info?.branch ? [info.branch] : []))
    })().catch(() => {
      if (cancelled) return
      setBranches([])
    })
    return () => {
      cancelled = true
    }
  }, [transport, activePath, thread.running])

  useEffect(() => {
    if (!provider) return
    void transport
      .request('auth.status', { provider })
      .then(setAccount)
      .catch(() => setAccount(undefined))
  }, [transport, provider])

  const refreshProjects = useCallback(async () => {
    const { projects: list } = await transport.request('projects.list', {})
    setProjectsLoaded(true)
    const savedOrder = loadSessionOrder()
    setProjects(
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
              ...(session.worktreeBranch ? { worktreeBranch: session.worktreeBranch } : {}),
            }
          }),
          savedOrder,
        ),
      })),
    )
    setActivePath((current) => current ?? list[0]?.path)
  }, [transport])

  const refreshCheckpoints = useCallback(
    async (threadId: string) => {
      const result = await transport.request('thread.checkpoints', { threadId })
      if (activeIdRef.current === threadId) setCheckpoints(result.checkpoints)
    },
    [transport],
  )

  const loadHistory = useCallback(
    async (threadId: string) => {
      // Live pushes landing during this round trip are buffered (see the
      // thread.event handler) and re-applied on top of the fetched history —
      // overwriting the cache blindly used to silently drop them.
      historyBuffers.current.set(threadId, [])
      try {
        const { events } = await transport.request('thread.history', { threadId })
        const restored = reduceEventLog(emptyThread, events)
        const lastSeq = events.at(-1)?.seq ?? 0
        const buffered = historyBuffers.current.get(threadId) ?? []
        const withLive = reduceEventLog(restored, buffered, lastSeq)
        // The buffered events above already include any deltas still waiting
        // for a frame, so do not apply that pending batch a second time.
        pendingThreadDeltas.current.delete(threadId)
        threadStates.current.set(threadId, withLive)
        setProjects((current) => updateSession(current, threadId, markSessionRead))
        if (activeIdRef.current === threadId) setThread(withLive)
      } finally {
        historyBuffers.current.delete(threadId)
      }
    },
    [transport],
  )

  resync.current = () => {
    const id = activeIdRef.current
    if (id && !id.startsWith('pending:')) void loadHistory(id).catch(() => undefined)
    void refreshProjects().catch(() => undefined)
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
    void transport
      .request('thread.queue', { threadId: activeId })
      .then((state) => {
        if (cancelled) return
        queueStates.current.set(activeId, state)
        if (activeIdRef.current !== activeId) return
        setQueuedTurns(state.items)
        setCanSteerQueue(state.canSteer)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [transport, activeId])

  useEffect(() => {
    if (!activeId || thread.running) {
      if (!activeId) setCheckpoints([])
      return
    }
    void refreshCheckpoints(activeId).catch(() => setCheckpoints([]))
  }, [activeId, thread.running, refreshCheckpoints])

  const usageThreadId = activeId && !activeId.startsWith('pending:') ? activeId : undefined

  useEffect(() => {
    if (!provider) {
      setUsageSummary(undefined)
      return
    }
    let cancelled = false
    void transport
      .request('usage.summary', usageThreadId ? { threadId: usageThreadId } : { provider })
      .then((summary) => {
        if (!cancelled) setUsageSummary(summary)
      })
      .catch(() => {
        if (!cancelled) setUsageSummary(undefined)
      })
    return () => {
      cancelled = true
    }
  }, [transport, usageThreadId, provider])

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
      if (!cancelled) await refreshProjects().catch(() => undefined)
    })()
    return () => {
      cancelled = true
    }
  }, [transport, refreshProjects])

  useEffect(() => {
    if (projects.length > 0) saveSessionOrder(projects)
  }, [projects])

  useEffect(() => {
    if (modelId) writeSetting(MODEL_KEY, modelId)
  }, [modelId])

  useEffect(() => {
    writeSetting(HIDDEN_MODELS_KEY, JSON.stringify([...hiddenModels]))
  }, [hiddenModels])

  useEffect(() => {
    if (selectedModelChoice && hiddenModels.has(selectedModelChoice.key)) {
      const fallback = visibleModels[0]
      if (fallback) setModelId(fallback.key)
    }
  }, [hiddenModels, selectedModelChoice, visibleModels])

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

  useEffect(() => {
    writeSetting(APPROVAL_KEY, approval)
  }, [approval])

  const selectModel = useCallback(
    (id: string) => {
      const selected = models.find((model) => model.key === id)
      if (!selected) return
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
      setEffort((current) =>
        resolveReasoningEffort({
          currentEffort: current,
          currentModel: selectedModelChoice?.model,
          nextModel: selected.model,
        }),
      )
      setServiceTier((current) =>
        current && selected.model.serviceTiers.some((tier) => tier.id === current)
          ? current
          : (selected.model.defaultServiceTier ?? undefined),
      )
    },
    [models, selectedModelChoice],
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

  const createSession = useCallback(
    async (
      projectPath: string,
      provisionalId: string,
      title: string,
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
          ...(choice.connectionId ? { connectionId: choice.connectionId } : {}),
          ...(choice.model.id ? { model: choice.model.id } : {}),
          ...(serviceTier ? { serviceTier } : {}),
          ...(effort ? { effort } : {}),
          ...(isolateSession ? { isolate: true } : {}),
        })
        const provisional = threadStates.current.get(provisionalId) ?? emptyThread
        threadStates.current.delete(provisionalId)
        threadStates.current.set(threadId, provisional)
        if (pendingSession.current?.id === provisionalId) pendingSession.current.threadId = threadId
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
                            title,
                            provider: choice.provider,
                            ...(choice.agent ? { agent: choice.agent.id } : {}),
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
          .request('thread.rename', { threadId, title })
          .catch(() => undefined)
          .then(() => refreshProjects())
          .catch(() => undefined)
        return threadId
      } catch (error) {
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
      serviceTier,
      effort,
      approval,
      autoReviewSupported,
      isolateSession,
      refreshProjects,
    ],
  )

  const beginSession = useCallback(
    (projectPath: string) => {
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
          await transport.request('thread.delete', { threadId: session.id }).catch(() => undefined)
        }
        await refreshProjects().catch(() => undefined)
      })()
      setNotice(undefined)
      setActivePath(projectPath)
      activeIdRef.current = undefined
      setActiveId(undefined)
      setThread(emptyThread)
    },
    [projects, transport, refreshProjects],
  )

  const updateQueue = useCallback(
    (threadId: string, update: (items: QueuedTurn[]) => QueuedTurn[]) => {
      const current = queueStates.current.get(threadId) ?? { items: [], canSteer: false }
      const next = { ...current, items: update(current.items) }
      queueStates.current.set(threadId, next)
      if (activeIdRef.current === threadId) setQueuedTurns(next.items)
    },
    [],
  )

  const send = useCallback(
    async (text: string, attachments: string[] = [], submission: 'queue' | 'steer' = 'queue') => {
      // The composer clears itself the moment it hands the text over. Every
      // early bail below must put the words back — a toast is no substitute
      // for the paragraph someone just typed.
      const restoreDraft = () =>
        setComposerDraft((current) => ({ text, request: (current?.request ?? 0) + 1 }))
      // Design briefing questions are Harness-owned and answered by the server,
      // so they work for every provider that can complete a text turn — no
      // structured-input capability gate here (that gates provider-originated
      // input only).
      const briefing = designMode
      const turnAttachments = briefing ? addDesignBriefing(attachments) : attachments
      // Typing first and having the session appear is the natural order. Making
      // the user press "new session" before they are allowed to type is the
      // app's bookkeeping leaking into their way of working.
      let threadId = activeId
      let optimisticAdded = false
      let optimisticTurnId: string | undefined
      let titledOnCreate = false
      if (!threadId) {
        if (!activePath) {
          restoreDraft()
          return
        }
        const provisionalId = `pending:${crypto.randomUUID()}`
        const provisional = beginOptimisticTurn(emptyThread, text)
        const choice = selectedModelChoice
        if (!choice) {
          restoreDraft()
          return
        }
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
                      ...(choice.agent ? { agent: choice.agent.id } : {}),
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
        const promise = createSession(activePath, provisionalId, titleFrom(text))
        pendingSession.current = { id: provisionalId, promise }
        threadId = await promise
        if (pendingSession.current?.id === provisionalId) pendingSession.current = undefined
        if (!threadId) {
          const current = threadStates.current.get(provisionalId)
          if (current !== undefined && current.activeTurn?.id === optimisticTurnId) {
            const next: ThreadState = { ...current, running: false, activeTurn: undefined }
            threadStates.current.set(provisionalId, next)
            if (activeIdRef.current === provisionalId) setThread(next)
          }
          restoreDraft()
          return
        }
        optimisticAdded = true
        titledOnCreate = true
      } else if (pendingSession.current?.id === threadId) {
        const pending = pendingSession.current
        const targetId = pending.threadId ?? pending.id
        const provisional = appendUserMessage(
          threadStates.current.get(targetId) ?? emptyThread,
          text,
        )
        threadStates.current.set(targetId, provisional)
        if (activeIdRef.current === targetId) setThread(provisional)
        setThreadRevealRequest((request) => request + 1)
        threadId = await pending.promise
        if (!threadId) {
          restoreDraft()
          return
        }
        optimisticAdded = true
      }

      setNotice(undefined)
      setUndoRestore(undefined)

      const before = threadStates.current.get(threadId) ?? emptyThread
      const wasRunning = before.running && !optimisticAdded
      const steering = submission === 'steer'
      const beforeItemIds = new Set(before.items.map((item) => item.id))
      const optimisticQueueId =
        wasRunning && !steering ? `pending:${crypto.randomUUID()}` : undefined
      if (!wasRunning && !optimisticAdded) {
        const next = beginOptimisticTurn(before, text)
        optimisticTurnId = next.activeTurn?.id
        threadStates.current.set(threadId, next)
        if (threadId === activeIdRef.current) {
          setThread(next)
          setThreadRevealRequest((request) => request + 1)
        }
      }
      if (optimisticQueueId) {
        updateQueue(threadId, (items) => [
          ...items,
          { id: optimisticQueueId, text, attachments, createdAt: Date.now() },
        ])
      }

      // A session named after what was asked of it is findable a week later;
      // "New session" is not. Named from the first message only.
      //
      // A session created a moment ago is untitled by definition — `projects`
      // here is still the value from this render and cannot know about it yet,
      // so asking it would answer no every time and nothing would be named.
      const untitled =
        !titledOnCreate && findSession(projects, threadId)?.session.title === 'New session'
      if (untitled) {
        const title = titleFrom(text)
        setProjects((current) => promoteSession(renameSession(current, threadId, title), threadId))
        void transport.request('thread.rename', { threadId, title }).catch(() => undefined)
      }
      try {
        const result = await transport.request('thread.sendTurn', {
          threadId,
          text,
          ...(turnAttachments.length > 0 ? { attachments: turnAttachments } : {}),
          ...(selectedModelChoice?.model.id ? { model: selectedModelChoice.model.id } : {}),
          ...(effort ? { effort } : {}),
          ...(serviceTier ? { serviceTier } : {}),
        })
        const current = threadStates.current.get(threadId) ?? emptyThread
        if (result.queued) {
          if (steering) {
            await transport.request('thread.steerQueuedTurn', {
              threadId,
              queuedTurnId: result.queuedTurn.id,
            })
            const afterSteer = threadStates.current.get(threadId) ?? emptyThread
            const canonicalArrived = afterSteer.items.some(
              (item) =>
                !beforeItemIds.has(item.id) && item.role === 'user' && item.text?.trim() === text,
            )
            if (!canonicalArrived) {
              const next = appendUserMessage(afterSteer, text)
              threadStates.current.set(threadId, next)
              if (threadId === activeIdRef.current) setThread(next)
            }
          } else {
            updateQueue(threadId, (items) => {
              const withoutOptimistic = optimisticQueueId
                ? items.filter((item) => item.id !== optimisticQueueId)
                : items
              return withoutOptimistic.some((item) => item.id === result.queuedTurn.id)
                ? withoutOptimistic
                : [...withoutOptimistic, result.queuedTurn]
            })
            if (!wasRunning) {
              const reconciled = removeQueuedOptimisticMessage(current, text)
              threadStates.current.set(threadId, reconciled)
              if (threadId === activeIdRef.current) setThread(reconciled)
            }
          }
        } else if (!result.queued && wasRunning) {
          if (optimisticQueueId) {
            updateQueue(threadId, (items) => items.filter((item) => item.id !== optimisticQueueId))
          }
          const canonicalArrived = current.items.some(
            (item) =>
              !beforeItemIds.has(item.id) && item.role === 'user' && item.text?.trim() === text,
          )
          if (!canonicalArrived) {
            const next = appendUserMessage(current, text)
            threadStates.current.set(threadId, next)
            if (threadId === activeIdRef.current) setThread(next)
          }
        }
      } catch (error) {
        if (optimisticQueueId) {
          updateQueue(threadId, (items) => items.filter((item) => item.id !== optimisticQueueId))
        }
        const current = threadStates.current.get(threadId)
        // Any locally-invented turn must be rolled back on failure, not only
        // the one whose id this call happens to remember — a stranded
        // optimistic turn keeps the composer stuck on Stop until a reload.
        if (
          current !== undefined &&
          (current.activeTurn?.id === optimisticTurnId ||
            current.activeTurn?.id.startsWith('local-turn:') === true)
        ) {
          const next: ThreadState = { ...current, running: false, activeTurn: undefined }
          threadStates.current.set(threadId, next)
          if (threadId === activeIdRef.current) setThread(next)
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
      effort,
      serviceTier,
      updateQueue,
      designMode,
    ],
  )

  const interrupt = useCallback(() => {
    // A provisional id means the thread is still being created server-side;
    // interrupting it would only produce an error nobody can act on.
    if (!activeId || activeId.startsWith('pending:')) return
    // Some providers take a second or two to unwind. Without an acknowledged
    // state the button looks inert, so people press it repeatedly and
    // conclude that stopping does not work.
    setStoppingThreadId(activeId)
    transport.request('thread.interrupt', { threadId: activeId }).catch((error) => {
      setStoppingThreadId((current) => (current === activeId ? undefined : current))
      setNotice(error instanceof Error ? error.message : String(error))
    })
  }, [transport, activeId])

  // The turn ending — however it ended — clears the pending state. Switching
  // sessions does too: the badge belongs to the thread, not to the composer.
  const stopping = stoppingThreadId !== undefined && stoppingThreadId === activeId && thread.running
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
      if (changedProvider === provider) setAccount(changedAccount)
    },
    [provider],
  )

  const deleteQueuedTurn = useCallback(
    (queuedTurnId: string) => {
      if (!activeId) return
      void transport
        .request('thread.deleteQueuedTurn', { threadId: activeId, queuedTurnId })
        .catch((error) => setNotice(error instanceof Error ? error.message : String(error)))
    },
    [transport, activeId],
  )

  const moveQueuedTurn = useCallback(
    (queuedTurnId: string, direction: 'up' | 'down') => {
      if (!activeId) return
      void transport
        .request('thread.moveQueuedTurn', { threadId: activeId, queuedTurnId, direction })
        .catch((error) => setNotice(error instanceof Error ? error.message : String(error)))
    },
    [transport, activeId],
  )

  const steerQueuedTurn = useCallback(
    (queuedTurnId: string) => {
      if (!activeId) return
      void transport
        .request('thread.steerQueuedTurn', { threadId: activeId, queuedTurnId })
        .catch((error) => setNotice(error instanceof Error ? error.message : String(error)))
    },
    [transport, activeId],
  )

  const selectProject = useCallback(
    (path: string) => {
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
      const found = findSession(projects, id)
      if (found?.session.provider) {
        setProvider(found.session.provider)
        setAcpAgent(found.session.agent)
        const source = sourceKey({
          provider: found.session.provider,
          agentId: found.session.agent,
        })
        const matchingChoice = models.find((choice) => choice.key.startsWith(`${source}:`))
        if (matchingChoice) {
          setModelId(matchingChoice.key)
          // Same reconciliation as selectModel: carrying the previous model's
          // effort/tier into one that does not offer them sends a parameter
          // the server rejects.
          setEffort((current) =>
            resolveReasoningEffort({
              currentEffort: current,
              currentModel: selectedModelChoice?.model,
              nextModel: matchingChoice.model,
            }),
          )
          setServiceTier((current) =>
            current && matchingChoice.model.serviceTiers.some((tier) => tier.id === current)
              ? current
              : (matchingChoice.model.defaultServiceTier ?? undefined),
          )
        }
      }
      setNotice(undefined)
      setUndoRestore(undefined)
      setRollbackOpen(false)
      activeIdRef.current = id
      setActiveId(id)
      setThreadRevealRequest((request) => request + 1)
      setActivePath(found?.project.path)
      const cached = threadStates.current.get(id)
      if (cached) {
        setThread(cached)
        setProjects((current) => updateSession(current, id, markSessionRead))
        // Mark-as-read only; the cache is kept current by the live event
        // stream, so don't ask the server to replay the whole log.
        void transport
          .request('thread.history', { threadId: id, afterSeq: Number.MAX_SAFE_INTEGER })
          .catch(() => undefined)
        return
      }

      setThread(emptyThread)
      try {
        await loadHistory(id)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      }
    },
    [projects, models, selectedModelChoice, loadHistory, transport],
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
  const answerUserInput = useCallback(
    (requestId: string, answers: Record<string, string[]>) => {
      const threadId = activeIdRef.current
      if (!threadId) return
      void transport.request('thread.respondToUserInput', { threadId, requestId, answers })
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

  const restoreCheckpoint = useCallback(async () => {
    if (!activeId || !rollbackInspection) return
    setRollbackRestoring(true)
    try {
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
      threadStates.current.delete(id)
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
    },
    [transport],
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
      setSidebarSettings((current) => ({ ...current, ...updates }))
      void transport
        .request('sidebar.updateSettings', updates)
        .then(setSidebarSettings)
        .catch((error) => setNotice(error instanceof Error ? error.message : String(error)))
    },
    [transport],
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!provider) return
      if (event.defaultPrevented || event.repeat) return

      if (matchesShortcut(event, SHORTCUTS.searchSessions)) {
        event.preventDefault()
        setSettingsOpen(false)
        setPaletteScope(null)
        setSessionSearchProject(undefined)
        setSessionSearchOpen(true)
        return
      }
      // The Settings sheet owns the keyboard. Without this, Ctrl+N started a
      // chat underneath it. Its own shortcut still closes it; everything else waits.
      if (settingsOpen) {
        if (matchesShortcut(event, SHORTCUTS.settings)) {
          event.preventDefault()
          setSettingsOpen((open) => !open)
        }
        return
      }
      if (isEditableTarget(event.target)) return

      if (matchesShortcut(event, SHORTCUTS.commandPalette)) {
        event.preventDefault()
        setSettingsOpen(false)
        setPaletteScope('all')
        return
      }
      if (matchesShortcut(event, SHORTCUTS.switchProject)) {
        event.preventDefault()
        setSettingsOpen(false)
        setPaletteScope('projects')
        return
      }
      if (matchesShortcut(event, SHORTCUTS.newChat)) {
        event.preventDefault()
        startNewChat()
        return
      }
      if (matchesShortcut(event, SHORTCUTS.newProject)) {
        event.preventDefault()
        void addProject()
        return
      }
      if (matchesShortcut(event, SHORTCUTS.settings)) {
        event.preventDefault()
        setPaletteScope(null)
        setSettingsOpen((open) => !open)
        return
      }
      if (matchesShortcut(event, SHORTCUTS.focusComposer) && activePath) {
        event.preventDefault()
        setPaletteScope(null)
        setComposerFocusRequest((request) => request + 1)
        return
      }
      if (matchesShortcut(event, SHORTCUTS.toggleSidebar)) {
        event.preventDefault()
        setCollapsed((current) => !current)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activePath, addProject, provider, startNewChat, settingsOpen])

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
  const addSidebarProject = useCallback(() => void addProject(), [addProject])
  const startSidebarSession = useCallback(
    (path?: string, chooseProject?: boolean) => {
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
  const openSidebarSearch = useCallback((projectPath?: string) => {
    setSessionSearchProject(projectPath)
    setSessionSearchOpen(true)
  }, [])
  const closeSessionSearch = useCallback(() => setSessionSearchOpen(false), [])
  const selectSessionSearchResult = useCallback(
    (threadId: string, turnId: string) => {
      setSessionSearchOpen(false)
      setSearchJump((current) => ({
        threadId,
        turnId,
        request: (current?.request ?? 0) + 1,
      }))
      void selectSession(threadId)
    },
    [selectSession],
  )
  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const resetSettings = useCallback(() => {
    localStorage.clear()
    location.reload()
  }, [])
  const changeModelVisibility = useCallback((key: string, visible: boolean) => {
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
  const toggleTerminal = useCallback(() => setTerminalOpen((open) => !open), [])
  const closeTerminal = useCallback(() => setTerminalOpen(false), [])

  const active = useMemo(() => findSession(projects, activeId), [projects, activeId])
  const activeProject = useMemo(
    () => projects.find((project) => project.path === activePath),
    [projects, activePath],
  )
  const searching = thread.items.some(
    (item) =>
      item.turnId === thread.activeTurn?.id &&
      item.type === 'tool_call' &&
      item.status === 'started' &&
      `${item.text ?? ''} ${item.command ?? ''}`.toLowerCase().includes('search'),
  )
  const commands = useMemo<PaletteCommand[]>(() => {
    if (!paletteScope) return EMPTY_PALETTE_COMMANDS
    const labels = {
      newChat: shortcutLabel(SHORTCUTS.newChat, macOS),
      switchProject: shortcutLabel(SHORTCUTS.switchProject, macOS),
      newProject: shortcutLabel(SHORTCUTS.newProject, macOS),
      settings: shortcutLabel(SHORTCUTS.settings, macOS),
      searchSessions: shortcutLabel(SHORTCUTS.searchSessions, macOS),
      focusComposer: shortcutLabel(SHORTCUTS.focusComposer, macOS),
      toggleSidebar: shortcutLabel(SHORTCUTS.toggleSidebar, macOS),
    }
    return [
      {
        id: 'search-sessions',
        title: 'Search all chats',
        detail: 'Messages and tool output across projects',
        group: 'Actions',
        shortcut: labels.searchSessions,
        run: () => {
          setSessionSearchProject(undefined)
          setSessionSearchOpen(true)
        },
      },
      {
        id: 'new-chat',
        title: 'New chat',
        detail: activePath ? `Start in ${basename(activePath)}` : 'Choose a project folder',
        group: 'Actions',
        keywords: 'session conversation',
        shortcut: labels.newChat,
        run: startNewChat,
      },
      {
        id: 'switch-project',
        title: 'Switch project…',
        detail: 'Choose another workspace',
        group: 'Actions',
        keywords: 'folder workspace',
        shortcut: labels.switchProject,
        run: () => setPaletteScope('projects'),
      },
      {
        id: 'new-project',
        title: 'New project',
        detail: 'Add a folder to the sidebar',
        group: 'Actions',
        keywords: 'add open folder workspace',
        shortcut: labels.newProject,
        projectCommand: true,
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
              shortcut: labels.focusComposer,
              run: () => setComposerFocusRequest((request) => request + 1),
            },
          ]
        : []),
      {
        id: 'toggle-sidebar',
        title: collapsed ? 'Show sidebar' : 'Hide sidebar',
        group: 'Actions',
        keywords: 'rail navigation',
        shortcut: labels.toggleSidebar,
        run: () => setCollapsed((current) => !current),
      },
      {
        id: 'open-settings',
        title: 'Settings',
        detail: 'Providers, appearance, storage',
        group: 'Actions',
        shortcut: labels.settings,
        run: () => setSettingsOpen(true),
      },
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
    macOS,
    activePath,
    startNewChat,
    addProject,
    collapsed,
    projects,
    selectProject,
    beginSession,
    selectSession,
  ])

  if (!provider) {
    return (
      <Onboarding
        transport={transport}
        models={models}
        hiddenModels={hiddenModels}
        onModelVisibilityChange={changeModelVisibility}
        onRefreshModels={refreshCatalog}
        onDone={(id, agent) => {
          writeSetting(SETUP_KEY, id)
          if (agent) {
            writeSetting(AGENT_KEY, agent.id)
            writeSetting(AGENT_NAME_KEY, agent.name)
          }
          setAcpAgent(agent?.id)
          setAcpAgentName(agent?.name)
          setProvider(id)
        }}
      />
    )
  }

  return (
    <div
      className={`shell ${collapsed ? 'is-narrow' : ''}`}
      style={{ '--rail-w': `${railWidth}px` } as CSSProperties}
    >
      <TitleBar collapsed={collapsed} onToggleRail={toggleRail} />
      {isDesktop ? <ZoomHud /> : null}

      <div className="shell__body">
        <Sidebar
          projects={projects}
          activeProjectPath={activePath}
          activeSessionId={activeId}
          providerName={providerName(provider, acpAgentName)}
          usageSummary={usageSummary}
          mode={sidebarSettings.mode}
          inbox={sidebarInbox}
          collapsed={collapsed}
          width={railWidth}
          account={account}
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
          onReorderSession={reorderSidebarSession}
          onOpenSearch={openSidebarSearch}
          onOpenSettings={openSettings}
        />

        <main className="stage">
          <StageHeader
            projects={projects}
            activePath={activePath}
            title={active?.session.title}
            checkpointCount={thread.running ? 0 : checkpoints.length}
            worktreeBranch={active?.session.worktreeBranch}
            terminalOpen={terminalOpen}
            onSelectProject={selectProject}
            onOpenRollback={openRollback}
            onToggleTerminal={toggleTerminal}
          />

          <div
            className={`stage__body${activeId ? '' : ' is-new-session'}${active && terminalOpen ? ' has-terminal' : ''}`}
          >
            {activeId ? (
              <Thread
                items={thread.items}
                running={thread.running}
                searching={searching}
                activeTurn={thread.activeTurn}
                plan={thread.plan}
                diff={thread.diff}
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
              />
            ) : (
              <Empty projects={projects} activePath={activePath} loaded={projectsLoaded} />
            )}

            {active && terminalOpen ? (
              <Suspense fallback={null}>
                <TerminalPane
                  key={activeId}
                  transport={transport}
                  threadId={active.session.id}
                  height={terminalHeight}
                  theme={theme}
                  onHeightChange={setTerminalHeight}
                  onClose={closeTerminal}
                />
              </Suspense>
            ) : null}

            <Composer
              projects={projects}
              projectPath={activePath}
              projectName={activeProject ? displayName(activeProject) : undefined}
              branch={active?.session.worktreeBranch ?? workspace?.branch ?? branches[0]}
              branches={branches}
              models={visibleModels}
              modelsLoaded={modelsLoaded}
              modelId={modelId}
              effort={effort}
              serviceTier={serviceTier}
              usage={thread.usage}
              approval={approval === 'auto-review' && !autoReviewSupported ? 'ask' : approval}
              autoReviewSupported={autoReviewSupported}
              voiceAvailable={isDesktop && provider === 'codex' && voiceAvailable}
              disabled={false}
              running={thread.running}
              newSession={!activeId}
              isolate={active?.session.worktreeBranch ? true : isolateSession}
              designMode={designMode}
              focusRequest={composerFocusRequest}
              draftRequest={composerDraft}
              queuedTurns={queuedTurns}
              canSteerQueue={canSteerQueue}
              onModelChange={selectModel}
              onEffortChange={setEffort}
              onServiceTierChange={setServiceTier}
              onApprovalChange={setApproval}
              onIsolateChange={setIsolateSession}
              onDesignModeChange={setDesignMode}
              onTranscribeVoice={transcribeVoice}
              onCancelVoice={cancelVoice}
              onProjectChange={selectProject}
              onBranchChange={changeBranch}
              onProjectRequired={requireProject}
              onSend={sendTurn}
              onSteer={steerTurn}
              onInterrupt={interrupt}
              stopping={stopping}
              onDeleteQueuedTurn={deleteQueuedTurn}
              onMoveQueuedTurn={moveQueuedTurn}
              onSteerQueuedTurn={steerQueuedTurn}
            />
          </div>
        </main>
      </div>

      {settingsOpen ? (
        <Settings
          provider={provider}
          providerName={providerName(provider, acpAgentName)}
          transport={transport}
          projectPath={activePath}
          projectName={activeProject ? displayName(activeProject) : undefined}
          account={account}
          providerStatuses={providerStatuses}
          acpAgents={acpAgents}
          modelConnections={modelConnections}
          models={models}
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
          onAccountChange={handleAccountChange}
          onReset={resetSettings}
          onClose={closeSettings}
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

      {sessionSearchOpen ? (
        <SessionSearch
          transport={transport}
          projects={projects}
          initialProjectPath={sessionSearchProject}
          onSelect={selectSessionSearchResult}
          onClose={closeSessionSearch}
        />
      ) : null}

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
      {offline ? (
        <div className="notice notice--offline" role="status">
          <LoaderCircle className="spinner" size={12} aria-hidden />
          <span className="notice__text">Reconnecting to the server…</span>
        </div>
      ) : null}

      {notice ? (
        <div
          className={`notice${undoRestore || notice === 'Restore undone.' ? ' notice--success' : ''}`}
          role="alert"
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
        </div>
      ) : null}
    </div>
  )
}

function readRailWidth(): number {
  const stored = Number(readSetting(RAIL_WIDTH_KEY))
  return Number.isFinite(stored) && stored >= 176 && stored <= 420 ? stored : 248
}

function Empty(props: { projects: Project[]; activePath: string | undefined; loaded: boolean }) {
  const activeProject = props.projects.find((project) => project.path === props.activePath)

  // Before the first projects.list reply, "no projects" is not a fact yet —
  // flashing the add-a-project prompt for one round trip reads as a glitch.
  if (!props.loaded) return <div className="empty" />

  if (props.projects.length === 0) {
    return (
      <div className="empty">
        <div className="empty__prompt" role="heading" aria-level={1}>
          Add a project to start building.
        </div>
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

function providerName(id: ProviderId, acpAgentName?: string): string {
  // ACP is how we talk to the agent, not who the agent is. Showing "ACP" would
  // name our plumbing instead of the thing the user chose.
  if (id === 'acp') return acpAgentName ?? 'ACP agent'
  switch (id) {
    case 'codex':
      return 'Codex'
    case 'claude-code':
      return 'Claude Code'
    case 'cursor':
      return 'Cursor'
    case 'opencode':
      return 'OpenCode'
    case 'antigravity':
      return 'Antigravity'
    default:
      return id
  }
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

function endsDesignBriefing(event: DomainEvent): boolean {
  if (event.type !== 'item.completed' || event.item.role !== 'assistant') return false
  const text = event.item.text ?? ''
  return (
    text.trim() ===
      'Design mode was turned off because this request is not a website design task.' ||
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

function loadSessionOrder(): SessionOrder {
  try {
    const parsed = JSON.parse(readSetting(SESSION_ORDER_KEY) ?? '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string[]] =>
          Array.isArray(entry[1]) && entry[1].every((id) => typeof id === 'string'),
      ),
    )
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
