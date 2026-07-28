import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Account, ApprovalMode, Model, ProviderId } from '@harness/contracts'
import { pickFolder } from './bridge.js'
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
const PROJECTS_KEY = 'harness.projects'
const MODEL_KEY = 'harness.model'

/**
 * Projects and sessions live in localStorage for now. The server takes
 * ownership when the event log lands in M2 — this is scaffolding that lets the
 * shell be designed against real state instead of mocks.
 */
function loadProjects(): Project[] {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY)
    return raw ? (JSON.parse(raw) as Project[]) : []
  } catch {
    return []
  }
}

export function App() {
  const transport = useMemo(() => new Transport(SERVER_URL), [])
  const [provider, setProvider] = useState<ProviderId | null>(
    () => localStorage.getItem(SETUP_KEY) as ProviderId | null,
  )
  const [projects, setProjects] = useState<Project[]>(loadProjects)
  const [activeId, setActiveId] = useState<string | undefined>()
  const [activePath, setActivePath] = useState<string | undefined>(() => loadProjects()[0]?.path)
  const [thread, setThread] = useState<ThreadState>(emptyThread)
  const [models, setModels] = useState<Model[]>([])
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
        const chosen = list.find((m) => m.isDefault) ?? list[0]
        setModelId((current) => current ?? chosen?.id)
        setEffort((current) => current ?? chosen?.defaultReasoningEffort)
      })
      .catch(() => {
        /* The picker degrades to "Loading models…" — not worth a modal. */
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

  useEffect(() => {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects))
  }, [projects])

  useEffect(() => {
    if (modelId) localStorage.setItem(MODEL_KEY, modelId)
  }, [modelId])

  const addProject = useCallback(async () => {
    const path = await pickFolder()
    if (!path) return
    setProjects((current) =>
      current.some((p) => p.path === path) ? current : [...current, { path, sessions: [] }],
    )
    setActivePath(path)
  }, [])

  const newSession = useCallback(
    async (projectPath: string): Promise<string | undefined> => {
      setNotice(undefined)
      setActivePath(projectPath)
      try {
        const { threadId } = await transport.request('thread.start', {
          provider: 'codex',
          workspacePath: projectPath,
          approval,
          ...(modelId ? { model: modelId } : {}),
          ...(effort ? { effort } : {}),
        })
        setProjects((current) =>
          current.map((project) =>
            project.path === projectPath
              ? {
                  ...project,
                  sessions: [
                    ...project.sessions,
                    { id: threadId, title: 'New session', status: 'idle' as const },
                  ],
                }
              : project,
          ),
        )
        setActiveId(threadId)
        setThread(emptyThread)
        return threadId
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
        return undefined
      }
    },
    [transport, modelId, effort, approval],
  )

  const send = useCallback(
    async (text: string, attachments: string[] = []) => {
      // Typing first and having the session appear is the natural order. Making
      // the user press "new session" before they are allowed to type is the
      // app's bookkeeping leaking into their way of working.
      let threadId = activeId
      if (!threadId) {
        if (!activePath) return
        threadId = await newSession(activePath)
        if (!threadId) return
      }

      setThread((current) => appendUserMessage(current, text))
      setProjects((current) => titleIfNew(current, threadId, text))
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
    [transport, activeId, activePath, newSession],
  )

  const interrupt = useCallback(() => {
    if (activeId) void transport.request('thread.interrupt', { threadId: activeId })
  }, [transport, activeId])

  if (!provider) {
    return (
      <Onboarding
        transport={transport}
        onDone={(id) => {
          localStorage.setItem(SETUP_KEY, id)
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
          providerName={providerName(provider)}
          collapsed={collapsed}
          account={account}
          onAddProject={() => void addProject()}
          onNewSession={(path) => void newSession(path)}
          onSelectSession={(id) => {
            setActiveId(id)
            setActivePath(findSession(projects, id)?.project.path)
            setThread(emptyThread)
          }}
          onRenameProject={(path, name) =>
            setProjects((c) => c.map((p) => (p.path === path ? { ...p, name } : p)))
          }
          onRemoveProject={(path) => {
            setProjects((c) => c.filter((p) => p.path !== path))
            if (activePath === path) setActivePath(undefined)
          }}
          onTogglePin={(path) =>
            setProjects((c) => c.map((p) => (p.path === path ? { ...p, pinned: !p.pinned } : p)))
          }
          onRenameSession={(id, title) =>
            setProjects((c) =>
              c.map((p) => ({
                ...p,
                sessions: p.sessions.map((s) => (s.id === id ? { ...s, title } : s)),
              })),
            )
          }
          onDeleteSession={(id) => {
            void transport.request('thread.close', { threadId: id })
            setProjects((c) =>
              c.map((p) => ({ ...p, sessions: p.sessions.filter((s) => s.id !== id) })),
            )
            if (activeId === id) {
              setActiveId(undefined)
              setThread(emptyThread)
            }
          }}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <main className="stage">
          <StageHeader
            projects={projects}
            activePath={activePath}
            title={active?.session.title}
            onSelectProject={setActivePath}
          />

          {active ? (
            <Thread items={thread.items} running={thread.running} />
          ) : (
            <Empty
              hasProjects={projects.length > 0}
              onAddProject={() => void addProject()}
              onStart={() => activePath && void newSession(activePath)}
            />
          )}

          <Composer
            projectName={activePath ? basename(activePath) : undefined}
            workspace={workspace}
            models={models}
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
          providerName={providerName(provider)}
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
        {props.hasProjects ? 'No session open.' : 'Add a folder to get started.'}
      </p>
      <button className="btn" onClick={props.hasProjects ? props.onStart : props.onAddProject}>
        {props.hasProjects ? 'Start a session' : 'Add project'}
      </button>
    </div>
  )
}

function providerName(id: ProviderId): string {
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
function titleIfNew(projects: Project[], threadId: string, text: string): Project[] {
  return projects.map((project) => ({
    ...project,
    sessions: project.sessions.map((session) =>
      session.id === threadId && session.title === 'New session'
        ? { ...session, title: text.length > 40 ? `${text.slice(0, 40)}…` : text }
        : session,
    ),
  }))
}
