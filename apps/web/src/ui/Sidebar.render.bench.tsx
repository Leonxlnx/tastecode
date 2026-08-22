// @vitest-environment happy-dom
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterAll, bench, describe } from 'vitest'
import { updateSession } from '../project-store.js'
import { Sidebar, type Project, type Session } from './Sidebar.js'

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

const initialProjects: Project[] = Array.from({ length: 500 }, (_, projectIndex) => ({
  path: `/project-${projectIndex}`,
  sessions: Array.from({ length: 20 }, (_, sessionIndex) => session(projectIndex, sessionIndex)),
}))
const initialPinnedProjects: Project[] = initialProjects.map((project) => ({
  ...project,
  sessions: project.sessions.map((entry) => ({ ...entry, pinned: true })),
}))
function createSidebarHarness(
  initial: Project[],
  activeProjectPath?: string,
  activeSessionId?: string,
) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = (projects: Project[]) => {
    flushSync(() => {
      root.render(
        <Sidebar
          projects={projects}
          activeProjectPath={activeProjectPath}
          activeSessionId={activeSessionId}
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
    })
  }
  render(initial)
  return {
    render,
    dispose: () => {
      flushSync(() => root.unmount())
      container.remove()
    },
  }
}

function toggleStatus(entry: Session): Session {
  return { ...entry, status: entry.status === 'working' ? 'idle' : 'working' }
}

let hiddenProjects = initialProjects
let visibleProjects = initialProjects
let activeProjects = initialProjects
let pinnedProjects = initialPinnedProjects
const hiddenHarness = createSidebarHarness(hiddenProjects)
const visibleHarness = createSidebarHarness(visibleProjects)
const pinnedHarness = createSidebarHarness(pinnedProjects)
const activeHarness = createSidebarHarness(activeProjects, '/project-49', 'thread-49-19')

afterAll(() => {
  hiddenHarness.dispose()
  visibleHarness.dispose()
  pinnedHarness.dispose()
  activeHarness.dispose()
})

describe('many-thread live sidebar reconciliation', () => {
  bench(
    'reconciles one hidden status change outside the 50-project window',
    () => {
      hiddenProjects = updateSession(hiddenProjects, 'thread-499-19', toggleStatus)
      hiddenHarness.render(hiddenProjects)
    },
    UPDATE_OPTIONS,
  )

  bench(
    'reconciles one visible status change inside the 50-project window',
    () => {
      visibleProjects = updateSession(visibleProjects, 'thread-49-19', toggleStatus)
      visibleHarness.render(visibleProjects)
    },
    UPDATE_OPTIONS,
  )

  bench(
    'reconciles one pinned status change across 10,000 sessions',
    () => {
      pinnedProjects = updateSession(pinnedProjects, 'thread-499-19', toggleStatus)
      pinnedHarness.render(pinnedProjects)
    },
    UPDATE_OPTIONS,
  )

  bench(
    'reconciles one status change in the expanded active project',
    () => {
      activeProjects = updateSession(activeProjects, 'thread-49-19', toggleStatus)
      activeHarness.render(activeProjects)
    },
    UPDATE_OPTIONS,
  )
})
