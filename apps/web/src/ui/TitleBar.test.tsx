// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TitleBar } from './TitleBar.js'

afterEach(cleanup)

describe('TitleBar workspace controls', () => {
  it('keeps one toggle mounted while the fixed expand slot becomes available', () => {
    const onToggleWorkspacePanel = vi.fn()
    const onToggleWorkspacePanelExpanded = vi.fn()
    const props = {
      collapsed: false,
      workspacePanelExpanded: false,
      onToggleRail: vi.fn(),
      onToggleWorkspacePanel,
      onToggleWorkspacePanelExpanded,
    }
    const { rerender } = render(<TitleBar {...props} workspacePanelOpen={false} />)

    const toggle = screen.getByRole('button', { name: 'Show workspace sidebar' })
    const expand = document.querySelector<HTMLButtonElement>('.titlebar__workspace-expand')!
    expect(expand.getAttribute('aria-hidden')).toBe('true')
    expect(expand.tabIndex).toBe(-1)

    rerender(<TitleBar {...props} workspacePanelOpen />)

    const openToggle = screen.getByRole('button', { name: 'Hide workspace sidebar' })
    expect(openToggle).toBe(toggle)
    expect(expand.getAttribute('aria-hidden')).toBe('false')
    expect(expand.tabIndex).toBe(0)

    fireEvent.click(openToggle)
    fireEvent.click(expand)
    expect(onToggleWorkspacePanel).toHaveBeenCalledOnce()
    expect(onToggleWorkspacePanelExpanded).toHaveBeenCalledOnce()
  })
})
