// @vitest-environment happy-dom
import { Profiler } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterAll, bench, describe } from 'vitest'
import { Sidebar, type Project, type Session } from './Sidebar.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const noop = () => undefined
const sessions: Session[] = Array.from({ length: 10_000 }, (_, index) => ({
  id: `thread-${index}`,
  title: `Chat ${index}`,
  provider: 'codex',
  createdAt: index,
  status: 'idle',
  lifecycle: { state: 'active', keepActive: false },
  unread: false,
}))
const projects: Project[] = [{ path: '/large-project', name: 'Large project', sessions }]
function createSidebarFixture() {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let commitCount = 0

  flushSync(() => {
    root.render(
      <Profiler id="sidebar" onRender={() => (commitCount += 1)}>
        <Sidebar
          projects={projects}
          activeProjectPath="/large-project"
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
    clickToggle(label: string) {
      const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (candidate) => candidate.textContent === label,
      )
      if (!button) throw new Error(`Missing ${label} button`)
      flushSync(() => button.click())
    },
  }
}

const toggleFixture = createSidebarFixture()
const scrollFixture = createSidebarFixture()
scrollFixture.clickToggle('Show more')
const virtualList = scrollFixture.container.querySelector<HTMLUListElement>(
  '.proj__sessions--virtual',
)!
if (!virtualList) throw new Error('Missing virtual session list')
function scrollVirtualList(scrollTop: number) {
  virtualList.scrollTop = scrollTop
  flushSync(() => fireEvent.scroll(virtualList))
}

const commitsBeforeSameRangeProbe = scrollFixture.commitCount
for (let offset = 0; offset < 10; offset += 1) scrollVirtualList(offset)
const sameRangeProbeCommits = scrollFixture.commitCount - commitsBeforeSameRangeProbe

afterAll(() => {
  for (const fixture of [toggleFixture, scrollFixture]) {
    flushSync(() => fixture.root.unmount())
    fixture.container.remove()
  }
})

describe('large expanded project', () => {
  bench(
    'expands and collapses a 10,000-chat project',
    () => {
      toggleFixture.clickToggle('Show more')
      toggleFixture.clickToggle('Show less')
    },
    OPTIONS,
  )

  bench(
    `handles 100 scroll events inside one virtual row (${sameRangeProbeCommits}/10 probe commits)`,
    () => {
      for (let offset = 0; offset < 100; offset += 1) scrollVirtualList(offset % 32)
    },
    OPTIONS,
  )
})
