// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CountBadge, SettingsMeta, StateLabel } from './SettingsStatus.js'

afterEach(cleanup)

describe('settings status grammar', () => {
  it.each([
    ['checking', 'Checking'],
    ['ready', 'Ready'],
    ['setup-needed', 'Setup needed'],
    ['unavailable', 'Unavailable'],
    ['failed', 'Failed'],
  ] as const)('renders the canonical %s state', (state, label) => {
    const { container } = render(<StateLabel state={state} />)
    const status = container.querySelector('.state-label')
    expect(status?.textContent).toBe(label)
    expect(status?.classList.contains(`is-${state}`)).toBe(true)
  })

  it('keeps detail after the state and announces only live changes', () => {
    const { container, rerender } = render(
      <StateLabel state="checking" detail="Scan started" live />,
    )
    expect(screen.getByRole('status').textContent).toBe('Checking · Scan started')

    rerender(<StateLabel state="ready" detail="Up to date" />)
    expect(container.querySelector('.state-label')?.getAttribute('role')).toBeNull()
  })

  it('separates numeric counts and plain metadata from semantic states', () => {
    const { container } = render(
      <>
        <CountBadge value="2/4" label="2 of 4 models visible" />
        <SettingsMeta>Browser · pre-release</SettingsMeta>
      </>,
    )
    expect(screen.getByLabelText('2 of 4 models visible').textContent).toBe('2/4')
    expect(container.querySelector('.count-badge')).toBeTruthy()
    expect(container.querySelector('.settings-meta')?.textContent).toBe('Browser · pre-release')
    expect(container.querySelector('.state-label')).toBeNull()
  })
})
