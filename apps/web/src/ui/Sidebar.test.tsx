// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  it('switches directly between the classic and inbox sidebars', () => {
    const onModeChange = vi.fn()
    render(
      <Sidebar
        projects={[]}
        activeProjectPath={undefined}
        activeSessionId={undefined}
        account={{ signedIn: true, email: 'private@example.com', plan: 'Pro' }}
        providerName="Codex"
        hasActiveUsageSession={false}
        usageSummary={{
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
          limits: [{ label: 'Weekly', usedPercent: 87 }],
        }}
        usageSources={['Codex', 'Gemini CLI']}
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
        onModeChange={onModeChange}
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

    fireEvent.click(screen.getByRole('button', { name: 'Switch to V1 Classic sidebar' }))
    expect(onModeChange).toHaveBeenCalledWith('classic')
    const utilityRow = screen.getByRole('button', { name: 'Search chats' }).parentElement
    expect(utilityRow?.contains(screen.getByRole('button', { name: 'New project' }))).toBe(false)
    expect(
      utilityRow?.contains(screen.getByRole('button', { name: 'Switch to V1 Classic sidebar' })),
    ).toBe(true)
    expect(screen.queryByText('private@example.com')).toBeNull()
    expect(screen.getByText('Codex')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Usage limits' }))
    expect(screen.getByRole('dialog', { name: 'Provider usage limits' }).textContent).toContain(
      '13% left',
    )
    expect(screen.queryByText('1k tokens this chat')).toBeNull()
    expect(screen.getByText('Gemini CLI').parentElement?.textContent).toContain('Not reported')
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
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Pinned chat' }))
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

    expect(screen.getByRole('button', { name: 'Chat 5' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Chat 6' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByRole('button', { name: 'Chat 7' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.queryByRole('button', { name: 'Chat 6' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    fireEvent.click(screen.getByRole('button', { name: 'Harness' }))
    fireEvent.click(screen.getByRole('button', { name: 'Harness' }))
    expect(screen.queryByRole('button', { name: 'Chat 6' })).toBeNull()
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

    const source = screen.getByRole('button', { name: 'First chat' }).closest('li')!
    const target = screen.getByRole('button', { name: 'Second chat' }).closest('li')!
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

    fireEvent.mouseLeave(slot!)
    expect(slot?.classList).not.toContain('is-revealed')
    expect(rail?.hasAttribute('inert')).toBe(true)
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

    fireEvent.pointerDown(handle, { clientX: 248, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 160, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 160, pointerId: 1 })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
