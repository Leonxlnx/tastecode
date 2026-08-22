import { describe, expect, it, vi } from 'vitest'
import { createPaletteChatSearch, createPaletteChatSearchCache } from './palette-chat-search.js'
import type { Project } from './ui/Sidebar.js'

const projects: Project[] = [
  {
    path: '/work/alpha',
    name: 'Alpha',
    sessions: [
      {
        id: 'thread-a',
        title: 'Fix keyboard flow',
        provider: 'codex',
        createdAt: 2,
        status: 'idle',
        lifecycle: { state: 'active', keepActive: false },
        unread: false,
      },
    ],
  },
  {
    path: '/work/beta',
    name: 'Beta',
    sessions: [
      {
        id: 'thread-b',
        title: 'Polish the sidebar',
        provider: 'codex',
        createdAt: 1,
        status: 'idle',
        lifecycle: { state: 'active', keepActive: false },
        unread: false,
      },
    ],
  },
]

describe('deferred palette chat search', () => {
  it('preserves sidebar order and materializes only the requested count', () => {
    const search = createPaletteChatSearch(projects, (project) => project.name ?? '', vi.fn())

    expect(search([], 1).map(({ id }) => id)).toEqual(['chat-thread-a'])
    expect(search([], 10).map(({ id }) => id)).toEqual(['chat-thread-a', 'chat-thread-b'])
  })

  it('matches the same title, project, path, and keyword text and runs selection', () => {
    const select = vi.fn()
    const search = createPaletteChatSearch(projects, (project) => project.name ?? '', select)

    expect(search(['polish', 'beta'], 100).map(({ id }) => id)).toEqual(['chat-thread-b'])
    expect(search(['work', 'alpha'], 100).map(({ id }) => id)).toEqual(['chat-thread-a'])
    const result = search(['conversation', 'sidebar'], 100)[0]
    result?.run()
    expect(select).toHaveBeenCalledWith('thread-b')
  })

  it('invalidates retained text when the same session moves under a renamed project', () => {
    const cache = createPaletteChatSearchCache()
    const original = [{ ...projects[0]!, name: 'Original label' }, projects[1]!]
    const first = createPaletteChatSearch(original, (project) => project.name ?? '', vi.fn(), cache)
    expect(first(['original'], 100).map(({ id }) => id)).toEqual(['chat-thread-a'])

    const renamed = [{ ...original[0]!, name: 'Gamma' }, projects[1]!]
    const second = createPaletteChatSearch(renamed, (project) => project.name ?? '', vi.fn(), cache)
    expect(second(['gamma'], 100).map(({ id }) => id)).toEqual(['chat-thread-a'])
    expect(second(['original'], 100).map(({ id }) => id)).toEqual([])
  })
})
