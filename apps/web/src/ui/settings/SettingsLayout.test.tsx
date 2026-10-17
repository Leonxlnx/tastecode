// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import {
  SettingsEmpty,
  SettingsNotice,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from './SettingsLayout.js'

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

  it('names an untitled section by its label and puts its action on the heading line', () => {
    render(
      <>
        <SettingsSection label="Shared appearance controls">
          <SettingsRow name="Font smoothing">On</SettingsRow>
        </SettingsSection>
        <SettingsSection
          title="Dark mode"
          label="ignored while a heading names the section"
          action={<button type="button">Reset colors</button>}
        >
          <SettingsRow name="Accent">Rose</SettingsRow>
        </SettingsSection>
      </>,
    )

    expect(screen.getByRole('region', { name: 'Shared appearance controls' })).toBeTruthy()
    const dark = screen.getByRole('region', { name: 'Dark mode' })
    expect(dark.getAttribute('aria-label')).toBeNull()
    const head = dark.querySelector('.set-section__head')!
    expect(within(head as HTMLElement).getByRole('button', { name: 'Reset colors' })).toBeTruthy()
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

  it('announces notices by tone and keeps empty states to one plain line', () => {
    render(
      <>
        <SettingsNotice tone="progress">Scanning sessions…</SettingsNotice>
        <SettingsNotice tone="error" action={<button type="button">Try again</button>}>
          Connection to the server was lost.
        </SettingsNotice>
        <SettingsEmpty
          title="No MCP servers yet"
          detail="Add one to use it in every chat."
          action={<button type="button">Add server</button>}
        />
      </>,
    )

    expect(screen.getByRole('status').textContent).toContain('Scanning sessions…')
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Connection to the server was lost.')
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.getByText('No MCP servers yet').className).toBe('set-empty__title')
    expect(screen.getByText('Add one to use it in every chat.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add server' })).toBeTruthy()
  })
})
