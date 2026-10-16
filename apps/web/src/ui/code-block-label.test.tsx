// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CompletedMarkdown } from './CompletedMarkdown.js'
import { Markdown } from './Markdown.js'

/** happy-dom's emulated device: a live reply paces its text only when motion is allowed. */
const device = (
  window as unknown as { happyDOM: { settings: { device: { prefersReducedMotion: string } } } }
).happyDOM.settings.device

beforeEach(() => {
  device.prefersReducedMotion = 'reduce'
})

afterEach(() => {
  cleanup()
  device.prefersReducedMotion = 'no-preference'
})

const HEADER = "[data-streamdown='code-block-header']"

// markdown.css labels these headers 'text' through ::before on exactly the
// empty element each renderer leaves; happy-dom does not compute pseudo
// content, so this pins the structure those two selectors target.
describe('code block language label', () => {
  it('leaves an empty label span for a completed fence without a language', () => {
    const view = render(
      <CompletedMarkdown text={'Expected output:\n\n```\nTotal cups:    1156\n```'} />,
    )
    const header = view.container.querySelector(HEADER)!
    // Real browsers match :empty only without child nodes; happy-dom's :empty
    // is looser, so count them.
    expect(header.querySelector(':scope > span')?.childNodes).toHaveLength(0)
  })

  it('keeps the language as the label when the fence has one', () => {
    const view = render(<CompletedMarkdown text={'```ts\nconst a = 1\n```'} />)
    const header = view.container.querySelector(HEADER)!
    expect(header.querySelector(':scope > span')?.textContent).toBe('ts')
  })

  it('leaves the live header empty for a streaming fence without a language', () => {
    const view = render(
      <Markdown text={'Expected output:\n\n```\nTotal cups:    1156'} streaming />,
    )
    const header = view.container.querySelector(HEADER)!
    expect(header.childNodes).toHaveLength(0)
  })

  it('names the language in the live header when the fence has one', () => {
    const view = render(<Markdown text={'```ts\nconst a = 1'} streaming />)
    expect(view.container.querySelector(HEADER)?.textContent).toBe('ts')
  })
})
