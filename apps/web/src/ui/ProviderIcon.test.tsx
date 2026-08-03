// @vitest-environment happy-dom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ProviderMark } from '../model-catalog.js'
import { ProviderIcon } from './ProviderIcon.js'

const MARKS: ProviderMark[] = [
  'openai',
  'anthropic',
  'cursor',
  'opencode',
  'openrouter',
  'kimi',
  'gemini',
  'qwen',
  'zai',
  'acp',
  'custom',
]

describe('ProviderIcon', () => {
  it.each(MARKS)('renders %s as vector artwork', (mark) => {
    const { container } = render(<ProviderIcon mark={mark} />)
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('path')).not.toBeNull()
    expect(container.querySelector('text')).toBeNull()
  })
})
