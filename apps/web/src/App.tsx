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
import type {
  Account,
  ApprovalMode,
  DomainEvent,
  Model,
  ProviderId,
  QueuedTurn,
  ResultOf,
  SidebarSettings,
} from '@harness/contracts'
import { isMacOS, pickFolder } from './bridge.js'
import { isEditableTarget, matchesShortcut, SHORTCUTS, shortcutLabel } from './shortcuts.js'
import { warmHighlighter } from './ui/highlighter.js'
import { Transport } from './transport.js'
import {
  appendUserMessage,
  emptyThread,
  reduce,
  removeQueuedOptimisticMessage,
  type ThreadState,
} from './thread-store.js'
import { CommandPalette, type CommandScope, type PaletteCommand } from './ui/CommandPalette.js'
import { CheckoutDiscardDialog } from './ui/CheckoutDiscardDialog.js'
import { Composer, type WorkspaceInfo } from './ui/Composer.js'
import { Onboarding } from './ui/Onboarding.js'
import { PanicStop } from './ui/PanicStop.js'
import { RollbackDialog, type Checkpoint } from './ui/RollbackDialog.js'
import { SessionSearch } from './ui/SessionSearch.js'
import { Settings } from './ui/Settings.js'
import { Sidebar, type Project } from './ui/Sidebar.js'
import { StageHeader } from './ui/StageHeader.js'
import { Thread } from './ui/Thread.js'
import { TitleBar } from './ui/TitleBar.js'
import { serverUrl } from './server-url.js'
import {
  applyTheme,
  DARK_THEME_QUERY,
  readSystemTheme,
  readThemePreference,
  THEME_KEY,
  type Theme,
  type ThemePreference,
} from './theme.js'

const SERVER_BASE_URL = import.meta.env.VITE_HARNESS_SERVER_URL ?? 'ws://127.0.0.1:4311'
const SETUP_KEY = 'harness.provider'
/** Which ACP agent was chosen. Meaningless unless the provider is `acp`. */
const AGENT_KEY = 'harness.acpAgent'
const AGENT_NAME_KEY = 'harness.acpAgentName'
const PROJECTS_KEY = 'harness.projects'
const SESSION_ORDER_KEY = 'harness.sessionOrder'
const MODEL_KEY = 'harness.model'
const EFFORT_KEY = 'harness.effort'
const SERVICE_TIER_KEY = 'harness.serviceTier'
const APPROVAL_KEY = 'harness.approval'
const MACOS_FONT_SMOOTHING_KEY = 'harness.macosFontSmoothing'
const TERMINAL_OPEN_KEY = 'harness.terminal.open'
const TERMINAL_HEIGHT_KEY = 'harness.terminal.height'
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
    const raw = localStorage.getItem(PROJECTS_KEY)
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
  const [provider, setProvider] = useState<ProviderId | null>(
    () => localStorage.getItem(SETUP_KEY) as ProviderId | null,
  )
  const [acpAgent, setAcpAgent] = useState<string | undefined>(
    () => localStorage.getItem(AGENT_KEY) ?? undefined,
  )
  // Kept so the sidebar can say "Gemini CLI" rather than "acp". The name lives
  // in the adapter package, which the renderer deliberately cannot import.
  const [acpAgentName, setAcpAgentName] = useState<string | undefined>(
    () => localStorage.getItem(AGENT_NAME_KEY) ?? undefined,
  )
  // A cache of what the server says, not a source of truth. Every change goes
  // to the server and comes back through here.
  const [projects, setProjects] = useState<Project[]>([])
  const [activeId, setActiveId] = useState<string | undefined>()
  const [activePath, setActivePath] = useState<string | undefined>()
  const [thread, setThread] = useState<ThreadState>(emptyThread)
  const [usageSummary, setUsageSummary] = useState<ResultOf<'usage.summary'> | undefined>()
  // Every live session keeps reducing events while it is off screen. A ref is
  // intentional: streamed deltas for a background session should not rerender
  // the active thread, while selecting it still gets the latest state at once.
  const threadStates = useRef(new Map<string, ThreadState>())
  const queueStates = useRef(new Map<string, { items: QueuedTurn[]; canSteer: boolean }>())
  const [queuedTurns, setQueuedTurns] = useState<QueuedTurn[]>([])
  const [canSteerQueue, setCanSteerQueue] = useState(false)
  const [models, setModels] = useState<Model[]>([])
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [autoReviewSupported, setAutoReviewSupported] = useState(false)
  const [modelId, setModelId] = useState<string | undefined>(
    () => localStorage.getItem(MODEL_KEY) ?? undefined,
  )
  const [effort, setEffort] = useState<string | undefined>(
    () => localStorage.getItem(EFFORT_KEY) ?? undefined,
  )
  const [serviceTier, setServiceTier] = useState<string | undefined>(
    () => localStorage.getItem(SERVICE_TIER_KEY) ?? undefined,
  )
  const [approval, setApproval] = useState<ApprovalMode>(() => {
    const stored = localStorage.getItem(APPROVAL_KEY)
    return stored === 'auto' || stored === 'auto-review' || stored === 'full' ? stored : 'ask'
  })
  const [collapsed, setCollapsed] = useState(
    () => globalThis.matchMedia?.('(max-width: 700px)').matches ?? false,
  )
  const [workspace, setWorkspace] = useState<WorkspaceInfo | undefined>()
  const [branches, setBranches] = useState<string[]>([])
  const [account, setAccount] = useState<Account | undefined>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarSettings, setSidebarSettings] = useState(DEFAULT_SIDEBAR_SETTINGS)
  const [paletteScope, setPaletteScope] = useState<CommandScope | null>(null)
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false)
  const [sessionSearchProject, setSessionSearchProject] = useState<string>()
  const [searchJump, setSearchJump] = useState<{
    threadId: string
    turnId: string
    request: number
  }>()
  const [composerFocusRequest, setComposerFocusRequest] = useState(0)
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
  const [checkoutDelete, setCheckoutDelete] = useState<
    { id: string; title: string; branch: string } | undefined
  >()
  const [checkoutDeleteBusy, setCheckoutDeleteBusy] = useState(false)
  const macOS = isMacOS()
  const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference)
  const [systemTheme, setSystemTheme] = useState<Theme>(readSystemTheme)
  const theme = themePreference === 'system' ? systemTheme : themePreference
  const [macOSFontSmoothing, setMacOSFontSmoothing] = useState(
    () => localStorage.getItem(MACOS_FONT_SMOOTHING_KEY) !== 'false',
  )
  const [terminalOpen, setTerminalOpen] = useState(
    () => localStorage.getItem(TERMINAL_OPEN_KEY) === 'true',
  )
  const [terminalHeight, setTerminalHeight] = useState(readTerminalHeight)

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
  }, [theme])

  useEffect(() => {
    localStorage.setItem(THEME_KEY, themePreference)
  }, [themePreference])

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
    if (macOS) localStorage.setItem(MACOS_FONT_SMOOTHING_KEY, String(macOSFontSmoothing))
  }, [macOS, macOSFontSmoothing])

  useEffect(() => {
    localStorage.setItem(TERMINAL_OPEN_KEY, String(terminalOpen))
  }, [terminalOpen])

  useEffect(() => {
    localStorage.setItem(TERMINAL_HEIGHT_KEY, String(terminalHeight))
  }, [terminalHeight])

  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const sidebarSettingsRef = useRef(sidebarSettings)
  sidebarSettingsRef.current = sidebarSettings

  useEffect(() => {
    const offEvents = transport.on('thread.event', ({ threadId, event }) => {
      const next = reduce(threadStates.current.get(threadId) ?? emptyThread, event)
      threadStates.current.set(threadId, next)

      if (threadId === activeIdRef.current) setThread(next)

      if (affectsSessionStatus(event)) {
        setProjects((current) => {
          const updated = updateSession(current, threadId, (session) => ({
            ...session,
            status: statusFor(next, event, threadId !== activeIdRef.current),
            ...(event.type === 'turn.completed'
              ? { unread: threadId !== activeIdRef.current }
              : {}),
          }))
          return event.type === 'turn.started' && sidebarSettingsRef.current.mode === 'classic'
            ? promoteSession(updated, threadId)
            : updated
        })
        if (event.type === 'turn.completed' && threadId === activeIdRef.current) {
          void transport.request('thread.history', { threadId }).catch(() => undefined)
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
    transport.connect()
    return () => {
      offEvents()
      offQueue()
      offLifecycle()
      offSidebarSettings()
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

  // Ask the provider what it can run, rather than shipping a list that goes
  // stale the week after release.
  useEffect(() => {
    if (!provider) return
    let cancelled = false
    void transport
      .request('models.list', { provider })
      .then(({ models: list }) => {
        if (cancelled) return
        setModels(list)
        setModelsLoaded(true)
        const storedModel = localStorage.getItem(MODEL_KEY)
        const chosen =
          list.find((model) => model.id === storedModel) ?? list.find((m) => m.isDefault)
        const selected = chosen ?? list[0]
        if (!selected) return
        setModelId(selected.id)
        setEffort((current) =>
          current && selected.reasoningEfforts.includes(current)
            ? current
            : (selected.defaultReasoningEffort ?? selected.reasoningEfforts[0]),
        )
        setServiceTier((current) =>
          current && selected.serviceTiers.some((tier) => tier.id === current)
            ? current
            : (selected.defaultServiceTier ?? undefined),
        )
      })
      .catch(() => {
        // A provider that cannot list models is a normal case, not an error.
        if (!cancelled) setModelsLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [transport, provider])

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
    const savedOrder = loadSessionOrder()
    setProjects(
      list.map((project) => ({
        path: project.path,
        name: project.name,
        pinned: project.pinned,
        sessions: applySessionOrder(
          project.path,
          project.sessions.map((session) => ({
            id: session.id,
            title: session.title,
            provider: session.provider,
            ...(session.agent ? { agent: session.agent } : {}),
            createdAt: session.createdAt,
            status: session.status ?? (session.running ? 'working' : 'idle'),
            lifecycle: session.lifecycle ?? { state: 'active', keepActive: false },
            unread: session.unread ?? false,
            ...(session.worktreeBranch ? { worktreeBranch: session.worktreeBranch } : {}),
          })),
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
      const { events } = await transport.request('thread.history', { threadId })
      const restored = events.reduce((state, entry) => reduce(state, entry.event), emptyThread)
      threadStates.current.set(threadId, restored)
      setProjects((current) => updateSession(current, threadId, markSessionRead))
      if (activeIdRef.current === threadId) setThread(restored)
    },
    [transport],
  )

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

  useEffect(() => {
    if (!activeId) {
      setUsageSummary(undefined)
      return
    }
    let cancelled = false
    void transport
      .request('usage.summary', { threadId: activeId })
      .then((summary) => {
        if (!cancelled) setUsageSummary(summary)
      })
      .catch(() => {
        if (!cancelled) setUsageSummary(undefined)
      })
    return () => {
      cancelled = true
    }
  }, [transport, activeId, thread.running])

  // First load, plus the one-time handover from localStorage. Anything found
  // there is given to the server and the key removed, so it happens once.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const legacy = takeLegacyProjects()
      for (const project of legacy) {
        await transport.request('projects.add', project).catch(() => undefined)
      }
      if (legacy.length > 0) localStorage.removeItem(PROJECTS_KEY)
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
    if (modelId) localStorage.setItem(MODEL_KEY, modelId)
  }, [modelId])

  useEffect(() => {
    if (effort) {
      localStorage.setItem(EFFORT_KEY, effort)
    } else {
      localStorage.removeItem(EFFORT_KEY)
    }
  }, [effort])

  useEffect(() => {
    if (serviceTier) {
      localStorage.setItem(SERVICE_TIER_KEY, serviceTier)
    } else {
      localStorage.removeItem(SERVICE_TIER_KEY)
    }
  }, [serviceTier])

  useEffect(() => {
    localStorage.setItem(APPROVAL_KEY, approval)
  }, [approval])

  const selectModel = useCallback(
    (id: string) => {
      const selected = models.find((model) => model.id === id)
      if (!selected) return
      setModelId(id)
      setEffort((current) =>
        current && selected.reasoningEfforts.includes(current)
          ? current
          : (selected.defaultReasoningEffort ?? selected.reasoningEfforts[0]),
      )
      setServiceTier((current) =>
        current && selected.serviceTiers.some((tier) => tier.id === current)
          ? current
          : (selected.defaultServiceTier ?? undefined),
      )
    },
    [models],
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
    async (projectPath: string): Promise<string | undefined> => {
      if (!provider) return undefined
      setNotice(undefined)
      setUndoRestore(undefined)
      setRollbackOpen(false)
      setActivePath(projectPath)
      try {
        const sessionApproval =
          approval === 'auto-review' && !autoReviewSupported ? 'ask' : approval
        const { threadId } = await transport.request('thread.start', {
          provider,
          workspacePath: projectPath,
          approval: sessionApproval,
          ...(provider === 'acp' && acpAgent ? { agent: acpAgent } : {}),
          ...(modelId ? { model: modelId } : {}),
          ...(serviceTier ? { serviceTier } : {}),
          ...(effort ? { effort } : {}),
          ...(isolateSession ? { isolate: true } : {}),
        })
        threadStates.current.set(threadId, emptyThread)
        activeIdRef.current = threadId
        setActiveId(threadId)
        setThread(emptyThread)
        // The server recorded the session when it started it; this is asking
        // what it now knows rather than guessing alongside it.
        await refreshProjects()
        return threadId
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
        return undefined
      }
    },
    [
      transport,
      provider,
      acpAgent,
      modelId,
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

  const send = useCallback(
    async (text: string, attachments: string[] = []) => {
      // Typing first and having the session appear is the natural order. Making
      // the user press "new session" before they are allowed to type is the
      // app's bookkeeping leaking into their way of working.
      let threadId = activeId
      let justCreated = false
      if (!threadId) {
        if (!activePath) return
        threadId = await createSession(activePath)
        if (!threadId) return
        justCreated = true
      }

      setNotice(undefined)
      setUndoRestore(undefined)

      const before = threadStates.current.get(threadId) ?? emptyThread
      const wasRunning = before.running
      const beforeItemIds = new Set(before.items.map((item) => item.id))
      if (!wasRunning) {
        const next = appendUserMessage(before, text)
        threadStates.current.set(threadId, next)
        if (threadId === activeIdRef.current) setThread(next)
      }

      // A session named after what was asked of it is findable a week later;
      // "New session" is not. Named from the first message only.
      //
      // A session created a moment ago is untitled by definition — `projects`
      // here is still the value from this render and cannot know about it yet,
      // so asking it would answer no every time and nothing would be named.
      const untitled =
        justCreated || findSession(projects, threadId)?.session.title === 'New session'
      if (untitled) {
        const title = titleFrom(text)
        setProjects((current) => promoteSession(renameSession(current, threadId, title), threadId))
        void transport.request('thread.rename', { threadId, title }).catch(() => undefined)
      }
      try {
        const result = await transport.request('thread.sendTurn', {
          threadId,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(modelId ? { model: modelId } : {}),
          ...(effort ? { effort } : {}),
          ...(serviceTier ? { serviceTier } : {}),
        })
        const current = threadStates.current.get(threadId) ?? emptyThread
        if (result.queued && !wasRunning) {
          const reconciled = removeQueuedOptimisticMessage(current, text)
          threadStates.current.set(threadId, reconciled)
          if (threadId === activeIdRef.current) setThread(reconciled)
        } else if (!result.queued && wasRunning) {
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
        setNotice(error instanceof Error ? error.message : String(error))
      }
    },
    [transport, activeId, activePath, createSession, projects, modelId, effort, serviceTier],
  )

  const interrupt = useCallback(() => {
    if (activeId) void transport.request('thread.interrupt', { threadId: activeId })
  }, [transport, activeId])

  const deleteQueuedTurn = useCallback(
    (queuedTurnId: string) => {
      if (!activeId) return
      void transport
        .request('thread.deleteQueuedTurn', { threadId: activeId, queuedTurnId })
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

  const selectSession = useCallback(
    async (id: string) => {
      setNotice(undefined)
      setUndoRestore(undefined)
      setRollbackOpen(false)
      activeIdRef.current = id
      setActiveId(id)
      setActivePath(findSession(projects, id)?.project.path)
      const cached = threadStates.current.get(id)
      if (cached) {
        setThread(cached)
        setProjects((current) => updateSession(current, id, markSessionRead))
        void transport.request('thread.history', { threadId: id }).catch(() => undefined)
        return
      }

      setThread(emptyThread)
      try {
        await loadHistory(id)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      }
    },
    [projects, loadHistory, transport],
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
      if (!found) return
      try {
        const work = await transport.request('thread.unsavedWork', { threadId: id })
        if (work.isolated && work.uncommitted) {
          setCheckoutDelete({
            id,
            title: found.session.title,
            branch: found.session.worktreeBranch ?? 'isolated checkout',
          })
          return
        }
        if (work.isolated) {
          await transport.request('thread.close', { threadId: id })
          await transport.request('thread.discardWorktree', { threadId: id })
        }
        await deleteSession(id)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
        await refreshProjects().catch(() => undefined)
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
    const path = activePath ?? projects[0]?.path
    if (path) beginSession(path)
    else void addProject()
  }, [activePath, projects, beginSession, addProject])

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

  const hideSession = useCallback(
    async (id: string, action: 'settle' | 'snooze', wakeAt?: number) => {
      try {
        const pending =
          action === 'settle'
            ? transport.request('thread.settle', { threadId: id })
            : wakeAt === undefined
              ? undefined
              : transport.request('thread.snooze', { threadId: id, wakeAt })
        if (!pending) return
        const result = await pending
        setProjects((current) =>
          updateSession(current, id, (session) => ({
            ...session,
            lifecycle: result.lifecycle,
          })),
        )
        if (activeIdRef.current !== id) return
        const current = findSession(projects, id)
        const next = projects
          .flatMap((project) => project.sessions)
          .filter((session) => session.id !== id && session.lifecycle.state === 'active')
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

  const restoreSession = useCallback(
    async (id: string, action: 'unsettle' | 'unsnooze') => {
      try {
        const result =
          action === 'unsettle'
            ? await transport.request('thread.unsettle', { threadId: id })
            : await transport.request('thread.unsnooze', { threadId: id })
        setProjects((current) =>
          updateSession(current, id, (session) => ({
            ...session,
            lifecycle: result.lifecycle,
          })),
        )
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
        await refreshProjects().catch(() => undefined)
      }
    },
    [transport, refreshProjects],
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
  }, [activePath, addProject, provider, startNewChat])

  if (!provider) {
    return (
      <>
        <Onboarding
          transport={transport}
          onDone={(id, agent) => {
            localStorage.setItem(SETUP_KEY, id)
            if (agent) {
              localStorage.setItem(AGENT_KEY, agent.id)
              localStorage.setItem(AGENT_NAME_KEY, agent.name)
            }
            setAcpAgent(agent?.id)
            setAcpAgentName(agent?.name)
            setProvider(id)
          }}
        />
        <PanicStop transport={transport} />
      </>
    )
  }

  const active = findSession(projects, activeId)
  const activeProject = projects.find((project) => project.path === activePath)
  const labels = {
    newChat: shortcutLabel(SHORTCUTS.newChat, macOS),
    switchProject: shortcutLabel(SHORTCUTS.switchProject, macOS),
    newProject: shortcutLabel(SHORTCUTS.newProject, macOS),
    settings: shortcutLabel(SHORTCUTS.settings, macOS),
    searchSessions: shortcutLabel(SHORTCUTS.searchSessions, macOS),
    focusComposer: shortcutLabel(SHORTCUTS.focusComposer, macOS),
    toggleSidebar: shortcutLabel(SHORTCUTS.toggleSidebar, macOS),
  }
  const commands: PaletteCommand[] = [
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
      title: `New chat in ${displayName(project)}`,
      detail: project.path,
      group: 'Projects',
      keywords: 'session conversation',
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

  return (
    <div className={`shell ${collapsed ? 'is-narrow' : ''}`}>
      <TitleBar collapsed={collapsed} onToggleRail={() => setCollapsed((c) => !c)} />

      <div className="shell__body">
        <Sidebar
          projects={projects}
          activeProjectPath={activePath}
          activeSessionId={activeId}
          providerName={providerName(provider, acpAgentName)}
          mode={sidebarSettings.mode}
          inbox={{
            onSettle: (id) => void hideSession(id, 'settle'),
            onUnsettle: (id) => void restoreSession(id, 'unsettle'),
            onSnooze: (id, wakeAt) => void hideSession(id, 'snooze', wakeAt),
            onUnsnooze: (id) => void restoreSession(id, 'unsnooze'),
            onKeepActive: (id, keepActive) => void keepSessionActive(id, keepActive),
          }}
          collapsed={collapsed}
          account={account}
          onClose={() => setCollapsed(true)}
          onAddProject={() => void addProject()}
          onNewSession={(path) => {
            if (path) beginSession(path)
            else if (projects.length === 1 && projects[0]) beginSession(projects[0].path)
            else setPaletteScope('projects')
          }}
          onSelectSession={(id) => void selectSession(id)}
          onRenameProject={(path, name) => {
            setProjects((c) => c.map((p) => (p.path === path ? { ...p, name } : p)))
            void transport.request('projects.rename', { path, name }).catch(() => undefined)
          }}
          onRemoveProject={(path) => {
            setProjects((c) => c.filter((p) => p.path !== path))
            if (activePath === path) setActivePath(undefined)
            void transport
              .request('projects.remove', { path })
              .then(refreshProjects)
              .catch((error) => {
                setNotice(error instanceof Error ? error.message : String(error))
                void refreshProjects().catch(() => undefined)
              })
          }}
          onTogglePin={(path) => {
            const pinned = !projects.find((p) => p.path === path)?.pinned
            setProjects((c) => c.map((p) => (p.path === path ? { ...p, pinned } : p)))
            void transport.request('projects.pin', { path, pinned }).catch(() => undefined)
          }}
          onRenameSession={(id, title) => {
            setProjects((c) => renameSession(c, id, title))
            void transport.request('thread.rename', { threadId: id, title }).catch(() => undefined)
          }}
          onDeleteSession={(id) => void archiveSession(id)}
          onReorderSession={(projectPath, sourceId, targetId, position) =>
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
          }
          onOpenSearch={(projectPath) => {
            setSessionSearchProject(projectPath)
            setSessionSearchOpen(true)
          }}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <main className="stage">
          <StageHeader
            projects={projects}
            activePath={activePath}
            title={active?.session.title}
            usage={thread.usage}
            usageSummary={usageSummary}
            checkpointCount={thread.running ? 0 : checkpoints.length}
            worktreeBranch={active?.session.worktreeBranch}
            terminalOpen={terminalOpen}
            onSelectProject={selectProject}
            onOpenRollback={() => {
              setRollbackInspection(undefined)
              setRollbackOpen(true)
            }}
            onToggleTerminal={() => setTerminalOpen((open) => !open)}
          />

          <div
            className={`stage__body${activeId ? '' : ' is-new-session'}${activeId && terminalOpen ? ' has-terminal' : ''}`}
          >
            {active ? (
              <Thread
                key={activeId}
                items={thread.items}
                running={thread.running}
                activeTurn={thread.activeTurn}
                plan={thread.plan}
                diff={thread.diff}
                threadId={activeId}
                transport={transport}
                searchJump={searchJump?.threadId === activeId ? searchJump : undefined}
                approvals={thread.approvals}
                reviews={Object.values(thread.reviews)}
                onDecide={(approvalId, decision) => {
                  if (!activeId) return
                  void transport.request('thread.respondToApproval', {
                    threadId: activeId,
                    approvalId,
                    decision,
                  })
                }}
              />
            ) : (
              <Empty projects={projects} activePath={activePath} />
            )}

            {activeId && terminalOpen ? (
              <Suspense fallback={null}>
                <TerminalPane
                  key={activeId}
                  transport={transport}
                  threadId={activeId}
                  height={terminalHeight}
                  theme={theme}
                  onHeightChange={setTerminalHeight}
                  onClose={() => setTerminalOpen(false)}
                />
              </Suspense>
            ) : null}

            <Composer
              projects={projects}
              projectPath={activePath}
              projectName={activeProject ? displayName(activeProject) : undefined}
              branch={active?.session.worktreeBranch ?? workspace?.branch ?? branches[0]}
              branches={branches}
              models={models}
              modelsLoaded={modelsLoaded}
              modelId={modelId}
              effort={effort}
              serviceTier={serviceTier}
              approval={approval === 'auto-review' && !autoReviewSupported ? 'ask' : approval}
              autoReviewSupported={autoReviewSupported}
              disabled={!activePath}
              running={thread.running}
              newSession={!activeId}
              isolate={active?.session.worktreeBranch ? true : isolateSession}
              focusRequest={composerFocusRequest}
              queuedTurns={queuedTurns}
              canSteerQueue={canSteerQueue}
              onModelChange={selectModel}
              onEffortChange={setEffort}
              onServiceTierChange={setServiceTier}
              onApprovalChange={setApproval}
              onIsolateChange={setIsolateSession}
              onProjectChange={selectProject}
              onBranchChange={(branch) => void selectBranch(branch)}
              onSend={(t, files) => void send(t, files)}
              onInterrupt={interrupt}
              onDeleteQueuedTurn={deleteQueuedTurn}
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
          projectCount={projects.length}
          sidebarSettings={sidebarSettings}
          onSidebarSettingsChange={updateSidebarSettings}
          themePreference={themePreference}
          onThemePreferenceChange={setThemePreference}
          showMacOSFontSmoothing={macOS}
          macOSFontSmoothing={macOSFontSmoothing}
          onMacOSFontSmoothingChange={setMacOSFontSmoothing}
          onSignOut={() => {
            void transport.request('auth.signOut', { provider }).then(() => {
              setAccount({ signedIn: false })
            })
          }}
          onReset={() => {
            localStorage.clear()
            location.reload()
          }}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {paletteScope ? (
        <CommandPalette
          commands={commands}
          scope={paletteScope}
          onClose={() => setPaletteScope(null)}
        />
      ) : null}

      {sessionSearchOpen ? (
        <SessionSearch
          transport={transport}
          projects={projects}
          initialProjectPath={sessionSearchProject}
          onSelect={(threadId, turnId) => {
            setSessionSearchOpen(false)
            setSearchJump((current) => ({
              threadId,
              turnId,
              request: (current?.request ?? 0) + 1,
            }))
            void selectSession(threadId)
          }}
          onClose={() => setSessionSearchOpen(false)}
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
      <PanicStop transport={transport} />
    </div>
  )
}

function Empty(props: { projects: Project[]; activePath: string | undefined }) {
  const activeProject = props.projects.find((project) => project.path === props.activePath)

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
  const stored = Number(localStorage.getItem(TERMINAL_HEIGHT_KEY))
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
    const parsed = JSON.parse(localStorage.getItem(SESSION_ORDER_KEY) ?? '{}') as unknown
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

function saveSessionOrder(projects: Project[]): void {
  localStorage.setItem(
    SESSION_ORDER_KEY,
    JSON.stringify(
      Object.fromEntries(
        projects.map((project) => [project.path, project.sessions.map((session) => session.id)]),
      ),
    ),
  )
}
