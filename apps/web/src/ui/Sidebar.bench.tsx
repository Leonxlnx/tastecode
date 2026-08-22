// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { bench, describe } from 'vitest'
import { updateSession } from '../project-store.js'
import {
  arrangeClassicSidebarProjects,
  arrangeClassicSidebarWindow,
  createClassicSidebarProjector,
  Sidebar,
  type Project,
  type Session,
} from './Sidebar.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 3, warmupTime: 0 }
const UPDATE_OPTIONS = { time: 1_200, warmupTime: 300 }
const noop = () => undefined

function session(projectIndex: number, sessionIndex: number): Session {
  return {
    id: `thread-${projectIndex}-${sessionIndex}`,
    title: `Chat ${projectIndex}-${sessionIndex}`,
    provider: 'codex',
    createdAt: sessionIndex,
    status: 'idle',
    lifecycle: { state: 'active', keepActive: false },
    unread: false,
  }
}

const projects: Project[] = Array.from({ length: 500 }, (_, projectIndex) => ({
  path: `/project-${projectIndex}`,
  sessions: Array.from({ length: 20 }, (_, sessionIndex) => session(projectIndex, sessionIndex)),
}))
const pinnedProjects = projects.map((project) => ({
  ...project,
  sessions: project.sessions.map((entry) => ({ ...entry, pinned: true })),
}))

function legacyArrangeClassicSidebarProjects(source: Project[]): number {
  const pinnedProjects: Project[] = []
  const regularProjects: Project[] = []
  const pinnedSessions: Array<{ projectPath: string; session: Session }> = []
  for (const project of source) {
    const active: Session[] = []
    const unread: Session[] = []
    const rest: Session[] = []
    for (const entry of project.sessions) {
      if (entry.pinned) pinnedSessions.push({ projectPath: project.path, session: entry })
      else if (['starting', 'working', 'queued', 'approval', 'input'].includes(entry.status)) {
        active.push(entry)
      } else if (entry.unread) unread.push(entry)
      else rest.push(entry)
    }
    const ordered = { ...project, sessions: [...active, ...unread, ...rest] }
    if (project.pinned) pinnedProjects.push(ordered)
    else regularProjects.push(ordered)
  }
  return pinnedSessions.length + pinnedProjects.length + regularProjects.length
}

function renderSidebar(projects: Project[]): void {
  renderToStaticMarkup(
    <Sidebar
      projects={projects}
      activeProjectPath={undefined}
      activeSessionId={undefined}
      account={undefined}
      providerName="Codex"
      collapsed={false}
      width={248}
      onWidthChange={noop}
      onClose={noop}
      onAddProject={noop}
      onNewSession={noop}
      onSelectSession={noop}
      onRenameProject={noop}
      onRemoveProject={noop}
      onTogglePin={noop}
      onRenameSession={noop}
      onDeleteSession={noop}
      onArchiveProject={noop}
      onReorderSession={noop}
      onOpenSearch={noop}
      onOpenSettings={noop}
    />,
  )
}

describe('many-project classic sidebar', () => {
  bench(
    'renders the bounded view of 500 collapsed projects with 10,000 sessions',
    () => {
      renderSidebar(projects)
    },
    OPTIONS,
  )

  bench(
    'renders the bounded view of 10,000 pinned sessions',
    () => {
      renderSidebar(pinnedProjects)
    },
    OPTIONS,
  )
})

describe('bounded pinned sidebar projection', () => {
  bench(
    'merges all 10,000 pinned rows before slicing the first page',
    () => {
      const visible = arrangeClassicSidebarProjects(pinnedProjects).pinnedSessions.slice(0, 25)
      if (visible.length !== 25) throw new Error('invalid full pinned projection')
    },
    UPDATE_OPTIONS,
  )

  bench(
    'collects only the first visible page and the exact count',
    () => {
      const visible = arrangeClassicSidebarWindow(pinnedProjects, 25)
      if (visible.pinnedSessions.length !== 25 || visible.pinnedSessionCount !== 10_000) {
        throw new Error('invalid bounded pinned projection')
      }
    },
    UPDATE_OPTIONS,
  )
})

describe('many-thread classic sidebar updates', () => {
  const target = 'thread-499-19'
  const toggle = (entry: Session): Session => ({
    ...entry,
    status: entry.status === 'working' ? 'idle' : 'working',
  })
  let legacyProjects = projects
  let indexedProjects = projects
  arrangeClassicSidebarProjects(indexedProjects)

  bench(
    'reclassifies all 10,000 sessions after one status update',
    () => {
      legacyProjects = updateSession(legacyProjects, target, toggle)
      if (legacyArrangeClassicSidebarProjects(legacyProjects) !== 500) {
        throw new Error('invalid legacy sidebar arrangement')
      }
    },
    UPDATE_OPTIONS,
  )

  bench(
    'reclassifies only the changed project after one status update',
    () => {
      indexedProjects = updateSession(indexedProjects, target, toggle)
      const arranged = arrangeClassicSidebarProjects(indexedProjects)
      if (arranged.orderedProjects.length + arranged.pinnedSessions.length !== 500) {
        throw new Error('invalid indexed sidebar arrangement')
      }
    },
    UPDATE_OPTIONS,
  )
})

describe('large-project classic sidebar updates', () => {
  const target = 'thread-0-9999'
  const toggle = (entry: Session): Session => ({
    ...entry,
    status: entry.status === 'working' ? 'idle' : 'working',
  })
  const makeLargeProject = (): Project[] => [
    {
      path: '/large-project',
      sessions: Array.from({ length: 10_000 }, (_, index) => session(0, index)),
    },
  ]
  let scannedProjects = makeLargeProject()
  let projectedProjects = makeLargeProject()
  const projector = createClassicSidebarProjector()
  arrangeClassicSidebarProjects(scannedProjects)
  projector.project(projectedProjects)

  bench(
    'reclassifies a 10,000-session project after one status update',
    () => {
      scannedProjects = updateSession(scannedProjects, target, toggle)
      const arranged = arrangeClassicSidebarProjects(scannedProjects)
      if (arranged.orderedProjects[0]?.sessions.length !== 10_000) {
        throw new Error('invalid large-project arrangement')
      }
    },
    UPDATE_OPTIONS,
  )

  bench(
    'moves one changed session through a retained projection',
    () => {
      projectedProjects = updateSession(projectedProjects, target, toggle)
      const arranged = projector.project(projectedProjects)
      if (arranged.orderedProjects[0]?.sessions.length !== 10_000) {
        throw new Error('invalid retained large-project arrangement')
      }
    },
    UPDATE_OPTIONS,
  )
})
