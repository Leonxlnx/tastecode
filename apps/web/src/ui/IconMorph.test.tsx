// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { IconCheck as Check, IconCopy as Copy } from '@tabler/icons-react'
import { afterEach, describe, expect, it } from 'vitest'
import { IconMorph } from './IconMorph.js'

afterEach(cleanup)

describe('IconMorph', () => {
  it('keeps glyph nodes mounted while the active layer changes', () => {
    const { container, rerender } = render(
      <IconMorph active={0}>
        <Copy data-testid="copy" />
        <Check data-testid="check" />
      </IconMorph>,
    )
    const copy = container.querySelector('[data-testid="copy"]')
    const check = container.querySelector('[data-testid="check"]')
    const layers = container.querySelectorAll('.icon-morph__layer')

    expect(layers).toHaveLength(2)
    expect(layers[0]?.hasAttribute('data-active')).toBe(true)
    expect(layers[1]?.hasAttribute('data-active')).toBe(false)

    rerender(
      <IconMorph active={1}>
        <Copy data-testid="copy" />
        <Check data-testid="check" />
      </IconMorph>,
    )

    expect(container.querySelector('[data-testid="copy"]')).toBe(copy)
    expect(container.querySelector('[data-testid="check"]')).toBe(check)
    expect(layers[0]?.hasAttribute('data-active')).toBe(false)
    expect(layers[1]?.hasAttribute('data-active')).toBe(true)
  })
})
