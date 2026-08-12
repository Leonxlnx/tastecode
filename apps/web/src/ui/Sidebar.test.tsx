// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Sidebar } from './Sidebar.js'

vi.mock('../bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge.js')>()),
  isMacOS: () => true,
}))

afterEach(cleanup)

const session = (id: string, title: string) => ({
  id,
  title,
  provider: 'codex' as const,
  createdAt: 1,
  status: 'idle' as const,
  lifecycle: { state: 'active' as const, keepActive: false },
  unread: false,
})

describe('Sidebar chat actions', () => {
  it('selects an empty project and shows its empty chat state', () => {
    const onSelectProject = vi.fn()
    render(
      <Sidebar
        projects={[{ path: '/work/empty', name: 'Empty project', sessions: [] }]}
        activeProjectPath={undefined}
        activeSessionId={undefined}
        account={undefined}
        providerName="Codex"
        collapsed={false}
        width={248}
        onWidthChange={vi.fn()}
        onClose={vi.fn()}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectProject={onSelectProject}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )

    expect(screen.getByText('No chats')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Empty project' }))
    expect(onSelectProject).toHaveBeenCalledWith('/work/empty')
    expect(screen.getByText('No chats')).toBeTruthy()
  })

  it('uses the classic account footer in the inbox sidebar', () => {
    const onAddProject = vi.fn()
    const onOpenSettings = vi.fn()
    render(
      <Sidebar
        projects={[]}
        activeProjectPath={undefined}
        activeSessionId={undefined}
        account={{ signedIn: true, email: 'private@example.com', plan: 'Pro' }}
        providerName="Codex"
        usageStates={[
          {
            status: 'ready',
            provider: 'codex',
            summary: {
              session: {
                inputTokens: 800,
                cachedInputTokens: 0,
                outputTokens: 200,
                reasoningTokens: 0,
                totalTokens: 1_000,
              },
              today: {
                inputTokens: 4_000,
                cachedInputTokens: 0,
                outputTokens: 1_000,
                reasoningTokens: 0,
                totalTokens: 5_000,
              },
              limits: [{ label: '7 days', usedPercent: 85 }],
              limitSource: {
                provider: 'codex',
                status: 'ready',
                limits: [{ label: '7 days', usedPercent: 85 }],
              },
            },
          },
        ]}
        onRetryUsage={vi.fn()}
        mode="inbox"
        inbox={{
          onSettle: vi.fn(),
          onUnsettle: vi.fn(),
          onSnooze: vi.fn(),
          onUnsnooze: vi.fn(),
          onKeepActive: vi.fn(),
        }}
        collapsed={false}
        width={248}
        onWidthChange={vi.fn()}
        onClose={vi.fn()}
        onAddProject={onAddProject}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={onOpenSettings}
      />,
    )

    expect(screen.queryByRole('button', { name: /Switch to V[12]/ })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Search threads' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New chat' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add Project' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(onAddProject).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    expect(screen.getByRole('dialog', { name: 'Account and plan limits' })).toBeTruthy()
    expect(screen.getByText('Plan limits')).toBeTruthy()
    expect(screen.getByText('7 days')).toBeTruthy()
    expect(screen.getByText('15% left')).toBeTruthy()
    const limitBar = screen.getByRole('progressbar', { name: 'Codex 7 days left' })
    expect(limitBar.getAttribute('aria-valuenow')).toBe('15')
    expect((limitBar.firstElementChild as HTMLElement).style.width).toBe('15%')
    expect(document.activeElement?.textContent).toContain('Plan limits')

    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    const accountActions = screen
      .getAllByRole('button')
      .filter((button) => ['Profile', 'Settings'].includes(button.textContent ?? ''))
    for (const item of accountActions) expect(item.querySelector('svg')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Profile' }))
    expect(onOpenSettings).toHaveBeenCalledWith('profile')

    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Account' }))

    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }))
    expect(onOpenSettings).toHaveBeenCalledTimes(2)
    expect(onOpenSettings).toHaveBeenLastCalledWith()
  })

  it('shows direct Lucide rename and archive actions for each chat', () => {
    const onRenameSession = vi.fn()
    const onDeleteSession = vi.fn()

    render(
      <Sidebar
        projects={[
          {
            path: '/work/harness',
            name: 'Harness',
            sessions: [session('thread-1', 'Polish the sidebar')],
          },
        ]}
        activeProjectPath="/work/harness"
        activeSessionId="thread-1"
        account={undefined}
        providerName="Codex"
        collapsed={false}
        width={248}
        onWidthChange={vi.fn()}
        onClose={vi.fn()}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={onRenameSession}
        onDeleteSession={onDeleteSession}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )

    const chat = screen.getByText('Polish the sidebar').closest('button')!
    const identity = within(chat).getByText('Codex').closest('.source-identity')
    expect(identity?.classList.contains('source-identity--compact')).toBe(true)
    expect(identity?.querySelector('svg')).toBeTruthy()
    expect(chat.getAttribute('aria-label')).toBe('Polish the sidebar, Codex')

    const rename = screen.getByRole('button', { name: 'Rename Polish the sidebar' })
    const archive = screen.getByRole('button', { name: 'Archive Polish the sidebar' })
    expect(rename.querySelector('svg')).not.toBeNull()
    expect(archive.querySelector('svg')).not.toBeNull()

    fireEvent.click(rename)
    const input = screen.getByDisplayValue('Polish the sidebar')
    fireEvent.change(input, { target: { value: 'Wider sidebar chats' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRenameSession).toHaveBeenCalledWith('thread-1', 'Wider sidebar chats')

    fireEvent.click(screen.getByRole('button', { name: 'Archive Polish the sidebar' }))
    expect(onDeleteSession).toHaveBeenCalledWith('thread-1')
  })

  it('confirms bulk archive and sidebar removal before acting', () => {
    const onArchiveProject = vi.fn()
    const onRemoveProject = vi.fn()
    render(
      <Sidebar
        projects={[
          {
            path: '/work/harness',
            name: 'Harness',
            sessions: [session('thread-1', 'First chat'), session('thread-2', 'Second chat')],
          },
        ]}
        activeProjectPath="/work/harness"
        activeSessionId="thread-1"
        account={undefined}
        providerName="Codex"
        collapsed={false}
        width={248}
        onWidthChange={vi.fn()}
        onClose={vi.fn()}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={onRemoveProject}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={onArchiveProject}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Harness' }))
    expect(screen.queryByDisplayValue('Harness')).toBeNull()

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Harness' }))
    const pinItem = screen.getByRole('menuitem', { name: 'Pin to top' })
    const editItem = screen.getByRole('menuitem', { name: 'Edit name' })
    const archiveItem = screen.getByRole('menuitem', { name: 'Archive chats' })
    const removeItem = screen.getByRole('menuitem', { name: 'Remove from sidebar' })
    for (const item of [pinItem, editItem, archiveItem, removeItem]) {
      expect(item.querySelector('svg')).not.toBeNull()
    }
    expect(removeItem.classList.contains('menu__item--danger')).toBe(true)

    fireEvent.click(archiveItem)
    fireEvent.click(screen.getByRole('button', { name: 'Archive chats' }))
    expect(onArchiveProject).toHaveBeenCalledWith(['thread-1', 'thread-2'])

    fireEvent.click(screen.getByRole('button', { name: 'Project options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from sidebar' }))
    expect(
      screen.getByText(
        'This only removes the project from the sidebar. Its folder and chats stay untouched.',
      ),
    ).toBeTruthy()
    const removeButton = screen.getByRole('button', { name: 'Remove project' })
    expect(removeButton.classList.contains('btn--danger')).toBe(true)
    expect(document.activeElement?.textContent).toBe('Cancel')
    fireEvent.click(removeButton)
    expect(onRemoveProject).toHaveBeenCalledWith('/work/harness')
  })

  it('shows pinned chats once at the top and unpins them from their row menu', () => {
    const onToggleSessionPin = vi.fn()
    const pinned = { ...session('thread-1', 'Pinned chat'), pinned: true }
    render(
      <Sidebar
        projects={[
          {
            path: '/work/harness',
            name: 'Harness',
            sessions: [pinned, session('thread-2', 'Regular chat')],
          },
        ]}
        activeProjectPath="/work/harness"
        activeSessionId="thread-1"
        account={undefined}
        providerName="Codex"
        collapsed={false}
        width={248}
        onWidthChange={vi.fn()}
        onClose={vi.fn()}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onToggleSessionPin={onToggleSessionPin}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )

    expect(screen.getByText('Pinned')).toBeTruthy()
    expect(screen.getAllByText('Pinned chat')).toHaveLength(1)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Pinned chat, Codex' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin chat' }))
    expect(onToggleSessionPin).toHaveBeenCalledWith('thread-1')
  })

  it('shows five project chats until the list is expanded', () => {
    render(
      <Sidebar
        projects={[
          {
            path: '/work/harness',
            name: 'Harness',
            sessions: Array.from({ length: 7 }, (_, index) =>
              session(`thread-${index + 1}`, `Chat ${index + 1}`),
            ),
          },
        ]}
        activeProjectPath="/work/harness"
        activeSessionId="thread-1"
        account={undefined}
        providerName="Codex"
        collapsed={false}
        width={248}
        onWidthChange={vi.fn()}
        onClose={vi.fn()}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Chat 5, Codex' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Chat 6, Codex' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByRole('button', { name: 'Chat 7, Codex' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.queryByRole('button', { name: 'Chat 6, Codex' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    fireEvent.click(screen.getByRole('button', { name: 'Harness' }))
    fireEvent.click(screen.getByRole('button', { name: 'Harness' }))
    expect(screen.queryByRole('button', { name: 'Chat 6, Codex' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy()
  })

  it('reorders chats when one is dragged between sidebar rows', () => {
    const onReorderSession = vi.fn()

    render(
      <Sidebar
        projects={[
          {
            path: '/work/harness',
            name: 'Harness',
            sessions: [session('thread-1', 'First chat'), session('thread-2', 'Second chat')],
          },
        ]}
        activeProjectPath="/work/harness"
        activeSessionId="thread-1"
        account={undefined}
        providerName="Codex"
        collapsed={false}
        width={248}
        onWidthChange={vi.fn()}
        onClose={vi.fn()}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={onReorderSession}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )

    const source = screen.getByRole('button', { name: 'First chat, Codex' }).closest('li')!
    const target = screen.getByRole('button', { name: 'Second chat, Codex' }).closest('li')!
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      bottom: 88,
      height: 28,
      left: 0,
      right: 200,
      top: 60,
      width: 200,
      x: 0,
      y: 60,
      toJSON: () => ({}),
    })
    const dataTransfer = {
      dropEffect: 'none',
      effectAllowed: 'none',
      setData: vi.fn(),
    }

    fireEvent.dragStart(source, { dataTransfer })
    fireEvent.dragOver(target, { clientY: 80, dataTransfer })
    expect(target.dataset.dropPosition).toBe('after')
    fireEvent.drop(target, { clientY: 80, dataTransfer })

    expect(onReorderSession).toHaveBeenCalledWith('/work/harness', 'thread-1', 'thread-2', 'after')
  })

  it('closes an open sidebar from the mobile backdrop', () => {
    const onClose = vi.fn()

    render(
      <Sidebar
        projects={[]}
        activeProjectPath={undefined}
        activeSessionId={undefined}
        account={undefined}
        providerName="Codex"
        collapsed={false}
        width={248}
        onWidthChange={vi.fn()}
        onClose={onClose}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Close sidebar' }))

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('reveals a collapsed sidebar only while the pointer is at the window edge', () => {
    const { container } = render(
      <Sidebar
        projects={[]}
        activeProjectPath={undefined}
        activeSessionId={undefined}
        account={undefined}
        providerName="Codex"
        collapsed
        width={248}
        onWidthChange={vi.fn()}
        onClose={vi.fn()}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )

    const slot = container.querySelector('.rail-slot')
    const rail = container.querySelector('nav')
    const edge = container.querySelector('.rail__edge')
    expect(slot?.classList).toContain('is-collapsed')
    expect(slot?.classList).not.toContain('is-revealed')
    expect(rail?.hasAttribute('inert')).toBe(true)

    fireEvent.mouseEnter(edge!)
    expect(slot?.classList).toContain('is-revealed')
    expect(rail?.hasAttribute('inert')).toBe(false)

    // Leaving hides only after a grace period, so the pointer can travel to
    // the title bar toggle without the flyout flickering away.
    vi.useFakeTimers()
    try {
      // Coming to rest anywhere in the rail's column keeps it, however the
      // pointer got there — this is the path to the title bar toggle.
      fireEvent.mouseLeave(slot!)
      act(() => {
        vi.advanceTimersByTime(1_000)
      })
      expect(slot?.classList).toContain('is-revealed')

      // Moving away arms the hide once. Carrying on moving must not postpone
      // it, or the rail would stay out until the mouse came to a full stop.
      fireEvent.mouseMove(window, { clientX: 900, clientY: 400 })
      act(() => {
        vi.advanceTimersByTime(60)
      })
      fireEvent.mouseMove(window, { clientX: 905, clientY: 405 })
      fireEvent.mouseMove(window, { clientX: 910, clientY: 410 })
      act(() => {
        vi.advanceTimersByTime(80)
      })
      expect(slot?.classList).not.toContain('is-revealed')
      expect(rail?.hasAttribute('inert')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a revealed rail in place while the pointer travels to the toggle', () => {
    const view = (collapsed: boolean) => (
      <Sidebar
        projects={[]}
        activeProjectPath={undefined}
        activeSessionId={undefined}
        account={undefined}
        providerName="Codex"
        collapsed={collapsed}
        width={240}
        onWidthChange={vi.fn()}
        onClose={vi.fn()}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    )
    const { container, rerender } = render(view(true))
    const slot = container.querySelector('.rail-slot')
    fireEvent.mouseEnter(container.querySelector('.rail__edge')!)
    expect(slot?.classList).toContain('is-revealed')

    vi.useFakeTimers()
    try {
      // Aiming at the title bar toggle leaves the slot but stays at the rail.
      fireEvent.mouseLeave(slot!)
      fireEvent.mouseMove(window, { clientX: 300, clientY: 12 })
      // And once it comes to rest there, with no further moves at all.
      act(() => {
        vi.advanceTimersByTime(1_000)
      })
      expect(slot?.classList).toContain('is-revealed')

      // Pressing it docks the rail open for good: no collapsed flyout left.
      rerender(view(false))
      act(() => {
        vi.advanceTimersByTime(1_000)
      })
      expect(slot?.classList).not.toContain('is-collapsed')
      expect(slot?.classList).not.toContain('is-revealed')

      // Well clear of the rail it retracts as before.
      rerender(view(true))
      fireEvent.mouseEnter(container.querySelector('.rail__edge')!)
      expect(slot?.classList).toContain('is-revealed')
      fireEvent.mouseMove(window, { clientX: 900, clientY: 400 })
      act(() => {
        vi.advanceTimersByTime(1_000)
      })
      expect(slot?.classList).not.toContain('is-revealed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a rail folded by dragging does not spring back out under the pointer', () => {
    const onClose = vi.fn()
    const view = (collapsed: boolean) => (
      <Sidebar
        projects={[]}
        activeProjectPath={undefined}
        activeSessionId={undefined}
        account={undefined}
        providerName="Codex"
        collapsed={collapsed}
        width={248}
        onWidthChange={vi.fn()}
        onClose={onClose}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    )
    const { container, rerender } = render(view(false))
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })

    vi.useFakeTimers()
    try {
      // Fold it and let go with the pointer resting on the reveal strip.
      fireEvent.pointerDown(handle, { clientX: 248, pointerId: 1 })
      fireEvent.pointerMove(handle, { clientX: 80, pointerId: 1 })
      fireEvent.pointerUp(handle, { clientX: 3, pointerId: 1 })
      expect(onClose).toHaveBeenCalledOnce()
      rerender(view(true))

      const slot = container.querySelector('.rail-slot')
      // Hovering the strip during the wait is ignored.
      fireEvent.mouseEnter(container.querySelector('.rail__edge')!)
      act(() => {
        vi.advanceTimersByTime(600)
      })
      expect(slot?.classList).not.toContain('is-revealed')

      // Once it passes, a pointer still parked there gets its reveal.
      act(() => {
        vi.advanceTimersByTime(1_000)
      })
      expect(slot?.classList).toContain('is-revealed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('resizes a revealed rail without collapsing it', () => {
    const onClose = vi.fn()
    const onWidthChange = vi.fn()
    const { container } = render(
      <Sidebar
        projects={[]}
        activeProjectPath={undefined}
        activeSessionId={undefined}
        account={undefined}
        providerName="Codex"
        collapsed
        width={248}
        onWidthChange={onWidthChange}
        onClose={onClose}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )

    // A collapsed rail has no drag edge until it is revealed.
    expect(screen.queryByRole('separator', { name: 'Resize sidebar' })).toBeNull()
    fireEvent.mouseEnter(container.querySelector('.rail__edge')!)
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })

    // Dragging it narrow keeps the reveal: there is nothing left to collapse.
    fireEvent.pointerDown(handle, { clientX: 248, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 60, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 60, pointerId: 1 })
    expect(onClose).not.toHaveBeenCalled()
    expect(onWidthChange).toHaveBeenCalledWith(240)

    // Widening carries the pointer clear of the rail, which must not retract it.
    vi.useFakeTimers()
    try {
      fireEvent.pointerDown(handle, { clientX: 248, pointerId: 2 })
      fireEvent.pointerMove(handle, { clientX: 420, pointerId: 2 })
      act(() => {
        vi.advanceTimersByTime(1_000)
      })
      expect(container.querySelector('.rail-slot')?.classList).toContain('is-revealed')
      fireEvent.pointerUp(handle, { clientX: 420, pointerId: 2 })
      expect(onWidthChange).toHaveBeenCalledWith(420)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resizes with pointer or keyboard and collapses below the threshold', () => {
    const onClose = vi.fn()
    const onWidthChange = vi.fn()
    render(
      <Sidebar
        projects={[]}
        activeProjectPath={undefined}
        activeSessionId={undefined}
        account={undefined}
        providerName="Codex"
        collapsed={false}
        width={248}
        onWidthChange={onWidthChange}
        onClose={onClose}
        onAddProject={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onRenameProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onTogglePin={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onArchiveProject={vi.fn()}
        onReorderSession={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    )

    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(onWidthChange).toHaveBeenCalledWith(256)

    // Dragging a little past the stop clamps at the minimum instead of
    // squeezing the content, and does not collapse.
    fireEvent.pointerDown(handle, { clientX: 248, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 200, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 200, pointerId: 1 })
    expect(onWidthChange).toHaveBeenCalledWith(240)
    expect(onClose).not.toHaveBeenCalled()

    // Far past the stop the rail folds as a preview; pulling back while still
    // holding unfolds it again, and releasing keeps it open at that width.
    fireEvent.pointerDown(handle, { clientX: 248, pointerId: 2 })
    fireEvent.pointerMove(handle, { clientX: 80, pointerId: 2 })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerMove(handle, { clientX: 270, pointerId: 2 })
    fireEvent.pointerUp(handle, { clientX: 270, pointerId: 2 })
    expect(onClose).not.toHaveBeenCalled()
    expect(onWidthChange).toHaveBeenCalledWith(270)

    // Releasing while folded makes the collapse real.
    fireEvent.pointerDown(handle, { clientX: 248, pointerId: 3 })
    fireEvent.pointerMove(handle, { clientX: 80, pointerId: 3 })
    fireEvent.pointerUp(handle, { clientX: 80, pointerId: 3 })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('releases a sidebar resize when native window movement cancels its pointer', () => {
    const onWidthChange = vi.fn()
    render(
      <div className="shell">
        <Sidebar
          projects={[]}
          activeProjectPath={undefined}
          activeSessionId={undefined}
          account={undefined}
          providerName="Codex"
          collapsed={false}
          width={248}
          onWidthChange={onWidthChange}
          onClose={vi.fn()}
          onAddProject={vi.fn()}
          onNewSession={vi.fn()}
          onSelectSession={vi.fn()}
          onRenameProject={vi.fn()}
          onRemoveProject={vi.fn()}
          onTogglePin={vi.fn()}
          onRenameSession={vi.fn()}
          onDeleteSession={vi.fn()}
          onArchiveProject={vi.fn()}
          onReorderSession={vi.fn()}
          onOpenSearch={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </div>,
    )
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    const shell = handle.closest('.shell')

    fireEvent.pointerDown(handle, { clientX: 248, pointerId: 7 })
    fireEvent.pointerMove(handle, { clientX: 320, pointerId: 7 })
    expect(shell?.hasAttribute('data-resizing')).toBe(true)

    fireEvent.pointerCancel(handle, { clientX: 320, pointerId: 7 })
    expect(onWidthChange).toHaveBeenCalledWith(320)
    expect(shell?.hasAttribute('data-resizing')).toBe(false)

    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 7 })
    expect(onWidthChange).toHaveBeenCalledTimes(1)
  })
})
