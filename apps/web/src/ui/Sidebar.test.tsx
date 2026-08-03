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
        account={undefined}
        providerName="Codex"
        mode="inbox"
        inbox={{
          onSettle: vi.fn(),
          onUnsettle: vi.fn(),
          onSnooze: vi.fn(),
          onUnsnooze: vi.fn(),
          onKeepActive: vi.fn(),
        }}
        collapsed={false}
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

    fireEvent.click(screen.getByRole('button', { name: 'V1 Classic' }))
    fireEvent.click(screen.getByRole('button', { name: 'V2 Inbox' }))
    expect(onModeChange.mock.calls).toEqual([['classic'], ['inbox']])
  })

  it('keeps rename and archive actions in the chat options menu', () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Options for Polish the sidebar' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename chat' }))
    const input = screen.getByDisplayValue('Polish the sidebar')
    fireEvent.change(input, { target: { value: 'Wider sidebar chats' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRenameSession).toHaveBeenCalledWith('thread-1', 'Wider sidebar chats')

    fireEvent.click(screen.getByRole('button', { name: 'Options for Polish the sidebar' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive chat' }))
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

    fireEvent.click(screen.getByRole('button', { name: 'Project options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive chats' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive chats' }))
    expect(onArchiveProject).toHaveBeenCalledWith(['thread-1', 'thread-2'])

    fireEvent.click(screen.getByRole('button', { name: 'Project options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from sidebar' }))
    expect(
      screen.getByText(
        "This removes the project from the app. Files on your computer and existing chats won't be deleted.",
      ),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove project' }))
    expect(onRemoveProject).toHaveBeenCalledWith('/work/harness')
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
})
