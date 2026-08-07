// @vitest-environment happy-dom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ProviderMark } from '../model-catalog.js'
import { ProviderIcon } from './ProviderIcon.js'

const MARKS: ProviderMark[] = [
  'openai',
  'anthropic',
  'grok',
  'cursor',
  'opencode',
  'openrouter',
  'kimi',
  'gemini',
  'qwen',
  'zai',
  'antigravity',
  'pi',
  'acp',
  'custom',
]

/** Marks with real brand artwork must not fall through to the generic glyph. */
const BRANDED: ProviderMark[] = ['grok', 'antigravity', 'pi']

describe('ProviderIcon', () => {
  it.each(MARKS)('renders %s as vector artwork', (mark) => {
    const { container } = render(<ProviderIcon mark={mark} />)
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('path')).not.toBeNull()
    expect(container.querySelector('text')).toBeNull()
  })

  it.each(BRANDED)('gives %s its own mark, not the fallback', (mark) => {
    const { container } = render(<ProviderIcon mark={mark} />)
    const { container: fallback } = render(<ProviderIcon mark="custom" />)
    expect(container.querySelector('path')?.getAttribute('d')).not.toBe(
      fallback.querySelector('path')?.getAttribute('d'),
    )
  })
})
