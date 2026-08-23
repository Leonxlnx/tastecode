// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PanelToggles, StageHeader } from './StageHeader.js'

afterEach(cleanup)

function props() {
  return {
    sessionId: 'thread-1',
    title: 'Build the landing page',
    pinned: false,
    projectPath: 'C:\\workspace',
    checkpointCount: 2,
    worktreeBranch: 'codex/landing',
    menuActions: {
      commandPalette: vi.fn(),
      keybindings: vi.fn(),
      newChat: vi.fn(),
      openPullRequests: vi.fn(),
      searchSessions: vi.fn(),
      settings: vi.fn(),
      toggleSidebar: vi.fn(),
      toggleTerminal: vi.fn(),
      toggleWorkspace: vi.fn(),
    },
    onOpenRollback: vi.fn(),
    onRenameSession: vi.fn(),
    onToggleSessionPin: vi.fn(),
    onArchiveSession: vi.fn(),
  }
}

function panelProps() {
  return {
    projectPath: 'C:\\workspace',
    terminalOpen: false,
    workspacePanelOpen: false,
    onToggleWorkspace: vi.fn(),
    onToggleTerminal: vi.fn(),
  }
}

describe('StageHeader', () => {
  it('shares chat actions and supports inline rename', () => {
    const stage = props()
    render(<StageHeader {...stage} />)

    expect(screen.getByText('Build the landing page')).toBeTruthy()
    expect(document.querySelector('.stagehead__drag-region')?.getAttribute('aria-hidden')).toBe(
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Options for Build the landing page' }))
    for (const item of screen.getAllByRole('menuitem')) {
      expect(item.querySelector('svg')).not.toBeNull()
    }
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin chat' }))
    expect(stage.onToggleSessionPin).toHaveBeenCalledWith('thread-1')

    fireEvent.click(screen.getByRole('button', { name: 'Options for Build the landing page' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename chat' }))
    const rename = screen.getByRole('textbox', { name: 'Rename chat' })
    fireEvent.change(rename, { target: { value: 'Polished landing page' } })
    fireEvent.keyDown(rename, { key: 'Enter' })
    expect(stage.onRenameSession).toHaveBeenCalledWith('thread-1', 'Polished landing page')
  })

  it('keeps useful app options available on New chat', () => {
    const stage = props()
    render(
      <StageHeader {...stage} sessionId={undefined} title={undefined} projectPath={undefined} />,
    )

    expect(screen.getByText('New chat')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Options for New chat' }))
    expect(screen.getByRole('menuitem', { name: 'Toggle sidebar' })).toBeTruthy()
    expect(
      (screen.getByRole('menuitem', { name: /Toggle terminal/ }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.getByRole('menuitem', { name: 'New chat' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Search chats' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Command palette' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeTruthy()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Toggle sidebar' }))
    expect(stage.menuActions.toggleSidebar).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Open terminal' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Show workspace tools' })).toBeNull()
  })

  it('runs terminal and workspace actions from the top-bar menu', () => {
    const stage = props()
    render(<StageHeader {...stage} />)

    fireEvent.click(screen.getByRole('button', { name: 'Options for Build the landing page' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Toggle terminal' }))
    expect(stage.menuActions.toggleTerminal).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Options for Build the landing page' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Toggle workspace tools' }))
    expect(stage.menuActions.toggleWorkspace).toHaveBeenCalledOnce()
  })
})

describe('PanelToggles', () => {
  it('keeps both controls mounted while their open state changes', () => {
    const panels = panelProps()
    const { rerender } = render(<PanelToggles {...panels} />)
    const terminal = screen.getByRole('button', { name: 'Open terminal' })
    const workspace = screen.getByRole('button', { name: 'Show workspace tools' })

    expect(terminal.querySelector('.lucide-square-terminal')).not.toBeNull()
    expect(workspace.querySelector('.lucide-panel-right-open')).not.toBeNull()
    fireEvent.click(terminal)
    fireEvent.click(workspace)
    expect(panels.onToggleTerminal).toHaveBeenCalledOnce()
    expect(panels.onToggleWorkspace).toHaveBeenCalledOnce()

    rerender(<PanelToggles {...panels} terminalOpen workspacePanelOpen />)

    expect(screen.getByRole('button', { name: 'Hide terminal' })).toBe(terminal)
    expect(screen.getByRole('button', { name: 'Hide workspace tools' })).toBe(workspace)
    expect(terminal.querySelector('.lucide-square-terminal')).not.toBeNull()
    expect(workspace.querySelector('.lucide-panel-right-close')).not.toBeNull()
    expect(workspace.closest('.panel-toggles')?.classList).toContain('is-workspace-open')
  })

  it('only advertises the terminal shortcut on its selected surface', () => {
    const panels = panelProps()
    const { rerender } = render(<PanelToggles {...panels} />)
    const terminal = screen.getByRole('button', { name: 'Open terminal' })

    expect(terminal.getAttribute('aria-keyshortcuts')).toBe('Meta+J Control+J')
    rerender(<PanelToggles {...panels} terminalShortcutActive={false} />)
    expect(terminal.getAttribute('aria-keyshortcuts')).toBeNull()
  })

  it('keeps workspace controls available without a selected project', () => {
    render(<PanelToggles {...panelProps()} projectPath={undefined} />)

    expect(screen.queryByRole('button', { name: 'Open terminal' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Show workspace tools' })).toBeTruthy()
  })
})
