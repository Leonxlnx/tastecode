// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { SettingsPage, SettingsRow, SettingsSection } from './SettingsLayout.js'

afterEach(cleanup)

describe('settings layout primitives', () => {
  it('names a page and its sections by their headings', () => {
    render(
      <SettingsPage
        title="Data & privacy"
        description="What stays on this machine."
        actions={<button type="button">Refresh</button>}
      >
        <SettingsSection title="Diagnostics" note="Nothing is uploaded.">
          <SettingsRow name="Local diagnostics">On</SettingsRow>
        </SettingsSection>
      </SettingsPage>,
    )

    const page = screen.getByRole('region', { name: 'Data & privacy' })
    expect(within(page).getByRole('heading', { level: 1 }).textContent).toBe('Data & privacy')
    expect(within(page).getByText('What stays on this machine.')).toBeTruthy()
    expect(within(page).getByRole('button', { name: 'Refresh' })).toBeTruthy()
    const section = within(page).getByRole('region', { name: 'Diagnostics' })
    expect(within(section).getByRole('heading', { level: 2 }).textContent).toBe('Diagnostics')
    expect(within(section).getByText('Nothing is uploaded.')).toBeTruthy()
  })

  it('lays a row out as name, leader and value, with the note after them', () => {
    const { container } = render(
      <SettingsRow name="Updates" note="Checks GitHub." tone="error">
        <button type="button">Check for updates</button>
      </SettingsRow>,
    )

    const row = container.querySelector('.set-row')!
    expect(row.getAttribute('data-tone')).toBe('error')
    expect([...row.children].map((child) => child.className)).toEqual([
      'set-row__name',
      'set-leader',
      'set-row__value',
      'set-row__note',
    ])
    expect(row.querySelector('.set-leader')?.getAttribute('aria-hidden')).toBe('true')
    expect(
      within(row as HTMLElement).getByRole('button', { name: 'Check for updates' }),
    ).toBeTruthy()
  })
})
