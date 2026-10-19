// @vitest-environment happy-dom
import { Profiler } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterAll, bench, describe } from 'vitest'
import { Sidebar, type Project, type Session } from './Sidebar.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const noop = () => undefined

function session(projectIndex: number, sessionIndex: number): Session {
  return {
    id: `thread-${projectIndex}-${sessionIndex}`,
    title: `Chat ${projectIndex}-${sessionIndex}`,
    provider: 'codex',
    createdAt: projectIndex * 100 + sessionIndex,
    status: 'idle',
    lifecycle: { state: 'active', keepActive: false },
    unread: false,
  }
}

// 100 projects with 100 chats each: 10,000 chats in one flat list.
const projects: Project[] = Array.from({ length: 100 }, (_, projectIndex) => ({
  path: `/project-${projectIndex}`,
  name: `Project ${projectIndex}`,
  sessions: Array.from({ length: 100 }, (_, sessionIndex) => session(projectIndex, sessionIndex)),
}))

function mountSidebar(projectList: Project[]) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let commitCount = 0
  flushSync(() => {
    root.render(
      <Profiler id="sidebar" onRender={() => (commitCount += 1)}>
        <Sidebar
          projects={projectList}
          activeProjectPath={undefined}
          activeSessionId={undefined}
          account={undefined}
          providerName="Codex"
          collapsed={false}
          width={248}
          onClose={noop}
          onWidthChange={noop}
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
      </Profiler>,
    )
  })
  return {
    container,
    root,
    get commitCount() {
      return commitCount
    },
    unmount() {
      flushSync(() => root.unmount())
      container.remove()
    },
  }
}

const scrollFixture = mountSidebar(projects)
const body = scrollFixture.container.querySelector<HTMLElement>('.rail__body')!
if (!body) throw new Error('Missing rail body')
function scrollRail(scrollTop: number) {
  body.scrollTop = scrollTop
  flushSync(() => fireEvent.scroll(body))
}
const commitsBeforeProbe = scrollFixture.commitCount
for (let offset = 0; offset < 10; offset += 1) scrollRail(offset)
const sameRowProbeCommits = scrollFixture.commitCount - commitsBeforeProbe

afterAll(() => scrollFixture.unmount())

describe('flat chat list', () => {
  bench(
    'mounts a rail of 100 projects and 10,000 chats',
    () => {
      // A fresh array per sample keeps this a first-commit benchmark.
      const fixture = mountSidebar(projects.map((project) => ({ ...project })))
      const rows = fixture.container.querySelectorAll('.sessrow').length
      fixture.unmount()
      if (rows > 60) throw new Error(`Mounted ${rows} chat rows for one viewport`)
    },
    OPTIONS,
  )

  bench(
    `handles 100 scroll events inside one row (${sameRowProbeCommits}/10 probe commits)`,
    () => {
      for (let offset = 0; offset < 100; offset += 1) scrollRail(offset % 30)
    },
    OPTIONS,
  )
})
