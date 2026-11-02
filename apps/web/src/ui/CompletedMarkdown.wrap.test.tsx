// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeCodeWrap } from '../code-wrap.js'
import { CompletedMarkdown } from './CompletedMarkdown.js'

const { writeClipboardText } = vi.hoisted(() => ({
  writeClipboardText: vi.fn(async (_text: string): Promise<void> => undefined),
}))

vi.mock('../bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge.js')>()),
  writeClipboardText,
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  writeClipboardText.mockReset()
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
    expect(actionTitles(blocks[0]!)).toEqual(['Wrap lines', 'Download file', 'Copy code'])
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

  it('copies the fenced code through the app clipboard, with its language label', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const browserCopy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    const view = render(<CompletedMarkdown text={`\`\`\`ts startLine=4\n${LONG_LINE}\n\`\`\``} />)
    expect(view.container.querySelector("[data-streamdown='code-block-header']")?.textContent).toBe(
      'ts',
    )
    const copy = screen.getByRole('button', { name: 'Copy code' })
    expect(copy.getAttribute('title')).toBe('Copy code')

    await act(async () => {
      fireEvent.click(copy)
    })

    // The raw fence text, as Streamdown's own button copied it.
    expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith(`${LONG_LINE}\n`)
    expect(browserCopy).not.toHaveBeenCalled()
    expect(copy.getAttribute('aria-label')).toBe('Copied')
    expect(copy.getAttribute('title')).toBe('Copied')
    act(() => vi.advanceTimersByTime(1600))
    expect(copy.getAttribute('aria-label')).toBe('Copy code')
    expect(copy.getAttribute('title')).toBe('Copy code')
  })

  it('says when a code block could not be copied', async () => {
    writeClipboardText.mockRejectedValueOnce(new Error('clipboard unavailable'))
    render(<CompletedMarkdown text={`\`\`\`ts\n${LONG_LINE}\n\`\`\``} />)
    const copy = screen.getByRole('button', { name: 'Copy code' })

    await act(async () => {
      fireEvent.click(copy)
    })

    expect(copy.getAttribute('title')).toBe('Copy failed — click to retry')
    expect(screen.getByRole('alert').textContent).toBe('Copy failed')
  })

  it('names the download button', () => {
    render(<CompletedMarkdown text={`\`\`\`ts\n${LONG_LINE}\n\`\`\``} />)
    expect(screen.getByRole('button', { name: 'Download file' }).dataset.streamdown).toBe(
      'code-block-download-button',
    )
  })

  it('offers the toggle and the app copy on large code blocks too', async () => {
    const code = Array.from({ length: 400 }, (_, index) => `${LONG_LINE} // ${index}`).join('\n')
    const view = render(<CompletedMarkdown text={`\`\`\`ts\n${code}\n\`\`\``} />)
    expect(view.container.querySelector('.md-code-chunk')).toBeTruthy()
    const block = view.container.querySelector("[data-streamdown='code-block']")!
    expect(actionTitles(block)).toEqual(['Wrap lines', 'Download file', 'Copy code'])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    })

    expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith(`${code}\n`)
  })
})
