// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeCodeWrap } from '../code-wrap.js'
import { CompletedMarkdown } from './CompletedMarkdown.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  writeCodeWrap(false)
  localStorage.clear()
})

const LONG_LINE =
  "const rates = await carrier.rates({ origin: WAREHOUSE_ADDRESS, destination: address, parcels, services: ['ground', 'express'] })"

function actionTitles(block: Element): string[] {
  return [...block.querySelectorAll("[data-streamdown='code-block-actions'] button")].map(
    (button) => button.getAttribute('title') ?? '',
  )
}

describe('code block wrap toggle', () => {
  it('sits beside download and copy and wraps every block without rendering one again', () => {
    const view = render(
      <CompletedMarkdown
        text={`Quote:\n\n\`\`\`ts\n${LONG_LINE}\n\`\`\`\n\nRun:\n\n\`\`\`bash\npnpm vitest run src/lib/shipping.test.ts\n\`\`\``}
      />,
    )
    const blocks = [...view.container.querySelectorAll("[data-streamdown='code-block']")]
    expect(blocks).toHaveLength(2)
    expect(actionTitles(blocks[0]!)).toEqual(['Wrap lines', 'Download file', 'Copy Code'])
    const toggles = screen.getAllByRole('button', { name: 'Wrap lines' })
    expect(toggles.map((toggle) => toggle.getAttribute('aria-pressed'))).toEqual(['false', 'false'])
    const code = blocks[0]!.querySelector('pre')

    fireEvent.click(toggles[0]!)

    expect(document.documentElement.dataset.codeWrap).toBe('on')
    expect(localStorage.getItem('harness.codeWrap')).toBe('on')
    expect(toggles.map((toggle) => toggle.getAttribute('aria-pressed'))).toEqual(['true', 'true'])
    // Wrapping is CSS on the root: the highlighted block is the same node.
    expect(blocks[0]!.querySelector('pre')).toBe(code)
    expect(blocks[0]!.textContent).toContain(LONG_LINE)

    fireEvent.click(toggles[1]!)
    expect(document.documentElement.dataset.codeWrap).toBeUndefined()
    expect(toggles.map((toggle) => toggle.getAttribute('aria-pressed'))).toEqual(['false', 'false'])
  })

  it('opens already wrapped when the choice was made earlier', () => {
    writeCodeWrap(true)
    render(<CompletedMarkdown text={`\`\`\`ts\n${LONG_LINE}\n\`\`\``} />)
    expect(screen.getByRole('button', { name: 'Wrap lines' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
  })

  it('keeps copying the fenced code, with its language label', () => {
    const copied = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    const view = render(<CompletedMarkdown text={`\`\`\`ts startLine=4\n${LONG_LINE}\n\`\`\``} />)
    expect(view.container.querySelector("[data-streamdown='code-block-header']")?.textContent).toBe(
      'ts',
    )
    fireEvent.click(screen.getByTitle('Copy Code'))
    expect(copied).toHaveBeenCalledOnce()
    expect(copied.mock.calls[0]![0].trimEnd()).toBe(LONG_LINE)
  })

  it('offers the toggle on large code blocks too', () => {
    const code = Array.from({ length: 400 }, (_, index) => `${LONG_LINE} // ${index}`).join('\n')
    const view = render(<CompletedMarkdown text={`\`\`\`ts\n${code}\n\`\`\``} />)
    expect(view.container.querySelector('.md-code-chunk')).toBeTruthy()
    const block = view.container.querySelector("[data-streamdown='code-block']")!
    expect(actionTitles(block)).toEqual(['Wrap lines', 'Download file', 'Copy Code'])
  })
})
