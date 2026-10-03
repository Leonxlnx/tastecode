// @vitest-environment happy-dom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ProviderMark } from '../model-catalog.js'
import { ProviderIcon } from './ProviderIcon.js'

const MARKS: ProviderMark[] = ['openai', 'anthropic', 'grok']

describe('ProviderIcon', () => {
  it.each(MARKS)('renders %s as its own vector artwork', (mark) => {
    const { container } = render(<ProviderIcon mark={mark} />)
    const { container: fallback } = render(<ProviderIcon mark={'unknown' as ProviderMark} />)
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('text')).toBeNull()
    expect(container.querySelector('path')?.getAttribute('d')).not.toBe(
      fallback.querySelector('path')?.getAttribute('d'),
    )
  })

  it('draws a generic glyph for a mark this build does not ship', () => {
    const { container } = render(<ProviderIcon mark={'unknown' as ProviderMark} />)
    expect(container.querySelector('path')).not.toBeNull()
  })
})
