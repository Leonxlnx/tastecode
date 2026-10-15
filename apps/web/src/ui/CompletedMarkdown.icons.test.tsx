// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STREAMDOWN_ICONS } from './streamdown-icons.js'
import { CompletedMarkdown } from './CompletedMarkdown.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('inline code file references', () => {
  it('renders prototype property names as text rather than inherited icon kinds', () => {
    const names = [
      'constructor',
      '__proto__',
      'Foo.constructor',
      'toString',
      'x.hasOwnProperty',
      'valueOf.js',
    ]
    const view = render(<CompletedMarkdown text={names.map((name) => `\`${name}\``).join(' ')} />)

    for (const name of names) expect(view.getByText(name)).toBeTruthy()
    expect(view.container.querySelectorAll('.md-file-ref')).toHaveLength(1)
    expect(view.container.querySelector('[data-file-icon="javascript"]')).toBeTruthy()
  })

  it('keeps commands and member access that end in an extension as code', () => {
    const view = render(
      <CompletedMarkdown
        text={
          '`cat package.json` `process.env` `import.meta.env` `.env` `config/app.env` `package.json`'
        }
      />,
    )

    expect(
      [...view.container.querySelectorAll('.md-file-ref')].map((node) => node.textContent),
    ).toEqual(['.env', 'config/app.env', 'package.json'])
  })
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
