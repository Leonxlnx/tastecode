// @vitest-environment happy-dom
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterAll, bench, describe } from 'vitest'
import { updateSession } from '../project-store.js'
import { Sidebar, type Project, type Session } from './Sidebar.js'

const UPDATE_OPTIONS = { time: 1_200, warmupTime: 300 }
const noop = () => undefined

function session(projectIndex: number, sessionIndex: number): Session {
  const index = projectIndex * 100 + sessionIndex
  return {
    id: `thread-${projectIndex}-${sessionIndex}`,
    title: `Chat ${projectIndex}-${sessionIndex}`,
    provider: 'codex',
    createdAt: index,
    status: 'idle',
    lifecycle: { state: 'active', keepActive: false },
    unread: false,
  }
}

const initialProjects: Project[] = Array.from({ length: 100 }, (_, projectIndex) => ({
  path: `/project-${projectIndex}`,
  name: `Project ${projectIndex}`,
  sessions: Array.from({ length: 100 }, (_, sessionIndex) => session(projectIndex, sessionIndex)),
}))

function createSidebarHarness(
  initial: Project[],
  churnNewSession = false,
  activeProjectPath?: string,
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
          activeSessionId={undefined}
          account={undefined}
          providerName="Codex"
          collapsed={false}
          width={248}
          onClose={noop}
          onWidthChange={noop}
          onAddProject={noop}
          onNewSession={churnNewSession ? () => undefined : noop}
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
  return { ...entry, status: entry.status === 'ready' ? 'idle' : 'ready' }
}

const unchangedHarness = createSidebarHarness(initialProjects)
const callbackChurnHarness = createSidebarHarness(initialProjects, true)
const hiddenHarness = createSidebarHarness(initialProjects)
const visibleHarness = createSidebarHarness(initialProjects, false, '/project-99')
let callbackChurnProjects = initialProjects
let hiddenProjects = initialProjects
let visibleProjects = initialProjects

afterAll(() => {
  unchangedHarness.dispose()
  callbackChurnHarness.dispose()
  hiddenHarness.dispose()
  visibleHarness.dispose()
})

describe('many-thread classic sidebar reconciliation', () => {
  bench(
    'rerenders unchanged 10,000-thread props',
    () => unchangedHarness.render(initialProjects),
    UPDATE_OPTIONS,
  )

  bench(
    'reconciles one hidden status change with a changing action callback',
    () => {
      callbackChurnProjects = updateSession(callbackChurnProjects, 'thread-99-99', toggleStatus)
      callbackChurnHarness.render(callbackChurnProjects)
    },
    UPDATE_OPTIONS,
  )

  bench(
    'reconciles one hidden status change outside the five-row project window',
    () => {
      hiddenProjects = updateSession(hiddenProjects, 'thread-99-99', toggleStatus)
      hiddenHarness.render(hiddenProjects)
    },
    UPDATE_OPTIONS,
  )

  bench(
    'reconciles one visible status change inside the five-row project window',
    () => {
      visibleProjects = updateSession(visibleProjects, 'thread-99-0', toggleStatus)
      visibleHarness.render(visibleProjects)
    },
    UPDATE_OPTIONS,
  )
})
