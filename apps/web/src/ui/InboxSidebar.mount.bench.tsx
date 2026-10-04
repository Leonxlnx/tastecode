// @vitest-environment happy-dom
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { bench, describe } from 'vitest'
import { InboxSidebar, type InboxActions } from './InboxSidebar.js'
import type { Project, Session } from './Sidebar.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
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

function projects(projectCount: number, sessionsPerProject: number): Project[] {
  return Array.from({ length: projectCount }, (_, projectIndex) => ({
    path: `/project-${projectIndex}`,
    name: `Project ${projectIndex}`,
    sessions: Array.from({ length: sessionsPerProject }, (_, sessionIndex) =>
      session(projectIndex, sessionIndex),
    ),
  }))
}

function mountInbox(input: Project[]): void {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  flushSync(() =>
    root.render(
      <InboxSidebar
        projects={input}
        scope=""
        activeProjectPath={undefined}
        activeSessionId={undefined}
        actions={actions}
        onScopeChange={noop}
        onAddProject={noop}
        onNewSession={noop}
        onSelectSession={noop}
        onRenameSession={noop}
        onArchiveSession={noop}
      />,
    ),
  )
  flushSync(() => root.unmount())
  container.remove()
}

const shortInbox = projects(1, 1)
const oneLargeProjectInbox = projects(1, 10_000)
const manyThreadInbox = projects(100, 100)

describe('Inbox initial mount', () => {
  bench('mounts a one-thread Inbox', () => mountInbox(shortInbox), OPTIONS)
  bench(
    'mounts the first viewport from one 10,000-thread project',
    () => mountInbox(oneLargeProjectInbox),
    OPTIONS,
  )
  bench('mounts the first viewport from 10,000 threads', () => mountInbox(manyThreadInbox), OPTIONS)
})
