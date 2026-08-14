// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WelcomeDialog } from './WelcomeDialog.js'

afterEach(cleanup)

describe('first-run welcome', () => {
  it('covers exactly the three beta plans and reuses project and provider setup', () => {
    const onAddProject = vi.fn()
    const onOpenProviders = vi.fn()
    render(
      <WelcomeDialog
        providerStatuses={[
          {
            id: 'codex',
            displayName: 'Codex',
            installed: true,
            auth: 'authenticated',
          },
          {
            id: 'grok',
            displayName: 'Grok',
            installed: false,
            auth: 'unauthenticated',
          },
        ]}
        onAddProject={onAddProject}
        onOpenProviders={onOpenProviders}
        onDismiss={vi.fn()}
      />,
    )

    const plans = screen.getByLabelText('Supported beta plans')
    expect(plans.textContent).toContain('CodexInstalled')
    expect(plans.textContent).toContain('Claude CodeChecking…')
    expect(plans.textContent).toContain('GrokSetup needed')
    expect(plans.querySelectorAll('.welcome__provider')).toHaveLength(3)

    fireEvent.click(screen.getByRole('button', { name: 'Set up agents' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
    expect(onOpenProviders).toHaveBeenCalledOnce()
    expect(onAddProject).toHaveBeenCalledOnce()
  })

  it('dismisses with Escape', () => {
    const onDismiss = vi.fn()
    render(
      <WelcomeDialog
        providerStatuses={[]}
        onAddProject={vi.fn()}
        onOpenProviders={vi.fn()}
        onDismiss={onDismiss}
      />,
    )

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
