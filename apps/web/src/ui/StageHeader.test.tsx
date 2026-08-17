// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StageHeader } from './StageHeader.js'

afterEach(cleanup)

function props() {
  return {
    sessionId: 'thread-1',
    title: 'Build the landing page',
    pinned: false,
    projectPath: 'C:\\workspace',
    checkpointCount: 2,
    worktreeBranch: 'codex/landing',
    terminalOpen: false,
    workspacePanelOpen: false,
    onOpenRollback: vi.fn(),
    onToggleWorkspace: vi.fn(),
    onToggleTerminal: vi.fn(),
    onRenameSession: vi.fn(),
    onToggleSessionPin: vi.fn(),
    onArchiveSession: vi.fn(),
  }
}

describe('StageHeader', () => {
  it('shares chat actions and supports inline rename', () => {
    const stage = props()
    render(<StageHeader {...stage} />)

    expect(screen.getByText('Build the landing page')).toBeTruthy()
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

    fireEvent.click(screen.getByRole('button', { name: 'Show workspace tools' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    expect(stage.onToggleWorkspace).toHaveBeenCalledOnce()
    expect(stage.onToggleTerminal).toHaveBeenCalledOnce()
  })

  it('keeps New chat clean while leaving workspace tools available', () => {
    const stage = props()
    render(
      <StageHeader {...stage} sessionId={undefined} title={undefined} projectPath={undefined} />,
    )

    expect(screen.getByText('New chat')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Options for/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open terminal' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Show workspace tools' })).toBeTruthy()
  })

  it('keeps one workspace toggle in place while swapping its action', () => {
    const stage = props()
    const { rerender } = render(<StageHeader {...stage} />)
    const toggle = screen.getByRole('button', { name: 'Show workspace tools' })

    rerender(<StageHeader {...stage} workspacePanelOpen />)

    expect(screen.getByRole('button', { name: 'Hide workspace tools' })).toBe(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
  })
})
