// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { InboxSidebar, type InboxActions } from './InboxSidebar.js'
import type { Project, Session } from './Sidebar.js'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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

    fireEvent.change(screen.getByRole('combobox', { name: 'Sidebar project filter' }), {
      target: { value: '/alpha' },
    })
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
    const { container } = render(<InboxSidebar {...props([project])} />)

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
