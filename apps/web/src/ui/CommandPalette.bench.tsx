// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { bench, describe } from 'vitest'
import {
  CommandPalette,
  MAX_VISIBLE_PALETTE_COMMANDS,
  type PaletteCommand,
} from './CommandPalette.js'
import { createPaletteChatSearch, createPaletteChatSearchCache } from '../palette-chat-search.js'
import { updateSession } from '../project-store.js'
import type { Project } from './Sidebar.js'

const OPTIONS = { iterations: 5, time: 0, warmupIterations: 1, warmupTime: 0 }
const noop = () => undefined
const commands: PaletteCommand[] = Array.from({ length: 10_000 }, (_, index) => ({
  id: `chat-${index}`,
  title: `Chat ${index}`,
  detail: `Project ${index % 100}`,
  group: 'Chats',
  keywords: 'open session conversation',
  run: noop,
}))
const projects: Project[] = Array.from({ length: 100 }, (_, projectIndex) => ({
  path: `/project-${projectIndex}`,
  name: `Project ${projectIndex}`,
  sessions: Array.from({ length: 100 }, (_, sessionIndex) => {
    const index = projectIndex * 100 + sessionIndex
    return {
      id: `thread-${index}`,
      title: `Chat ${index}`,
      provider: 'codex' as const,
      createdAt: index,
      status: 'idle' as const,
      lifecycle: { state: 'active' as const, keepActive: false },
      unread: false,
    }
  }),
}))
const updatedProjects = updateSession(projects, 'thread-9999', (session) => ({
  ...session,
  status: 'working',
}))
let legacyProjectSnapshot = 0
let retainedProjectSnapshot = 0
const retainedSearchCache = createPaletteChatSearchCache()

function eagerChatCommands(): PaletteCommand[] {
  return projects.flatMap((project) =>
    project.sessions.map((session) => ({
      id: `chat-${session.id}`,
      title: session.title,
      detail: project.name ?? project.path,
      group: 'Chats' as const,
      keywords: `${project.path} open session conversation`,
      run: noop,
    })),
  )
}

function renderRows(rows: readonly PaletteCommand[]): void {
  renderToStaticMarkup(
    <div>
      {rows.map((command) => (
        <button key={command.id} type="button">
          <span>{command.title}</span>
          <span>{command.detail}</span>
        </button>
      ))}
    </div>,
  )
}

function legacySearchAllChats(source: readonly Project[]): number {
  const searchable = new Map<Project['sessions'][number], string>()
  let matches = 0
  for (const project of source) {
    const detail = project.name ?? project.path
    for (const session of project.sessions) {
      let text = searchable.get(session)
      if (text === undefined) {
        text =
          `${session.title} ${detail} Chats ${project.path} open session conversation`.toLowerCase()
        searchable.set(session, text)
      }
      if (text.includes('missing-search-token')) matches += 1
    }
  }
  return matches
}

describe('many-thread command palette', () => {
  bench('renders all 10,000 legacy command rows', () => renderRows(commands), OPTIONS)

  bench(
    `renders the bounded ${MAX_VISIBLE_PALETTE_COMMANDS}-row palette`,
    () => {
      renderToStaticMarkup(<CommandPalette commands={commands} scope="all" onClose={noop} />)
    },
    OPTIONS,
  )

  bench(
    'allocates 10,000 eager chat commands before opening',
    () => {
      renderToStaticMarkup(
        <CommandPalette commands={eagerChatCommands()} scope="all" onClose={noop} />,
      )
    },
    OPTIONS,
  )

  bench(
    'materializes only the bounded visible chat commands',
    () => {
      const deferredSearch = createPaletteChatSearch(
        projects,
        (project) => project.name ?? '',
        noop,
      )
      renderToStaticMarkup(
        <CommandPalette commands={[]} scope="all" deferredSearch={deferredSearch} onClose={noop} />,
      )
    },
    OPTIONS,
  )
})

describe('many-thread command palette updates', () => {
  bench(
    'rebuilds searchable text after one immutable status update',
    () => {
      legacyProjectSnapshot = legacyProjectSnapshot === 0 ? 1 : 0
      if (legacySearchAllChats(legacyProjectSnapshot === 0 ? projects : updatedProjects) !== 0) {
        throw new Error('unexpected legacy chat search result')
      }
    },
    { time: 1_200, warmupTime: 300 },
  )

  bench(
    'reuses searchable text after one immutable status update',
    () => {
      retainedProjectSnapshot = retainedProjectSnapshot === 0 ? 1 : 0
      const search = createPaletteChatSearch(
        retainedProjectSnapshot === 0 ? projects : updatedProjects,
        (project) => project.name ?? project.path,
        noop,
        retainedSearchCache,
      )
      if (search(['missing-search-token'], 25).length !== 0) {
        throw new Error('unexpected chat search result')
      }
    },
    { time: 1_200, warmupTime: 300 },
  )
})
