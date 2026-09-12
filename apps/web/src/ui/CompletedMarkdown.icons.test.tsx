// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STREAMDOWN_ICONS } from './streamdown-icons.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Streamdown copy icon morph', () => {
  it('keeps both glyphs mounted through each Streamdown feedback replacement', () => {
    const CopyIcon = STREAMDOWN_ICONS.CopyIcon
    const CheckIcon = STREAMDOWN_ICONS.CheckIcon
    const view = render(
      <button type="button">
        <CopyIcon size={14} />
      </button>,
    )
    const activeLayer = () =>
      Array.from(view.container.querySelectorAll('.icon-morph__layer')).findIndex((layer) =>
        layer.hasAttribute('data-active'),
      )

    expect(activeLayer()).toBe(0)
    view.rerender(
      <button type="button">
        <CheckIcon size={14} />
      </button>,
    )
    expect(activeLayer()).toBe(1)
    expect(view.container.querySelectorAll('.icon-morph__layer')).toHaveLength(2)

    view.rerender(
      <button type="button">
        <CopyIcon size={14} />
      </button>,
    )
    expect(activeLayer()).toBe(0)
    expect(view.container.querySelectorAll('.icon-morph__layer')).toHaveLength(2)
  })
})
