import { describe, expect, it, vi } from 'vitest'
import type { Project } from '../state/projects'
import type { Source } from '../state/catalog'

vi.mock('../../modules/tastecode-link', () => ({
  TasteLink: { readPreference: () => null, writePreference: () => undefined },
}))

const started = vi.hoisted(() => ({ params: [] as Array<Record<string, unknown>> }))

vi.mock('../state/app', async () => {
  const { Store } = await import('../store')
  return {
    projects: {
      state: new Store({ status: 'ready', error: undefined, activity: {}, projects: [] }),
      touch: vi.fn(),
      refreshSoon: vi.fn(),
    },
    catalog: { state: new Store({ status: 'ready', sources: [] }), load: vi.fn() },
    sessions: {
      acquire: () => ({ addLocalMessage: () => 'local', send: vi.fn(async () => undefined) }),
      release: vi.fn(),
    },
    connection: {
      request: vi.fn(async (method: string, params: Record<string, unknown>) => {
        if (method === 'thread.start') {
          started.params.push(params)
          return { threadId: 'new-thread' }
        }
        return {}
      }),
    },
  }
})

const { NewChat } = await import('./new-chat')
const app = await import('../state/app')
const { chatsView } = await import('../view/chats')

const source: Source = {
  key: 'codex',
  provider: 'codex',
  name: 'Codex',
  capabilities: undefined,
  models: [],
  status: 'ready',
}
const chatFolder: Project = {
  path: '/home/me/.tastecode/threads/2026-11-23-amber-heron',
  name: '2026-11-23-amber-heron',
  pinned: false,
  createdAt: 2,
  chat: true,
  sessions: [
    { id: 'standalone', title: 'Lisbon', provider: 'codex', createdAt: 2, running: false },
  ],
}
const project: Project = {
  path: '/work/project',
  name: 'TasteCode',
  pinned: false,
  createdAt: 1,
  sessions: [],
}

function show(list: Project[]): void {
  app.projects.state.set((current) => ({ ...current, projects: list }))
  app.catalog.state.set(() => ({ status: 'ready', sources: [source] }))
}

describe('new chat on the phone', () => {
  it('never offers or starts in the folder of a chat without a project', async () => {
    show([chatFolder])
    const views: Array<ReturnType<InstanceType<typeof NewChat>['view']>> = []
    const newChat = new NewChat((view) => views.push(view))
    newChat.open(null)
    expect(newChat.view().projectPath).toBeNull()
    await expect(newChat.start('Hello', [])).rejects.toThrow('Add a project first.')
    expect(started.params).toEqual([])
    expect(chatsView(app.projects.state.get()).projects).toEqual([])
    // The chat itself stays listed.
    expect(chatsView(app.projects.state.get()).chats.map((chat) => chat.id)).toEqual(['standalone'])
  })

  it('starts in a real project when opened from a chat without one', async () => {
    show([chatFolder, project])
    const newChat = new NewChat(() => undefined)
    newChat.open(chatFolder.path)
    expect(newChat.view().projectPath).toBe(project.path)
    await newChat.start('Hello', [])
    expect(started.params.at(-1)).toMatchObject({ workspacePath: project.path })
    expect(chatsView(app.projects.state.get()).projects.map((entry) => entry.path)).toEqual([
      project.path,
    ])
  })
})
