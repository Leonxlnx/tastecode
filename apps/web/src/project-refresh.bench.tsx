// @vitest-environment happy-dom
import { render } from '@testing-library/react'
import { afterAll, bench, describe } from 'vitest'
import { reconcileProjects } from './project-store.js'
import { Sidebar, type Project, type Session } from './ui/Sidebar.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const noop = () => undefined

const projects: Project[] = Array.from({ length: 100 }, (_, projectIndex) => ({
  path: `/project-${projectIndex}`,
  sessions: Array.from({ length: 100 }, (_, sessionIndex): Session => ({
    id: `thread-${projectIndex}-${sessionIndex}`,
    title: `Thread ${projectIndex}-${sessionIndex}`,
    provider: 'codex',
    createdAt: sessionIndex,
    status: 'idle',
    lifecycle: { state: 'active', keepActive: false },
    unread: false,
  })),
}))

function snapshot(): Project[] {
  return projects.map((project) => ({
    ...project,
    sessions: project.sessions.map((session) => ({
      ...session,
      lifecycle: { ...session.lifecycle },
    })),
  }))
}

function view(next: Project[]) {
  return (
    <Sidebar
      projects={next}
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
    />
  )
}

const replaced = render(view(projects))
const reconciled = render(view(projects))

afterAll(() => {
  replaced.unmount()
  reconciled.unmount()
})

describe('unchanged 10,000-thread project refresh', () => {
  bench(
    'replaces every project and chat object',
    () => {
      replaced.rerender(view(snapshot()))
    },
    OPTIONS,
  )

  bench(
    'reconciles the snapshot and skips the React tree',
    () => {
      const next = reconcileProjects(projects, snapshot())
      if (next !== projects) throw new Error('unchanged snapshot lost identity')
      reconciled.rerender(view(next))
    },
    OPTIONS,
  )
})
