// @vitest-environment happy-dom
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { ComponentProps, ComponentType } from 'react'
import { afterAll, bench, describe } from 'vitest'
import { updateSession } from '../project-store.js'
import { InboxSidebar, type InboxActions } from './InboxSidebar.js'
import type { Project, Session } from './Sidebar.js'

const UPDATE_OPTIONS = { time: 1_200, warmupTime: 300 }
const noop = () => undefined
const actions: InboxActions = {
  onSettle: noop,
  onUnsettle: noop,
  onSnooze: noop,
  onUnsnooze: noop,
  onKeepActive: noop,
}

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

type ForcedInboxSidebarProps = ComponentProps<typeof InboxSidebar> & { benchmarkNonce: number }
const ForcedInboxSidebar = InboxSidebar as ComponentType<ForcedInboxSidebarProps>

function createInboxHarness(initial: Project[], forceComponentBody = false) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let benchmarkNonce = 0
  const render = (projects: Project[]) => {
    flushSync(() => {
      const inboxProps = {
        projects,
        scope: '',
        activeProjectPath: undefined,
        activeSessionId: undefined,
        actions,
        onScopeChange: noop,
        onAddProject: noop,
        onNewSession: noop,
        onSelectSession: noop,
        onRenameSession: noop,
        onArchiveSession: noop,
      }
      root.render(
        forceComponentBody ? (
          <ForcedInboxSidebar {...inboxProps} benchmarkNonce={++benchmarkNonce} />
        ) : (
          <InboxSidebar {...inboxProps} />
        ),
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
  return {
    ...entry,
    status: entry.status === 'ready' ? 'idle' : 'ready',
    unread: entry.status !== 'ready',
  }
}

const unchangedHarness = createInboxHarness(initialProjects)
const forcedBodyHarness = createInboxHarness(initialProjects, true)
const hiddenHarness = createInboxHarness(initialProjects)
const visibleHarness = createInboxHarness(initialProjects)
let hiddenProjects = initialProjects
let visibleProjects = initialProjects

afterAll(() => {
  unchangedHarness.dispose()
  forcedBodyHarness.dispose()
  hiddenHarness.dispose()
  visibleHarness.dispose()
})

describe('many-thread inbox reconciliation', () => {
  bench(
    'runs the component body for unchanged 10,000-thread props',
    () => forcedBodyHarness.render(initialProjects),
    UPDATE_OPTIONS,
  )

  bench(
    'skips unchanged 10,000-thread props with stable actions',
    () => unchangedHarness.render(initialProjects),
    UPDATE_OPTIONS,
  )

  bench(
    'reconciles one hidden status change outside the active window',
    () => {
      hiddenProjects = updateSession(hiddenProjects, 'thread-0-0', toggleStatus)
      hiddenHarness.render(hiddenProjects)
    },
    UPDATE_OPTIONS,
  )

  bench(
    'reconciles one visible status change inside the active window',
    () => {
      visibleProjects = updateSession(visibleProjects, 'thread-99-99', toggleStatus)
      visibleHarness.render(visibleProjects)
    },
    UPDATE_OPTIONS,
  )
})
