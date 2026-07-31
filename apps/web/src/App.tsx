import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  Account,
  ApprovalMode,
  DomainEvent,
  Model,
  ProviderId,
  ResultOf,
} from '@harness/contracts'
import { Folder } from 'lucide-react'
import { isMacOS, pickFolder } from './bridge.js'
import { isEditableTarget, matchesShortcut, SHORTCUTS, shortcutLabel } from './shortcuts.js'
import { warmHighlighter } from './ui/highlighter.js'
import { Transport } from './transport.js'
import { appendUserMessage, emptyThread, reduce, type ThreadState } from './thread-store.js'
import { CommandPalette, type CommandScope, type PaletteCommand } from './ui/CommandPalette.js'
import { CheckoutDiscardDialog } from './ui/CheckoutDiscardDialog.js'
import { Composer, type WorkspaceInfo } from './ui/Composer.js'
import { Onboarding } from './ui/Onboarding.js'
import { RollbackDialog, type Checkpoint } from './ui/RollbackDialog.js'
import { Settings } from './ui/Settings.js'
import { Sidebar, type Project } from './ui/Sidebar.js'
import { StageHeader } from './ui/StageHeader.js'
import { Thread } from './ui/Thread.js'
import { TitleBar } from './ui/TitleBar.js'
import { Menu, MenuItem } from './ui/Menu.js'
import { serverUrl } from './server-url.js'
import { canCaptureVoice, type VoiceRecording } from './voice-recorder.js'

const SERVER_URL = serverUrl(import.meta.env.VITE_HARNESS_SERVER_URL ?? 'ws://127.0.0.1:4311')
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
  const transport = useMemo(() => new Transport(SERVER_URL), [])
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
  const [models, setModels] = useState<Model[]>([])
  const [modelsLoaded, setModelsLoaded] = useState(false)
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
    return stored === 'auto' || stored === 'full' ? stored : 'ask'
  })
  const [collapsed, setCollapsed] = useState(
    () => globalThis.matchMedia?.('(max-width: 700px)').matches ?? false,
  )
  const [workspace, setWorkspace] = useState<WorkspaceInfo | undefined>()
  const [account, setAccount] = useState<Account | undefined>()
  const [voiceAvailable, setVoiceAvailable] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteScope, setPaletteScope] = useState<CommandScope | null>(null)
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
  const [macOSFontSmoothing, setMacOSFontSmoothing] = useState(
    () => localStorage.getItem(MACOS_FONT_SMOOTHING_KEY) !== 'false',
  )

  // Syntax grammars load in the background from the first frame, so the first
  // code block an agent produces is already coloured.
  useEffect(warmHighlighter, [])

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

  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  useEffect(() => {
    const off = transport.on('thread.event', ({ threadId, event }) => {
      const next = reduce(threadStates.current.get(threadId) ?? emptyThread, event)
      threadStates.current.set(threadId, next)

      if (threadId === activeIdRef.current) setThread(next)

      if (affectsSessionStatus(event)) {
        setProjects((current) => {
          const updated = markStatus(current, threadId, statusFor(next, event))
          return event.type === 'turn.started' ? promoteSession(updated, threadId) : updated
        })
      }
    })
    transport.connect()
    return () => {
      off()
      transport.close()
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
    if (!provider || !canCaptureVoice()) {
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

  // Branch and uncommitted size for the context chip. Re-read after every turn,
  // because the agent is exactly what changes it.
  useEffect(() => {
    if (!activePath) {
      setWorkspace(undefined)
      return
    }
    let cancelled = false
    void transport
      .request('workspace.info', { path: activePath })
      .then((info) => {
        if (!cancelled) setWorkspace(info)
      })
      .catch(() => setWorkspace(undefined))
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
            status: session.running ? ('running' as const) : ('idle' as const),
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
      if (activeIdRef.current === threadId) setThread(restored)
    },
    [transport],
  )

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
        const { threadId } = await transport.request('thread.start', {
          provider,
          workspacePath: projectPath,
          approval,
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

      const next = appendUserMessage(threadStates.current.get(threadId) ?? emptyThread, text)
      threadStates.current.set(threadId, next)
      if (threadId === activeIdRef.current) setThread(next)

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
        await transport.request('thread.sendTurn', {
          threadId,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(modelId ? { model: modelId } : {}),
          ...(effort ? { effort } : {}),
          ...(serviceTier ? { serviceTier } : {}),
        })
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      }
    },
    [transport, activeId, activePath, createSession, projects, modelId, effort, serviceTier],
  )

  const interrupt = useCallback(() => {
    if (activeId) void transport.request('thread.interrupt', { threadId: activeId })
  }, [transport, activeId])

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
        return
      }

      setThread(emptyThread)
      try {
        await loadHistory(id)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      }
    },
    [projects, loadHistory],
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!provider) return
      if (event.defaultPrevented || event.repeat || isEditableTarget(event.target)) return

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
    )
  }

  const active = findSession(projects, activeId)
  const labels = {
    newChat: shortcutLabel(SHORTCUTS.newChat, macOS),
    switchProject: shortcutLabel(SHORTCUTS.switchProject, macOS),
    newProject: shortcutLabel(SHORTCUTS.newProject, macOS),
    settings: shortcutLabel(SHORTCUTS.settings, macOS),
    focusComposer: shortcutLabel(SHORTCUTS.focusComposer, macOS),
    toggleSidebar: shortcutLabel(SHORTCUTS.toggleSidebar, macOS),
  }
  const commands: PaletteCommand[] = [
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
          collapsed={collapsed}
          account={account}
          onClose={() => setCollapsed(true)}
          onAddProject={() => void addProject()}
          onNewSession={beginSession}
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
            onSelectProject={selectProject}
            onOpenRollback={() => {
              setRollbackInspection(undefined)
              setRollbackOpen(true)
            }}
          />

          {active ? (
            <Thread
              items={thread.items}
              running={thread.running}
              activeTurn={thread.activeTurn}
              plan={thread.plan}
              diff={thread.diff}
              approvals={thread.approvals}
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
            <Empty projects={projects} activePath={activePath} onSelectProject={selectProject} />
          )}

          <Composer
            projectName={activePath ? basename(activePath) : undefined}
            workspace={active?.session.worktreeBranch ? undefined : workspace}
            models={models}
            modelsLoaded={modelsLoaded}
            modelId={modelId}
            effort={effort}
            serviceTier={serviceTier}
            approval={approval}
            voiceAvailable={provider === 'codex' && voiceAvailable}
            disabled={!activePath}
            running={thread.running}
            newSession={!activeId}
            isolate={isolateSession}
            focusRequest={composerFocusRequest}
            onModelChange={selectModel}
            onEffortChange={setEffort}
            onServiceTierChange={setServiceTier}
            onApprovalChange={setApproval}
            onIsolateChange={setIsolateSession}
            onTranscribeVoice={transcribeVoice}
            onCancelVoice={cancelVoice}
            onSend={(t, files) => void send(t, files)}
            onInterrupt={interrupt}
          />
        </main>
      </div>

      {settingsOpen ? (
        <Settings
          provider={provider}
          providerName={providerName(provider, acpAgentName)}
          account={account}
          projectCount={projects.length}
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
    </div>
  )
}

function Empty(props: {
  projects: Project[]
  activePath: string | undefined
  onSelectProject: (path: string) => void
}) {
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
        What should we build in{' '}
        <Menu
          label="Choose project"
          drop="up"
          triggerClassName="empty__project-trigger"
          panelClassName="empty__project-menu"
          trigger={() => <span>{activeProject ? displayName(activeProject) : 'a project'}</span>}
        >
          {(close) => (
            <>
              {props.projects.map((project) => (
                <MenuItem
                  key={project.path}
                  icon={Folder}
                  title={displayName(project)}
                  detail={project.path}
                  active={project.path === props.activePath}
                  onClick={() => {
                    props.onSelectProject(project.path)
                    close()
                  }}
                />
              ))}
            </>
          )}
        </Menu>
        ?
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

function markStatus(
  projects: Project[],
  threadId: string,
  status: Project['sessions'][number]['status'],
): Project[] {
  return projects.map((project) => ({
    ...project,
    sessions: project.sessions.map((session) =>
      session.id === threadId ? { ...session, status } : session,
    ),
  }))
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

function statusFor(state: ThreadState, event: DomainEvent): Project['sessions'][number]['status'] {
  if (event.type === 'thread.error') return 'failed'
  if (event.type === 'turn.completed') return event.status === 'failed' ? 'failed' : 'idle'
  if (state.approvals.length > 0) return 'attention'
  return state.running ? 'running' : 'idle'
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
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
