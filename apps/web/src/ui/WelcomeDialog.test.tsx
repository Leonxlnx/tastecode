// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WelcomeDialog } from './WelcomeDialog.js'

afterEach(cleanup)

describe('first-run welcome', () => {
  it('asks for a local name and reuses project and provider setup', () => {
    const onAddProject = vi.fn()
    const onOpenProviders = vi.fn()
    const onDisplayNameChange = vi.fn()
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
        displayName=""
        onDisplayNameChange={onDisplayNameChange}
        onAddProject={onAddProject}
        onOpenProviders={onOpenProviders}
        onDismiss={vi.fn()}
      />,
    )

    const name = screen.getByRole('textbox', { name: 'What should we call you?' })
    expect(document.activeElement).toBe(name)
    fireEvent.change(name, { target: { value: 'Blue Emi' } })
    expect(onDisplayNameChange).toHaveBeenCalledWith('Blue Emi')
    expect(screen.getByText(/Your name, projects, and chats stay on this machine/u)).toBeTruthy()

    const plans = screen.getByLabelText('Supported beta plans')
    expect(plans.textContent).toContain('CodexInstalled')
    expect(plans.textContent).toContain('Claude CodeChecking…')
    expect(plans.textContent).toContain('GrokSetup needed')
    expect(plans.querySelectorAll('.welcome__provider')).toHaveLength(3)

    fireEvent.click(screen.getByRole('button', { name: 'Set up providers' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose a project' }))
    expect(onOpenProviders).toHaveBeenCalledOnce()
    expect(onAddProject).toHaveBeenCalledOnce()
  })

  it('dismisses with Escape', () => {
    const onDismiss = vi.fn()
    render(
      <WelcomeDialog
        providerStatuses={[]}
        displayName="Blue Emi"
        onDisplayNameChange={vi.fn()}
        onAddProject={vi.fn()}
        onOpenProviders={vi.fn()}
        onDismiss={onDismiss}
      />,
    )

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
