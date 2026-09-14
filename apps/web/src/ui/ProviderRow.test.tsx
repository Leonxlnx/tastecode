// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
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
      'provider-row__status',
      'provider-row__secondary',
      'provider-row__primary',
    ])
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
        secondary={{ label: 'Sign out', danger: true }}
      />,
    )
    const signOut = screen.getByRole('button', { name: 'Sign out' })
    expect(signOut.className).toContain('is-secondary')
    expect(signOut.className).toContain('is-danger')
    expect(signOut.className).not.toContain('is-quiet')
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
})
