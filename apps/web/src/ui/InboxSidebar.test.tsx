// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { findSession, updateSession } from '../project-store.js'
import {
  createInboxEntryClassifier,
  InboxSidebar,
  inboxClockDelay,
  retainInboxSelection,
  resolveInboxSelection,
  type InboxActions,
} from './InboxSidebar.js'
import type { Project, Session } from './Sidebar.js'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

const actions: InboxActions = {
  onSettle: vi.fn(),
  onUnsettle: vi.fn(),
  onSnooze: vi.fn(),
  onUnsnooze: vi.fn(),
  onKeepActive: vi.fn(),
}

const active = (
  id: string,
  title: string,
  createdAt: number,
  status: Session['status'] = 'idle',
) => ({
  id,
  title,
  provider: 'codex' as const,
  createdAt,
  status,
  lifecycle: { state: 'active' as const, keepActive: false },
  unread: status === 'ready',
})

function props(projects: Project[]) {
  return {
    projects,
    scope: '',
    activeProjectPath: undefined,
    activeSessionId: undefined,
    actions,
    onScopeChange: vi.fn(),
    onAddProject: vi.fn(),
    onNewSession: vi.fn(),
    onSelectSession: vi.fn(),
    onRenameSession: vi.fn(),
    onArchiveSession: vi.fn(),
  }
}

describe('InboxSidebar', () => {
  it('moves only changed rows in retained many-thread groups', () => {
    const projects: Project[] = Array.from({ length: 10 }, (_, projectIndex) => ({
      path: `/project-${projectIndex}`,
      sessions: Array.from({ length: 100 }, (_, sessionIndex) => {
        const index = projectIndex * 100 + sessionIndex
        return active(`thread-${index}`, `Thread ${index}`, index)
      }),
    }))
    const classify = createInboxEntryClassifier()
    const initial = classify(projects, '', '')
    const retainedEntry = initial.active.find(({ session }) => session.id === 'thread-999')
    const updated = projects.map((project, projectIndex) =>
      projectIndex === 0
        ? {
            ...project,
            sessions: project.sessions.map((session, sessionIndex) =>
              sessionIndex === 0
                ? {
                    ...session,
                    lifecycle: {
                      state: 'settled' as const,
                      settledAt: 1_000,
                      reason: 'manual' as const,
                    },
                  }
                : session,
            ),
          }
        : project,
    )
    const next = classify(updated, '', '')

    expect(next.active).toHaveLength(999)
    expect(next.settled.map(({ session }) => session.id)).toEqual(['thread-0'])
    expect(next.active.find(({ session }) => session.id === 'thread-999')).toBe(retainedEntry)
    expect(next.ordered.map(({ session }) => session.id)).toEqual([
      ...Array.from({ length: 999 }, (_, index) => `thread-${999 - index}`),
      'thread-0',
    ])
  })

  it('uses the exact immutable update location in one 10,000-thread project', () => {
    let idReads = 0
    const sessions: Session[] = Array.from({ length: 10_000 }, (_, index) => {
      const entry = active(`thread-${index}`, `Thread ${index}`, index)
      Object.defineProperty(entry, 'id', {
        enumerable: true,
        get() {
          idReads += 1
          return `thread-${index}`
        },
      })
      return entry
    })
    const projects: Project[] = [{ path: '/large', sessions }]
    const classify = createInboxEntryClassifier()
    classify(projects, '', '')
    const updated = updateSession(projects, 'thread-9999', (entry) => ({
      ...entry,
      status: 'working',
    }))
    idReads = 0

    const next = classify(updated, '', '')

    expect(next.active[0]?.session.status).toBe('working')
    expect(idReads).toBeLessThan(50)
  })

  it('checks only selected IDs when pruning a many-thread selection', () => {
    let idReads = 0
    const sessions: Session[] = Array.from({ length: 10_000 }, (_, index) => {
      const entry = active(`thread-${index}`, `Thread ${index}`, index)
      Object.defineProperty(entry, 'id', {
        enumerable: true,
        get() {
          idReads += 1
          return `thread-${index}`
        },
      })
      return entry
    })
    const projects: Project[] = [{ path: '/large', sessions }]
    const selected = new Set(['thread-5000', 'thread-9999'])
    findSession(projects, 'thread-9999')
    idReads = 0

    expect(retainInboxSelection(projects, selected, '', '')).toBe(selected)
    const filtered = retainInboxSelection(projects, selected, '/large', 'thread 9999')
    const menuEntries = resolveInboxSelection(projects, selected, '/large', 'thread 9999')

    expect([...filtered]).toEqual(['thread-9999'])
    expect(menuEntries.map((entry) => entry.session.id)).toEqual(['thread-9999'])
    expect([...selected]).toEqual(['thread-5000', 'thread-9999'])
    expect(idReads).toBeLessThan(20)
  })

  it('does not queue selection cleanup for status-only bursts', () => {
    let projects: Project[] = [
      {
        path: '/large',
        sessions: Array.from({ length: 100 }, (_, index) =>
          active(`thread-${index}`, `Thread ${index}`, index),
        ),
      },
    ]
    const container = document.createElement('div')
    const root = createRoot(container)
    const inboxProps = props(projects)
    const renderInbox = () =>
      flushSync(() => root.render(<InboxSidebar {...inboxProps} projects={projects} />))

    try {
      renderInbox()
      for (let update = 0; update < 75; update += 1) {
        projects = updateSession(projects, 'thread-0', (entry) => ({
          ...entry,
          status: entry.status === 'idle' ? 'ready' : 'idle',
        }))
        renderInbox()
      }
      expect(container.querySelectorAll('.inbox-card')).toHaveLength(12)
    } finally {
      flushSync(() => root.unmount())
    }
  })

  it('skips unchanged parent commits when every input stays stable', () => {
    let idReads = 0
    const entry = active('thread', 'Thread', 1)
    Object.defineProperty(entry, 'id', {
      enumerable: true,
      get() {
        idReads += 1
        return 'thread'
      },
    })
    const inboxProps = props([{ path: '/project', sessions: [entry] }])
    const container = document.createElement('div')
    const root = createRoot(container)
    const renderInbox = () => flushSync(() => root.render(<InboxSidebar {...inboxProps} />))

    try {
      renderInbox()
      idReads = 0
      renderInbox()
      expect(idReads).toBe(0)
    } finally {
      flushSync(() => root.unmount())
    }
  })

  it('does not wake an idle static inbox and uses the slowest accurate clock', () => {
    const noon = new Date(2026, 7, 21, 12).getTime()

    expect(inboxClockDelay(false, [], false, noon)).toBeUndefined()
    expect(inboxClockDelay(false, [noon - 10 * 60_000], false, noon)).toBe(29_500)
    expect(inboxClockDelay(true, [noon - 10 * 60_000], true, noon)).toBe(1_000)
    expect(inboxClockDelay(false, [], true, noon)).toBe(12 * 60 * 60 * 1_000)
    expect(inboxClockDelay(false, [noon - 2 * 24 * 60 * 60_000], false, noon)).toBe(
      11 * 60 * 60_000 + 29 * 60_000 + 29_500,
    )
  })

  it('wakes only when one of 35 old visible labels changes', () => {
    const day = 24 * 60 * 60_000
    const start = new Date(2026, 7, 21, 12).getTime()
    const timestamps = Array.from(
      { length: 35 },
      (_, index) => start - 10 * day - (index * day) / 35,
    )
    let now = start
    let wakeups = 0
    while (now < start + day) {
      now += inboxClockDelay(false, timestamps, false, now) ?? day
      wakeups += 1
    }

    expect(wakeups).toBe(36)
  })

  it('keeps an old idle label asleep until its exact next change', () => {
    vi.useFakeTimers()
    try {
      const day = 24 * 60 * 60_000
      const now = new Date(2026, 7, 21, 12).getTime()
      const nextChange = 11 * 60 * 60_000 + 29 * 60_000 + 29_500
      vi.setSystemTime(now)
      render(
        <InboxSidebar
          {...props([
            {
              path: '/idle',
              name: 'Idle',
              sessions: [active('idle', 'Old idle thread', now - 2 * day)],
            },
          ])}
        />,
      )

      expect(screen.getByText('2d ago')).toBeTruthy()
      act(() => vi.advanceTimersByTime(nextChange - 1))
      expect(screen.getByText('2d ago')).toBeTruthy()
      act(() => vi.advanceTimersByTime(1))
      expect(screen.getByText('3d ago')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds the mounted rows for 10,000 threads', () => {
    let fillActivePage: IdleRequestCallback | undefined
    vi.stubGlobal(
      'requestIdleCallback',
      vi.fn((callback: IdleRequestCallback) => {
        fillActivePage = callback
        return 1
      }),
    )
    vi.stubGlobal('cancelIdleCallback', vi.fn())
    const sessions: Session[] = Array.from({ length: 10_000 }, (_, index) => {
      const entry = active(`thread-${index}`, `Thread ${index}`, index)
      if (index % 3 === 1) {
        return {
          ...entry,
          lifecycle: { state: 'snoozed', snoozedAt: index, wakeAt: 20_000 - index },
        }
      }
      if (index % 3 === 2) {
        return {
          ...entry,
          lifecycle: { state: 'settled', settledAt: index, reason: 'manual' },
        }
      }
      return entry
    })
    const { container } = render(
      <InboxSidebar {...props([{ path: '/large', name: 'Large', sessions }])} />,
    )

    expect(container.querySelectorAll('.inbox-card')).toHaveLength(12)
    expect(container.querySelectorAll('.inbox-shelf__row')).toHaveLength(10)
    const activeList = screen.getByRole('list', { name: 'Active threads' })
    expect(activeList.querySelector('.inbox__more')).toBeNull()

    act(() => fillActivePage?.({ didTimeout: false, timeRemaining: () => 10 }))
    expect(container.querySelectorAll('.inbox-card')).toHaveLength(25)
    expect(activeList.querySelector('.inbox__more')).toBeTruthy()

    const activeRows = container.querySelectorAll<HTMLButtonElement>('.inbox-card__main')
    activeRows[24]?.focus()
    fireEvent.keyDown(activeRows[24]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(container.querySelector('.inbox-shelf__main'))

    fireEvent.click(screen.getByRole('button', { name: /Snoozed/ }))
    expect(container.querySelectorAll('.inbox-card')).toHaveLength(25)
    expect(container.querySelectorAll('.inbox-shelf__row')).toHaveLength(35)
  })

  it('does not rescan every chat on the one-second working clock', () => {
    vi.useFakeTimers()
    try {
      let idReads = 0
      const sessions: Session[] = Array.from({ length: 1_000 }, (_, index) => {
        const entry = active(`thread-${index}`, `Thread ${index}`, index, 'working')
        Object.defineProperty(entry, 'id', {
          enumerable: true,
          get() {
            idReads += 1
            return `thread-${index}`
          },
        })
        return entry
      })
      render(
        <InboxSidebar
          {...props([{ path: '/large', name: 'Large', sessions }])}
          activeSessionId="thread-999"
        />,
      )
      act(() => vi.advanceTimersByTime(100))
      idReads = 0

      act(() => vi.advanceTimersByTime(900))

      expect(idReads).toBeLessThan(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not rebuild the project toolbar on the one-second working clock', () => {
    vi.useFakeTimers()
    try {
      let nameReads = 0
      const projects: Project[] = Array.from({ length: 1_000 }, (_, index) => {
        const project: Project = {
          path: `/project-${index}`,
          sessions: [active(`thread-${index}`, `Thread ${index}`, index, 'working')],
        }
        Object.defineProperty(project, 'name', {
          enumerable: true,
          get() {
            nameReads += 1
            return `Project ${index}`
          },
        })
        return project
      })
      render(<InboxSidebar {...props(projects)} activeSessionId="thread-999" />)
      act(() => vi.advanceTimersByTime(100))
      nameReads = 0

      act(() => vi.advanceTimersByTime(900))

      expect(nameReads).toBeLessThan(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not rebuild static rows on the one-second working clock', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2026, 7, 21, 12))
      let pinnedReads = 0
      let providerReads = 0
      const sessions: Session[] = Array.from({ length: 35 }, (_, index) => {
        const entry = active(
          `thread-${index}`,
          `Thread ${index}`,
          index,
          index === 24 ? 'working' : 'idle',
        )
        const session =
          index < 25
            ? entry
            : {
                ...entry,
                lifecycle: {
                  state: 'settled' as const,
                  settledAt: index,
                  reason: 'manual' as const,
                },
              }
        Object.defineProperty(session, 'pinned', {
          enumerable: true,
          get() {
            pinnedReads += 1
            return false
          },
        })
        Object.defineProperty(session, 'provider', {
          enumerable: true,
          get() {
            providerReads += 1
            return 'codex'
          },
        })
        return session
      })
      render(<InboxSidebar {...props([{ path: '/large', name: 'Large', sessions }])} />)
      act(() => vi.advanceTimersByTime(100))
      pinnedReads = 0
      providerReads = 0

      act(() => vi.advanceTimersByTime(900))

      expect(pinnedReads).toBe(0)
      expect(providerReads).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('updates second and minute labels on their own clock lanes', () => {
    vi.useFakeTimers()
    try {
      const now = new Date(2026, 7, 21, 12).getTime()
      vi.setSystemTime(now)
      const working = active('working', 'Working thread', now - 1_000, 'working')
      const idle = active('idle', 'Idle thread', now - 89_000)
      const settled: Session = {
        ...active('settled', 'Settled thread', now - 89_000),
        lifecycle: { state: 'settled', settledAt: now - 89_000, reason: 'manual' },
      }
      const { container } = render(
        <InboxSidebar
          {...props([{ path: '/large', name: 'Large', sessions: [working, idle, settled] }])}
        />,
      )

      expect(screen.getByText('Working · 1s')).toBeTruthy()
      expect(screen.getByText('1m ago')).toBeTruthy()
      expect(screen.getByText('Large · 1m ago')).toBeTruthy()

      act(() => vi.advanceTimersByTime(1_000))
      expect(screen.getByText('Working · 2s')).toBeTruthy()
      expect(screen.getByText('1m ago')).toBeTruthy()
      expect(screen.getByText('Large · 1m ago')).toBeTruthy()

      for (let second = 0; second < 59; second++) {
        act(() => vi.advanceTimersByTime(1_000))
      }
      expect(screen.getByText('Working · 1m')).toBeTruthy()
      expect(screen.getByText('2m ago')).toBeTruthy()
      expect(screen.getByText('Large · 2m ago')).toBeTruthy()
      expect(container.querySelectorAll('.inbox-card')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops the working clock while the app is hidden', () => {
    vi.useFakeTimers()
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    const setVisibility = (value: 'hidden' | 'visible') =>
      Object.defineProperty(document, 'visibilityState', { configurable: true, value })
    const project: Project = {
      path: '/active',
      sessions: [active('working', 'Working', 1, 'working')],
    }
    setVisibility('hidden')
    const view = render(<InboxSidebar {...props([project])} />)
    try {
      expect(vi.getTimerCount()).toBe(0)

      act(() => {
        setVisibility('visible')
        document.dispatchEvent(new Event('visibilitychange'))
      })
      expect(vi.getTimerCount()).toBe(1)

      act(() => {
        setVisibility('hidden')
        document.dispatchEvent(new Event('visibilitychange'))
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      view.unmount()
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility)
      else Reflect.deleteProperty(document, 'visibilityState')
      vi.useRealTimers()
    }
  })

  it('flattens projects in stable creation order, scopes them, and guards row actions', () => {
    const projects: Project[] = [
      {
        path: '/alpha',
        name: 'Alpha',
        sessions: [active('alpha-old', 'Older Alpha', 10), active('alpha-new', 'New Alpha', 30)],
      },
      {
        path: '/beta',
        name: 'Beta',
        sessions: [active('beta', 'Beta approval', 20, 'approval')],
      },
    ]
    const onScopeChange = vi.fn()
    const { container, rerender } = render(
      <InboxSidebar {...props(projects)} onScopeChange={onScopeChange} />,
    )

    expect(
      [...container.querySelectorAll('.inbox-card__title')].map((node) => node.textContent),
    ).toEqual(['New Alpha', 'Beta approval', 'Older Alpha'])
    expect(screen.queryByRole('button', { name: 'Settle Beta approval' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Settle New Alpha' })).toBeNull()
    fireEvent.pointerEnter(screen.getByText('New Alpha').closest('.inbox-card')!)
    fireEvent.click(screen.getByRole('button', { name: 'Settle New Alpha' }))
    expect(actions.onSettle).toHaveBeenCalledWith('alpha-new')

    const updated = projects.map((project) =>
      project.path === '/alpha'
        ? {
            ...project,
            sessions: project.sessions.map((session) =>
              session.id === 'alpha-new' ? { ...session, status: 'working' as const } : session,
            ),
          }
        : project,
    )
    rerender(<InboxSidebar {...props(updated)} onScopeChange={onScopeChange} />)
    expect(
      [...container.querySelectorAll('.inbox-card__title')].map((node) => node.textContent),
    ).toEqual(['New Alpha', 'Beta approval', 'Older Alpha'])

    fireEvent.click(screen.getByRole('combobox', { name: 'Sidebar project filter' }))
    fireEvent.click(screen.getByRole('option', { name: 'Alpha' }))
    expect(onScopeChange).toHaveBeenCalledWith('/alpha')

    rerender(<InboxSidebar {...props(projects)} scope="/alpha" />)
    expect(screen.queryByText('Beta approval')).toBeNull()
    expect(
      [...container.querySelectorAll('.inbox-card__title')].map((node) => node.textContent),
    ).toEqual(['New Alpha', 'Older Alpha'])
  })

  it('orders snoozes, pages settled work, and keeps a deep selected row visible', () => {
    const sessions: Session[] = [
      {
        ...active('late', 'Later snooze', 1),
        lifecycle: { state: 'snoozed', snoozedAt: 1, wakeAt: 300 },
      },
      {
        ...active('early', 'Earlier snooze', 2),
        lifecycle: { state: 'snoozed', snoozedAt: 1, wakeAt: 200 },
      },
      ...Array.from({ length: 36 }, (_, index) => ({
        ...active(`settled-${index}`, `Settled ${index}`, index),
        lifecycle: {
          state: 'settled' as const,
          settledAt: 1_000 - index,
          reason: 'manual' as const,
        },
      })),
    ]
    const project: Project = { path: '/alpha', name: 'Alpha', sessions }
    const { container } = render(
      <InboxSidebar {...props([project])} activeSessionId="settled-30" />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Snoozed/ }))
    const shelfTitles = [...container.querySelectorAll('.inbox-shelf__row button:first-child span')]
    expect(shelfTitles.slice(0, 2).map((node) => node.textContent)).toEqual([
      'Earlier snooze',
      'Later snooze',
    ])

    expect(screen.getByText('Settled 30')).toBeTruthy()
    expect(container.querySelectorAll('.inbox-shelf__row')).toHaveLength(13)
    fireEvent.click(screen.getByRole('button', { name: 'Show 25 more' }))
    expect(container.querySelectorAll('.inbox-shelf__row')).toHaveLength(37)
    fireEvent.click(screen.getByRole('button', { name: 'Un-settle Settled 30' }))
    expect(actions.onUnsettle).toHaveBeenCalledWith('settled-30')
  })

  it('keeps project controls at the top and offers all snooze presets', () => {
    const project: Project = {
      path: '/alpha',
      name: 'Alpha',
      sessions: [active('alpha', 'Alpha task', 1)],
    }
    const onNewSession = vi.fn()
    render(
      <InboxSidebar {...props([project])} activeProjectPath="/alpha" onNewSession={onNewSession} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(onNewSession).toHaveBeenCalledWith('/alpha', false)
    expect(screen.getByRole('button', { name: 'Add Project' })).toBeTruthy()

    expect(screen.queryByRole('button', { name: 'Thread options for Alpha task' })).toBeNull()
    fireEvent.focusIn(screen.getByText('Alpha task').closest('button')!)
    fireEvent.click(screen.getByRole('button', { name: 'Thread options for Alpha task' }))
    expect(screen.getByRole('menuitem', { name: 'This evening' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Tomorrow morning' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Next week' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'In one hour' }))
    expect(actions.onSnooze).toHaveBeenCalledWith('alpha', expect.any(Number))

    fireEvent.click(screen.getByRole('button', { name: 'Thread options for Alpha task' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Keep active' }))
    expect(actions.onKeepActive).toHaveBeenCalledWith('alpha', true)
  })

  it('mounts row actions immediately when the narrow layout shows them', () => {
    const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query) =>
        ({
          matches: query === '(max-width: 700px)',
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList,
    )
    const project: Project = {
      path: '/alpha',
      sessions: [active('alpha', 'Alpha task', 1)],
    }
    const view = render(<InboxSidebar {...props([project])} />)
    try {
      expect(screen.getByRole('button', { name: 'Settle Alpha task' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Thread options for Alpha task' })).toBeTruthy()
    } finally {
      view.unmount()
      matchMedia.mockRestore()
    }
  })

  it('searches titles across collapsed lifecycle shelves without changing their order', () => {
    const project: Project = {
      path: '/alpha',
      name: 'Alpha',
      sessions: [
        active('active', 'Active result', 30),
        {
          ...active('snoozed', 'Snoozed result', 20),
          lifecycle: { state: 'snoozed', snoozedAt: 1, wakeAt: Date.now() + 10_000 },
        },
        {
          ...active('settled', 'Settled result', 10),
          lifecycle: { state: 'settled', settledAt: 2, reason: 'manual' },
        },
      ],
    }
    const { container } = render(<InboxSidebar {...props([project])} activeSessionId="settled" />)

    expect(screen.queryByText('Snoozed result')).toBeNull()
    const search = screen.getByRole('textbox', { name: 'Search threads' })
    fireEvent.change(search, {
      target: { value: 'result' },
    })
    expect(
      [...container.querySelectorAll('.inbox-card__title, .inbox-shelf__row > button span')].map(
        (node) => node.textContent,
      ),
    ).toEqual(['Active result', 'Snoozed result', 'Settled result'])

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByText('Active result').closest('button'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByText('Snoozed result').closest('button'))

    fireEvent.change(search, { target: { value: 'active' } })
    expect(screen.getByText('Active result')).toBeTruthy()
    expect(screen.queryByText('Snoozed result')).toBeNull()
    expect(screen.queryByText('Settled result')).toBeNull()
  })

  it('supports command selection and exposes bulk lifecycle actions on right click', () => {
    const project: Project = {
      path: '/alpha',
      name: 'Alpha',
      sessions: [active('one', 'First task', 30), active('two', 'Second task', 20)],
    }
    const onSettleMany = vi.fn()
    render(<InboxSidebar {...props([project])} actions={{ ...actions, onSettleMany }} />)

    const first = screen.getByText('First task').closest('button')!
    const second = screen.getByText('Second task').closest('button')!
    fireEvent.click(first, { metaKey: true })
    fireEvent.click(second, { metaKey: true })
    fireEvent.contextMenu(second)
    for (const item of screen.getAllByRole('menuitem')) {
      expect(item.querySelector('svg')).not.toBeNull()
    }
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settle 2 threads' }))

    expect(onSettleMany).toHaveBeenCalledWith(['one', 'two'])
    expect(actions.onSettle).not.toHaveBeenCalled()
  })

  it('uses canonical provider and ACP source names in thread metadata', () => {
    const sessions: Session[] = [
      { ...active('claude', 'Claude task', 4), provider: 'claude-code' },
      { ...active('grok', 'Grok task', 3), provider: 'grok' },
      { ...active('gemini', 'Gemini task', 2), provider: 'acp', agent: 'gemini' },
      { ...active('api', 'API task', 1), provider: 'api' },
    ]
    render(<InboxSidebar {...props([{ path: '/alpha', sessions }])} />)

    for (const label of ['Claude Code', 'Grok', 'Gemini CLI', 'API connection']) {
      const identity = screen.getByText(label).closest('.source-identity')
      expect(identity?.classList.contains('source-identity--compact')).toBe(true)
      expect(identity?.querySelector('svg')).toBeTruthy()
      expect(identity?.closest('button')?.getAttribute('aria-label')).toContain(label)
    }
  })
})
