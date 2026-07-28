import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderId } from '@harness/contracts'
import { Transport, type ConnectionState } from './transport.js'
import { appendUserMessage, emptyThread, reduce, type ThreadState } from './thread-store.js'
import { Composer } from './ui/Composer.js'
import { Onboarding } from './ui/Onboarding.js'
import { Sidebar, type Project } from './ui/Sidebar.js'
import { Thread } from './ui/Thread.js'
import { TitleBar } from './ui/TitleBar.js'

const SERVER_URL = 'ws://127.0.0.1:4311'
const SETUP_KEY = 'harness.provider'
const PROJECTS_KEY = 'harness.projects'

/**
 * Projects and sessions live in localStorage for now. The server takes
 * ownership of both when the event log lands in M2 — this is scaffolding that
 * lets the shell be designed against real state instead of mocks.
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
  const [connection, setConnection] = useState<ConnectionState>('closed')
  const [provider, setProvider] = useState<ProviderId | null>(
    () => localStorage.getItem(SETUP_KEY) as ProviderId | null,
  )
  const [projects, setProjects] = useState<Project[]>(loadProjects)
  const [activeId, setActiveId] = useState<string | undefined>()
  const [thread, setThread] = useState<ThreadState>(emptyThread)
  const [notice, setNotice] = useState<string | undefined>()

  useEffect(() => {
    const offState = transport.onState(setConnection)
    const offEvent = transport.on('thread.event', ({ threadId, event }) => {
      setThread((current) => (threadId === activeIdRef.current ? reduce(current, event) : current))
      if (event.type === 'turn.started' || event.type === 'turn.completed') {
        setProjects((current) => markStatus(current, threadId, event.type === 'turn.started'))
      }
    })
    transport.connect()
    return () => {
      offState()
      offEvent()
      transport.close()
    }
  }, [transport])

  // Read inside the socket listener without re-subscribing on every selection.
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  useEffect(() => {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects))
  }, [projects])

  const pickProvider = (id: ProviderId) => {
    localStorage.setItem(SETUP_KEY, id)
    setProvider(id)
  }

  const addProject = useCallback(() => {
    const path = window.prompt('Folder to work in')?.trim()
    if (!path) return
    setProjects((current) =>
      current.some((p) => p.path === path) ? current : [...current, { path, sessions: [] }],
    )
  }, [])

  const newSession = useCallback(
    async (projectPath: string) => {
      setNotice(undefined)
      try {
        const { threadId } = await transport.request('thread.start', {
          provider: 'codex',
          workspacePath: projectPath,
        })
        setProjects((current) =>
          current.map((project) =>
            project.path === projectPath
              ? {
                  ...project,
                  sessions: [
                    ...project.sessions,
                    { id: threadId, title: 'Untitled session', status: 'idle' as const },
                  ],
                }
              : project,
          ),
        )
        setActiveId(threadId)
        setThread(emptyThread)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      }
    },
    [transport],
  )

  const send = useCallback(
    async (text: string) => {
      if (!activeId) return
      setThread((current) => appendUserMessage(current, text))
      // The first thing a user says is the best title we will get for free.
      setProjects((current) => titleIfUntitled(current, activeId, text))
      try {
        await transport.request('thread.sendTurn', { threadId: activeId, text })
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      }
    },
    [transport, activeId],
  )

  const interrupt = useCallback(() => {
    if (activeId) void transport.request('thread.interrupt', { threadId: activeId })
  }, [transport, activeId])

  if (!provider) return <Onboarding onPick={pickProvider} />

  const active = findSession(projects, activeId)

  return (
    <div className="shell">
      <TitleBar subtitle={active?.project ? basename(active.project.path) : undefined} />

      <div className="shell__body">
        <Sidebar
          projects={projects}
          activeSessionId={activeId}
          connection={connection}
          onAddProject={addProject}
          onNewSession={(path) => void newSession(path)}
          onSelectSession={(id) => {
            setActiveId(id)
            setThread(emptyThread)
          }}
        />

        <main className="stage">
          {active ? (
            <>
              <Thread items={thread.items} running={thread.running} />
              <Composer
                onSend={(t) => void send(t)}
                onInterrupt={interrupt}
                running={thread.running}
              />
            </>
          ) : (
            <Placeholder hasProjects={projects.length > 0} onAddProject={addProject} />
          )}
        </main>
      </div>

      {notice ? (
        <div className="notice" role="alert">
          <span className="notice__text">{notice}</span>
          <button className="linkish" onClick={() => setNotice(undefined)}>
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  )
}

function Placeholder(props: { hasProjects: boolean; onAddProject: () => void }) {
  return (
    <div className="placeholder">
      <p className="label">No session open</p>
      <p className="placeholder__text">
        {props.hasProjects
          ? 'Pick a session on the left, or start a new one.'
          : 'Add a project folder to start your first session.'}
      </p>
      {props.hasProjects ? null : (
        <button className="btn" onClick={props.onAddProject}>
          Add project
        </button>
      )}
    </div>
  )
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

function titleIfUntitled(projects: Project[], threadId: string, text: string): Project[] {
  return projects.map((project) => ({
    ...project,
    sessions: project.sessions.map((session) =>
      session.id === threadId && session.title === 'Untitled session'
        ? { ...session, title: text.length > 42 ? `${text.slice(0, 42)}…` : text }
        : session,
    ),
  }))
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
