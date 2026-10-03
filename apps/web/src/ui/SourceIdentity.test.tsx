// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SourceIdentity } from './SourceIdentity.js'

afterEach(cleanup)

describe('SourceIdentity', () => {
  it('keeps mark, source label, and qualifier in one stable order', () => {
    render(
      <SourceIdentity presentation={{ label: 'Work Codex', mark: 'openai' }} qualifier="Custom" />,
    )

    const identity = screen.getByText('Work Codex').closest('.source-identity')
    expect(identity?.textContent).toBe('Work Codex·Custom')
    expect(identity?.querySelector('svg')).toBeTruthy()
    expect(identity?.getAttribute('title')).toBe('Work Codex · Custom')
  })

  it('uses a fixed compact mark slot without changing the accessible source label', () => {
    render(<SourceIdentity presentation={{ label: 'Grok', mark: 'grok' }} density="compact" />)

    const identity = screen.getByText('Grok').closest('.source-identity')
    expect(identity?.classList.contains('source-identity--compact')).toBe(true)
    expect(identity?.querySelector('svg')?.getAttribute('width')).toBe('11')
  })
})
