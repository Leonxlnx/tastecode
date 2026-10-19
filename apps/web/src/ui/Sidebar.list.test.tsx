// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { Sidebar, type Project, type Session } from './Sidebar.js'
import type { InboxActions } from './InboxSidebar.js'
import { CHAT_ORDER_KEY } from '../sidebar-order.js'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const chat = (id: string, title: string, createdAt: number, extra: Partial<Session> = {}) =>
  ({
    id,
    title,
    provider: 'codex',
    createdAt,
    status: 'idle',
    lifecycle: { state: 'active', keepActive: false },
    unread: false,
    ...extra,
  }) as Session

function inboxActions(): InboxActions {
  return {
    onSettle: vi.fn(),
    onUnsettle: vi.fn(),
    onSnooze: vi.fn(),
    onUnsnooze: vi.fn(),
    onKeepActive: vi.fn(),
  }
}

type SidebarProps = ComponentProps<typeof Sidebar>

function renderSidebar(projects: Project[], overrides: Partial<SidebarProps> = {}) {
  const props: SidebarProps = {
    projects,
    activeProjectPath: undefined,
    activeSessionId: undefined,
    account: undefined,
    providerName: 'Codex',
    collapsed: false,
    width: 248,
    onWidthChange: vi.fn(),
    onClose: vi.fn(),
    onAddProject: vi.fn(),
    onNewSession: vi.fn(),
    onSelectSession: vi.fn(),
    onRenameProject: vi.fn(),
    onRemoveProject: vi.fn(),
    onTogglePin: vi.fn(),
    onRenameSession: vi.fn(),
    onToggleSessionPin: vi.fn(),
    onDeleteSession: vi.fn(),
    onArchiveProject: vi.fn(),
    onReorderSession: vi.fn(),
    onOpenSearch: vi.fn(),
    onOpenSettings: vi.fn(),
    inbox: inboxActions(),
    ...overrides,
  }
  const view = render(<Sidebar {...props} />)
  return {
    ...view,
    props,
    update: (next: Partial<SidebarProps>) => view.rerender(<Sidebar {...props} {...next} />),
  }
}

const titles = () =>
  Array.from(document.querySelectorAll('.chatlist[aria-label="Chats"] .sess__title')).map(
    (node) => node.textContent,
  )

const twoProjects = (): Project[] => [
  {
    path: '/work/web',
    name: 'web',
    sessions: [chat('w1', 'Polish the sidebar', 30), chat('w2', 'Fix the composer', 10)],
  },
  {
    path: '/work/api',
    name: 'api',
    sessions: [chat('a1', 'Retry budget', 20), chat('a2', 'Ledger migration', 40)],
  },
]

describe('Sidebar flat chat list', () => {
  it('lists every chat in one list, newest first, with its project as a quiet prefix', () => {
    renderSidebar(twoProjects())

    expect(titles()).toEqual([
      'Ledger migration',
      'Polish the sidebar',
      'Retry budget',
      'Fix the composer',
    ])
    const row = screen.getByText('Ledger migration').closest('.sess')!
    expect(row.querySelector('.sess__project')?.textContent).toBe('api')
    expect(row.getAttribute('aria-label')).toBe('Ledger migration, Codex, in api')
    // No project tree: no project heads and no second "add project" control.
    expect(document.querySelector('.proj')).toBeNull()
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeNull()
    expect(screen.getAllByRole('button', { name: /New project/ })).toHaveLength(1)
  })

  it('keeps every chat in place when its status changes, and shows the state in the mark', () => {
    const projects = twoProjects()
    const view = renderSidebar(projects)
    const before = titles()

    const running = projects.map((project) => ({
      ...project,
      sessions: project.sessions.map((session) =>
        session.id === 'w2'
          ? { ...session, status: 'working' as const }
          : session.id === 'a1'
            ? { ...session, status: 'approval' as const, unread: true }
            : session,
      ),
    }))
    view.update({ projects: running })

    expect(titles()).toEqual(before)
    const working = screen.getByText('Fix the composer').closest('.sessrow')!
    expect(working.querySelector('.sess__provider .sess__spinner')).not.toBeNull()
    // A live chat offers no Archive, so hover never hides its time either.
    expect(working.classList.contains('has-actions')).toBe(false)
    expect(within(working as HTMLElement).queryByRole('button', { name: /Archive/ })).toBeNull()
    const waiting = screen.getByText('Retry budget').closest('.sessrow')!
    expect(waiting.querySelector('.sess__provider .sess__status-dot.is-attention')).not.toBeNull()
    expect(waiting.classList.contains('is-unread')).toBe(true)
  })

  it('shows one project through the filter, with its options, and keeps pinned chats', () => {
    const projects = twoProjects()
    projects[0]!.sessions[1] = chat('w2', 'Fix the composer', 10, { pinned: true })
    projects[1]!.sessions[0] = chat('a1', 'Retry budget', 20, { status: 'input' })
    const onNewSession = vi.fn()
    renderSidebar([...projects, { path: '/work/empty', name: 'empty', sessions: [] }], {
      onNewSession,
    })

    expect(screen.getByText('Pinned')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show chats from' }))
    // The waiting project carries a dot in the filter.
    const api = screen.getByRole('menuitemradio', { name: 'api' })
    expect(api.querySelector('.sess__status-dot.is-attention')).not.toBeNull()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'web' }))

    expect(titles()).toEqual(['Polish the sidebar'])
    // Pinned chats stay whatever the filter shows.
    expect(screen.getByText('Fix the composer')).toBeTruthy()
    // One project shown: no prefix, but a dot says another project needs you.
    expect(document.querySelector('.chatlist[aria-label="Chats"] .sess__project')).toBeNull()
    expect(
      document.querySelector('.chatfilter__trigger .sess__status-dot.is-attention'),
    ).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Project options' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(onNewSession).toHaveBeenCalledWith('/work/web', undefined)

    fireEvent.click(screen.getByRole('button', { name: 'Show chats from' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'empty' }))
    expect(screen.getByText('No chats')).toBeTruthy()
  })

  it('confirms deleting a project’s chats and removing it from the filter row', async () => {
    const onArchiveProject = vi.fn()
    const onRemoveProject = vi.fn()
    renderSidebar(twoProjects(), { onArchiveProject, onRemoveProject })
    fireEvent.click(screen.getByRole('button', { name: 'Show chats from' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'web' }))

    fireEvent.click(screen.getByRole('button', { name: 'Project options' }))
    const remove = screen.getByRole('menuitem', { name: 'Remove from sidebar' })
    // Removing only forgets the entry; deleting chats is the destructive one.
    expect(remove.classList.contains('menu__item--danger')).toBe(false)
    expect(
      screen
        .getByRole('menuitem', { name: 'Delete chats' })
        .classList.contains('menu__item--danger'),
    ).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete chats' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete 2 chats' }))
    await waitFor(() => expect(onArchiveProject).toHaveBeenCalledWith(['w1', 'w2']))

    fireEvent.click(screen.getByRole('button', { name: 'Project options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from sidebar' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(onRemoveProject).toHaveBeenCalledWith('/work/web')
  })

  it('archives from the row and restores from the folded Archived section', async () => {
    const inbox = inboxActions()
    const projects = twoProjects()
    projects[0]!.sessions.push(
      chat('w3', 'Old settled chat', 5, {
        lifecycle: { state: 'settled', settledAt: 100, reason: 'inactivity' },
      }),
      chat('w4', 'Snoozed chat', 6, {
        lifecycle: { state: 'snoozed', snoozedAt: 200, wakeAt: Date.now() + 3_600_000 },
      }),
    )
    renderSidebar(projects, { inbox })

    fireEvent.click(screen.getByRole('button', { name: 'Archive Polish the sidebar' }))
    await waitFor(() => expect(inbox.onSettle).toHaveBeenCalledWith('w1'))

    expect(screen.queryByText('Old settled chat')).toBeNull()
    const toggle = screen.getByRole('button', { name: /Archived/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe('Archived2')
    fireEvent.click(toggle)
    // The most recently put away comes first.
    const archived = within(screen.getByRole('list', { name: 'Archived chats' }))
    expect(archived.getAllByText(/chat$/).map((node) => node.textContent)).toEqual([
      'Snoozed chat',
      'Old settled chat',
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Restore Old settled chat' }))
    expect(inbox.onUnsettle).toHaveBeenCalledWith('w3')
    fireEvent.click(screen.getByRole('button', { name: 'Restore Snoozed chat' }))
    expect(inbox.onUnsnooze).toHaveBeenCalledWith('w4')
  })

  it('snoozes a chat from its hover action', () => {
    const inbox = inboxActions()
    renderSidebar(twoProjects(), { inbox })

    fireEvent.click(screen.getByRole('button', { name: 'Snooze Retry budget' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'In one hour' }))
    expect(inbox.onSnooze).toHaveBeenCalledWith('a1', expect.any(Number))
  })

  it('reorders by drag, keeps the order, and still puts a new chat on top', () => {
    const projects = twoProjects()
    const view = renderSidebar(projects)
    const row = (title: string) => screen.getByText(title).closest('.sessrow')!
    const source = row('Fix the composer')
    const target = row('Ledger migration')
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      bottom: 90,
      height: 30,
      left: 0,
      right: 200,
      top: 60,
      width: 200,
      x: 0,
      y: 60,
      toJSON: () => ({}),
    })
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }

    fireEvent.dragStart(source, { dataTransfer })
    fireEvent.dragOver(target, { dataTransfer, clientY: 80 })
    fireEvent.drop(target, { dataTransfer, clientY: 80 })
    fireEvent.dragEnd(source, { dataTransfer })

    // Dropped on the lower half of the oldest chat's row: it lands right after it.
    const dropped = ['Ledger migration', 'Fix the composer', 'Polish the sidebar', 'Retry budget']
    expect(titles()).toEqual(dropped)
    expect(JSON.parse(localStorage.getItem(CHAT_ORDER_KEY) ?? '[]')).toEqual([
      'a2',
      'w2',
      'w1',
      'a1',
    ])
    // Rows are links, not handles: the pointer is the normal one.
    expect(source.classList.contains('is-reorderable')).toBe(true)

    view.update({
      projects: [
        { ...projects[0]!, sessions: [chat('w5', 'Brand new chat', 50), ...projects[0]!.sessions] },
        projects[1]!,
      ],
    })
    expect(titles()).toEqual(['Brand new chat', ...dropped])
  })

  it('mounts only the rows near the viewport of a long list', () => {
    const sessions = Array.from({ length: 600 }, (_, index) =>
      chat(`c${index}`, `Chat ${index}`, 1_000 - index),
    )
    renderSidebar([{ path: '/work/big', name: 'big', sessions }])

    const list = screen.getByRole('list', { name: 'Chats' })
    const rows = list.querySelectorAll('.sessrow')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(80)
    expect(list.style.height).toBe(`${600 * 30}px`)
    expect(rows[0]?.getAttribute('aria-setsize')).toBe('600')
  })
})
