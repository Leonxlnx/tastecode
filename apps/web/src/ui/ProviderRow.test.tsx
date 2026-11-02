// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderRow } from './ProviderRow.js'

afterEach(cleanup)

describe('provider row grammar', () => {
  it('keeps fixed semantic slots and normalizes identity', () => {
    const { container } = render(
      <ProviderRow
        provider={{
          id: 'codex',
          displayName: 'Codex',
          installed: true,
          auth: 'unknown',
          version: 'codex-cli 1.4.0',
        }}
        status="Checking account…"
        live
        issue={{ message: 'Status unavailable', announce: true }}
        primary={{ label: 'Retry' }}
      />,
    )
    const row = container.querySelector<HTMLElement>('.provider-row')!
    expect(Array.from(row.children).map((child) => child.className)).toEqual([
      'provider-row__mark',
      'provider-row__identity',
      'set-leader',
      'provider-row__status set-entity__status',
      'provider-row__secondary',
      'provider-row__primary',
    ])
    // A settings entity row: its name in the entity role, its wire the shared leader.
    expect(row.querySelector('.provider-row__identity > .set-entity__name')?.textContent).toBe(
      'Codex',
    )
    expect(row.querySelector('.set-leader')?.getAttribute('aria-hidden')).toBe('true')
    expect(row.querySelector('.provider-row__mark svg')?.getAttribute('width')).toBe('18')
    expect(row.querySelector('.provider-row__mark')?.getAttribute('title')).toBe('codex-cli 1.4.0')
    expect(within(row).queryByText('codex-cli 1.4.0')).toBeNull()
    expect(within(row).getByRole('status').getAttribute('aria-atomic')).toBe('true')
    const issue = within(row).getByRole('button', { name: 'Problem details' })
    expect(issue.closest('.provider-row__status')).toBeTruthy()
    fireEvent.focus(issue)
    expect(issue.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id)
    expect(within(row).getByRole('alert').textContent).toBe('Status unavailable')
  })

  it('distinguishes real actions from an external setup guide', () => {
    const { rerender } = render(
      <ProviderRow
        provider={{ id: 'grok', displayName: 'Grok', installed: false, auth: 'unknown' }}
        status="Not installed"
        primary={{ label: 'Open setup guide', href: 'https://x.ai/cli' }}
      />,
    )
    const guide = screen.getByRole('link', { name: 'Open setup guide' })
    expect(guide.getAttribute('target')).toBe('_blank')
    expect(guide.getAttribute('rel')).toBe('noopener noreferrer')
    expect(guide.querySelector('svg')).toBeTruthy()

    rerender(
      <ProviderRow
        provider={{ id: 'grok', displayName: 'Grok', installed: true, auth: 'unknown' }}
        status="Signed in"
        primary={{ label: 'Sign out', danger: true }}
      />,
    )
    const signOut = screen.getByRole('button', { name: 'Sign out' })
    expect(signOut.className).toBe('set-button set-button--danger')
  })

  it('draws sign-out as the danger button in either slot, and other secondary actions quiet', () => {
    const { rerender } = render(
      <ProviderRow
        provider={{ id: 'acp', displayName: 'Kimi CLI', installed: true, auth: 'unknown' }}
        status="Signed in"
        secondary={{ label: 'Sign out', danger: true }}
      />,
    )
    expect(screen.getByRole('button', { name: 'Sign out' }).className).toBe(
      'set-button set-button--danger',
    )

    rerender(
      <ProviderRow
        provider={{ id: 'grok', displayName: 'Grok', installed: true, auth: 'unknown' }}
        status="Installing…"
        primary={{ label: 'Install' }}
        secondary={{ label: 'Details' }}
      />,
    )
    expect(screen.getByRole('button', { name: 'Install' }).className).toBe('set-button')
    expect(screen.getByRole('button', { name: 'Details' }).className).toBe(
      'set-button set-button--quiet',
    )
  })

  it('keeps secondary actions before primary actions in focus order', () => {
    render(
      <ProviderRow
        provider={{ id: 'grok', displayName: 'Grok', installed: true, auth: 'unknown' }}
        status="Installing…"
        primary={{ label: 'Install' }}
        secondary={{ label: 'Details' }}
      />,
    )
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Details',
      'Install',
    ])
  })

  it('states how the provider is wired to an account', () => {
    const provider = { id: 'grok', displayName: 'Grok', installed: true, auth: 'unknown' } as const
    const { container, rerender } = render(<ProviderRow provider={provider} status="Signed in" />)
    const row = () => container.querySelector<HTMLElement>('.provider-row')!
    // A provider waits for an account unless the caller says otherwise.
    expect(row().dataset['link']).toBe('open')
    expect(row().dataset['live']).toBeUndefined()
    expect(row().dataset['fault']).toBeUndefined()

    rerender(<ProviderRow provider={provider} status="Signed in" link="connected" />)
    expect(row().dataset['link']).toBe('connected')

    rerender(<ProviderRow provider={provider} status="Installing…" link="none" live />)
    expect(row().dataset['link']).toBe('none')
    expect(row().dataset['live']).toBe('true')

    // Only an announced failure breaks the wire; a standing note does not.
    rerender(
      <ProviderRow provider={provider} status="Not signed in" issue={{ message: 'Update me' }} />,
    )
    expect(row().dataset['fault']).toBeUndefined()
    rerender(
      <ProviderRow
        provider={provider}
        status="Sign-in failed"
        issue={{ message: 'The CLI exited.', announce: true }}
      />,
    )
    expect(row().dataset['fault']).toBe('true')
  })
})

const codex = { id: 'codex', displayName: 'Codex', installed: true, auth: 'unknown' } as const

describe('a done action that undoes itself', () => {
  it('waits for the pointer that just did it to leave before undoing', () => {
    const undo = vi.fn()
    render(
      <ProviderRow
        provider={codex}
        status="OpenAI · Signed in"
        primary={{
          label: 'Added',
          done: true,
          undo: 'Remove',
          ariaLabel: 'Remove Codex',
          fresh: true,
          onClick: undo,
        }}
      />,
    )
    const button = screen.getByRole('button', { name: 'Remove Codex' })
    expect(button.dataset['fresh']).toBe('true')
    // The second click of a double click lands here and does nothing.
    fireEvent.click(button)
    expect(undo).not.toHaveBeenCalled()

    fireEvent.pointerLeave(button)
    expect(button.dataset['fresh']).toBeUndefined()
    fireEvent.click(button)
    expect(undo).toHaveBeenCalledOnce()
  })

  it('undoes at once when it was done before, and from the keyboard', () => {
    const undo = vi.fn()
    render(
      <ProviderRow
        provider={codex}
        status="OpenAI"
        primary={{
          label: 'Added',
          done: true,
          undo: 'Remove',
          ariaLabel: 'Remove Codex',
          onClick: undo,
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove Codex' }))
    expect(undo).toHaveBeenCalledOnce()

    cleanup()
    render(
      <ProviderRow
        provider={codex}
        status="OpenAI"
        primary={{
          label: 'Added',
          done: true,
          undo: 'Remove',
          ariaLabel: 'Remove Codex',
          fresh: true,
          onClick: undo,
        }}
      />,
    )
    const fresh = screen.getByRole('button', { name: 'Remove Codex' })
    fireEvent.keyDown(fresh, { key: 'Enter' })
    fireEvent.click(fresh)
    expect(undo).toHaveBeenCalledTimes(2)
  })

  it('stays a plain label with nothing to undo', () => {
    render(
      <ProviderRow provider={codex} status="OpenAI" primary={{ label: 'Added', done: true }} />,
    )
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('Added')).toBeTruthy()
  })
})
