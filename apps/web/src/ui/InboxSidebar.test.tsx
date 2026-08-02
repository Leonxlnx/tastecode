// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { InboxSidebar, type InboxActions } from './InboxSidebar.js'
import type { Project, Session } from './Sidebar.js'

afterEach(cleanup)

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
    activeSessionId: undefined,
    actions,
    onScopeChange: vi.fn(),
    onNewSession: vi.fn(),
    onSelectSession: vi.fn(),
    onRenameProject: vi.fn(),
    onRemoveProject: vi.fn(),
    onTogglePin: vi.fn(),
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

    fireEvent.change(screen.getByRole('combobox', { name: 'Sidebar project scope' }), {
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
    fireEvent.click(screen.getByRole('button', { name: 'Load 25 more' }))
    expect(container.querySelectorAll('.inbox-shelf__row')).toHaveLength(37)
    fireEvent.click(screen.getByRole('button', { name: 'Unsettle Settled 30' }))
    expect(actions.onUnsettle).toHaveBeenCalledWith('settled-30')

    const projects = screen.getByText('Projects · 1').closest('details')!
    fireEvent.click(within(projects).getByText('Projects · 1'))
    expect(within(projects).getByRole('button', { name: 'New chat in Alpha' })).toBeTruthy()
  })

  it('offers snooze and keep-active presets from the keyboard-accessible row menu', () => {
    const project: Project = {
      path: '/alpha',
      name: 'Alpha',
      sessions: [active('alpha', 'Alpha task', 1)],
    }
    render(<InboxSidebar {...props([project])} />)

    fireEvent.click(screen.getByRole('button', { name: 'Chat options for Alpha task' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Snooze for 1 hour' }))
    expect(actions.onSnooze).toHaveBeenCalledWith('alpha', expect.any(Number))

    fireEvent.click(screen.getByRole('button', { name: 'Chat options for Alpha task' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Keep active' }))
    expect(actions.onKeepActive).toHaveBeenCalledWith('alpha', true)
  })
})
