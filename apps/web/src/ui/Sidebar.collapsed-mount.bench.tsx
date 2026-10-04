// @vitest-environment happy-dom
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { bench, describe } from 'vitest'
import { Sidebar, type Project, type Session } from './Sidebar.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
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

const projects: Project[] = Array.from({ length: 100 }, (_, projectIndex) => ({
  path: `/project-${projectIndex}`,
  name: `Project ${projectIndex}`,
  sessions: Array.from({ length: 100 }, (_, sessionIndex) => session(projectIndex, sessionIndex)),
}))
const emptyProjects: Project[] = projects.map((project) => ({ ...project, sessions: [] }))
const viewportProjects = projects.slice(0, 30)

function mountCollapsedSidebar(
  projectList: Project[],
  options: { openFirstProject?: boolean; revealFirstProjectActions?: boolean } = {},
) {
  // Sidebar caches projections by project identity. A fresh top-level project
  // object per sample keeps this a first-commit benchmark instead of silently
  // turning every sample after the first into a warm-cache update.
  const coldProjectList = projectList.map((project) => ({ ...project }))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(
      <Sidebar
        projects={coldProjectList}
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
        onReorderProject={noop}
        onOpenSearch={noop}
        onOpenSettings={noop}
      />,
    )
  })
  if (options.revealFirstProjectActions) {
    const firstProjectAction = container.querySelector<HTMLButtonElement>('.proj__head .icon-btn')
    if (!firstProjectAction) throw new Error('Missing first project action')
    flushSync(() => firstProjectAction.focus())
  }
  if (options.openFirstProject) {
    const firstProject = container.querySelector<HTMLButtonElement>('.proj__toggle')
    if (!firstProject) throw new Error('Missing first project toggle')
    flushSync(() => firstProject.click())
  }
  const mountedChatRows = container.querySelectorAll('.sess').length
  const mountedProjectRows = container.querySelectorAll('.proj').length
  const mountedProjectIcons = container.querySelectorAll('.proj__head svg').length
  flushSync(() => root.unmount())
  container.remove()
  return { mountedChatRows, mountedProjectRows, mountedProjectIcons }
}

describe('many-project classic sidebar first commit', () => {
  bench(
    'mounts the sidebar shell without projects',
    () => {
      mountCollapsedSidebar([])
    },
    OPTIONS,
  )

  bench(
    'mounts a 30-project viewport',
    () => {
      mountCollapsedSidebar(viewportProjects)
    },
    OPTIONS,
  )

  bench(
    'mounts the first viewport of 100 collapsed empty projects',
    () => {
      if (mountCollapsedSidebar(emptyProjects).mountedProjectRows !== 30) {
        throw new Error('Initial commit did not stay inside the 30-project viewport')
      }
    },
    OPTIONS,
  )

  bench(
    'mounts the first viewport of 100 projects containing 10,000 chats',
    () => {
      const result = mountCollapsedSidebar(projects)
      if (result.mountedProjectRows !== 30) {
        throw new Error('Initial commit did not stay inside the 30-project viewport')
      }
      if (result.mountedChatRows !== 0) {
        throw new Error('Collapsed projects mounted hidden chat rows')
      }
      if (result.mountedProjectIcons !== 0) {
        throw new Error(`Expected no initial project SVGs, found ${result.mountedProjectIcons}`)
      }
    },
    OPTIONS,
  )

  bench(
    'mounts the first viewport and reveals the first row actions',
    () => {
      const result = mountCollapsedSidebar(projects, { revealFirstProjectActions: true })
      if (result.mountedProjectIcons !== 2) {
        throw new Error(`Expected 2 revealed project SVGs, found ${result.mountedProjectIcons}`)
      }
    },
    OPTIONS,
  )

  bench(
    'mounts the first viewport then opens its first project',
    () => {
      if (mountCollapsedSidebar(projects, { openFirstProject: true }).mountedChatRows !== 5) {
        throw new Error('Opening one project did not mount exactly five chat rows')
      }
    },
    OPTIONS,
  )
})
