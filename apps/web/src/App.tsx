import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Account, ApprovalMode, Model, ProviderId } from '@harness/contracts'
import { pickFolder } from './bridge.js'
import { warmHighlighter } from './ui/highlighter.js'
import { Transport } from './transport.js'
import { appendUserMessage, emptyThread, reduce, type ThreadState } from './thread-store.js'
import { Composer, type WorkspaceInfo } from './ui/Composer.js'
import { Onboarding } from './ui/Onboarding.js'
import { Settings } from './ui/Settings.js'
import { Sidebar, type Project } from './ui/Sidebar.js'
import { StageHeader } from './ui/StageHeader.js'
import { Thread } from './ui/Thread.js'
import { TitleBar } from './ui/TitleBar.js'

const SERVER_URL = 'ws://127.0.0.1:4311'
const SETUP_KEY = 'harness.provider'
/** Which ACP agent was chosen. Meaningless unless the provider is `acp`. */
const AGENT_KEY = 'harness.acpAgent'
const AGENT_NAME_KEY = 'harness.acpAgentName'
const PROJECTS_KEY = 'harness.projects'
const MODEL_KEY = 'harness.model'

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
  const [models, setModels] = useState<Model[]>([])
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [modelId, setModelId] = useState<string | undefined>(
    () => localStorage.getItem(MODEL_KEY) ?? undefined,
  )
  const [effort, setEffort] = useState<string | undefined>()
  // Never restored from storage. Full access is genuinely dangerous, and a
  // permission level that quietly survives a restart is how people get burned.
  const [approval, setApproval] = useState<ApprovalMode>('ask')
  const [collapsed, setCollapsed] = useState(false)
  const [workspace, setWorkspace] = useState<WorkspaceInfo | undefined>()
  const [account, setAccount] = useState<Account | undefined>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [notice, setNotice] = useState<string | undefined>()

  // Syntax grammars load in the background from the first frame, so the first
  // code block an agent produces is already coloured.
  useEffect(warmHighlighter, [])

  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  useEffect(() => {
    const off = transport.on('thread.event', ({ threadId, event }) => {
      setThread((current) => (threadId === activeIdRef.current ? reduce(current, event) : current))
      if (event.type === 'turn.started' || event.type === 'turn.completed') {
        setProjects((current) => markStatus(current, threadId, event.type === 'turn.started'))
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
        const chosen = list.find((m) => m.isDefault) ?? list[0]
        setModelId((current) => current ?? chosen?.id)
        setEffort((current) => current ?? chosen?.defaultReasoningEffort)
      })
      .catch(() => {
        // A provider that cannot list models is a normal case, not an error.
        if (!cancelled) setModelsLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [transport, provider])

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
    setProjects(
      list.map((project) => ({
        path: project.path,
        name: project.name,
        pinned: project.pinned,
        sessions: project.sessions.map((session) => ({
          id: session.id,
          title: session.title,
          status: session.running ? ('running' as const) : ('idle' as const),
        })),
      })),
    )
    setActivePath((current) => current ?? list[0]?.path)
  }, [transport])

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
    if (modelId) localStorage.setItem(MODEL_KEY, modelId)
  }, [modelId])

  const addProject = useCallback(async () => {
    const path = await pickFolder()
    if (!path) return
    await transport.request('projects.add', { path })
    await refreshProjects()
    setActivePath(path)
  }, [transport, refreshProjects])

  const createSession = useCallback(
    async (projectPath: string): Promise<string | undefined> => {
      if (!provider) return undefined
      setNotice(undefined)
      setActivePath(projectPath)
      try {
        const { threadId } = await transport.request('thread.start', {
          provider,
          workspacePath: projectPath,
          approval,
          ...(provider === 'acp' && acpAgent ? { agent: acpAgent } : {}),
          ...(modelId ? { model: modelId } : {}),
          ...(effort ? { effort } : {}),
        })
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
    [transport, provider, acpAgent, modelId, effort, approval, refreshProjects],
  )

  const beginSession = useCallback(
    (projectPath: string) => {
      // A session nobody typed into is bookkeeping, not history. Pressing "new
      // session" twice should not leave a trail of empty ones.
      const untouched = projects
        .find((project) => project.path === projectPath)
        ?.sessions.filter((session) => session.title === 'New session')
      void (async () => {
        for (const session of untouched ?? []) {
          await transport.request('thread.delete', { threadId: session.id }).catch(() => undefined)
        }
        await refreshProjects().catch(() => undefined)
      })()
      setNotice(undefined)
      setActivePath(projectPath)
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

      setThread((current) => appendUserMessage(current, text))

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
        setProjects((current) => renameSession(current, threadId, title))
        void transport.request('thread.rename', { threadId, title }).catch(() => undefined)
      }

      try {
        await transport.request('thread.sendTurn', {
          threadId,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
        })
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      }
    },
    [transport, activeId, activePath, createSession, projects],
  )

  /**
   * Open a session and show what already happened in it.
   *
   * Switching used to leave an empty pane, because the conversation only ever
   * existed in the events this client had personally seen. It is replayed from
   * the server's log now, so a session survives a reload and a restart.
   */
  const openSession = useCallback(
    async (id: string) => {
      setActiveId(id)
      setActivePath(findSession(projects, id)?.project.path)
      setThread(emptyThread)
      try {
        const { events } = await transport.request('thread.history', { threadId: id })
        setThread(events.reduce((state, entry) => reduce(state, entry.event), emptyThread))
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      }
    },
    [transport, projects],
  )

  const interrupt = useCallback(() => {
    if (activeId) void transport.request('thread.interrupt', { threadId: activeId })
  }, [transport, activeId])

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

  return (
    <div className={`shell ${collapsed ? 'is-narrow' : ''}`}>
      <TitleBar collapsed={collapsed} onToggleRail={() => setCollapsed((c) => !c)} />

      <div className="shell__body">
        <Sidebar
          projects={projects}
          activeSessionId={activeId}
          providerName={providerName(provider, acpAgentName)}
          collapsed={collapsed}
          account={account}
          onAddProject={() => void addProject()}
          onNewSession={beginSession}
          onSelectSession={(id) => void openSession(id)}
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
              .catch(() => undefined)
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
          onDeleteSession={(id) => {
            setProjects((c) =>
              c.map((p) => ({ ...p, sessions: p.sessions.filter((s) => s.id !== id) })),
            )
            if (activeId === id) {
              setActiveId(undefined)
              setThread(emptyThread)
            }
            void transport.request('thread.delete', { threadId: id }).catch(() => undefined)
          }}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <main className="stage">
          <StageHeader
            projects={projects}
            activePath={activePath}
            title={active?.session.title}
            usage={thread.usage}
            onSelectProject={setActivePath}
          />

          {active ? (
            <Thread
              items={thread.items}
              running={thread.running}
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
            <Empty
              hasProjects={projects.length > 0}
              onAddProject={() => void addProject()}
              onStart={() => activePath && beginSession(activePath)}
            />
          )}

          <Composer
            projectName={activePath ? basename(activePath) : undefined}
            workspace={workspace}
            models={models}
            modelsLoaded={modelsLoaded}
            modelId={modelId}
            effort={effort}
            approval={approval}
            disabled={!activePath}
            running={thread.running}
            onModelChange={setModelId}
            onEffortChange={setEffort}
            onApprovalChange={setApproval}
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

      {notice ? (
        <div className="notice" role="alert">
          <span className="notice__text">{notice}</span>
          <button className="ghost" onClick={() => setNotice(undefined)}>
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  )
}

function Empty(props: { hasProjects: boolean; onAddProject: () => void; onStart: () => void }) {
  return (
    <div className="empty">
      <p className="empty__text">
        {props.hasProjects ? 'No chat open.' : 'Add a folder to get started.'}
      </p>
      <button className="btn" onClick={props.hasProjects ? props.onStart : props.onAddProject}>
        {props.hasProjects ? 'Start a chat' : 'New project'}
      </button>
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

function markStatus(projects: Project[], threadId: string, running: boolean): Project[] {
  return projects.map((project) => ({
    ...project,
    sessions: project.sessions.map((session) =>
      session.id === threadId ? { ...session, status: running ? 'running' : 'idle' } : session,
    ),
  }))
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
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
