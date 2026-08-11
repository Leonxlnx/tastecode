// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Markdown } from './Markdown.js'

afterEach(cleanup)

describe('Markdown inline references', () => {
  it('renders file references with file-type icons instead of code pills', () => {
    const { container } = render(
      <Markdown text={'Updated `Sidebar.tsx`, `app.css`, and ran `pnpm typecheck`.'} />,
    )

    const component = screen.getByText('Sidebar.tsx')
    const stylesheet = screen.getByText('app.css')
    const command = screen.getByText('pnpm typecheck')

    expect(component.tagName).toBe('SPAN')
    expect(component.className).toBe('md-file-ref')
    expect(component.classList.contains('md-file-ref')).toBe(true)
    expect(component.querySelector('[data-file-icon="react"] .lucide-atom')).toBeTruthy()
    expect(stylesheet.classList.contains('md-file-ref')).toBe(true)
    expect(stylesheet.querySelector('[data-file-icon="style"] .lucide-hash')).toBeTruthy()
    expect(command.classList.contains('md-file-ref')).toBe(false)
    expect(container.querySelectorAll('.md-file-ref')).toHaveLength(2)
  })

  it('chooses icons from the file extension', () => {
    const { container } = render(
      <Markdown
        text={
          '`types.ts` `script.js` `index.html` `data.json` `README.md` `schema.sql` `run.sh` `main.rs` `logo.png`'
        }
      />,
    )

    for (const kind of [
      'typescript',
      'javascript',
      'markup',
      'data',
      'markdown',
      'database',
      'shell',
      'rust',
      'image',
    ]) {
      expect(container.querySelector(`[data-file-icon="${kind}"]`)).toBeTruthy()
    }
  })

  it('keeps linked local files out of the external-link warning flow', () => {
    render(
      <Markdown
        text={
          'Updated [Sidebar.tsx](/Users/blueemi/Developer/harness/apps/web/src/ui/Sidebar.tsx:119).'
        }
      />,
    )

    const reference = screen.getByText('Sidebar.tsx')
    fireEvent.click(reference)

    expect(reference.closest('.md-file-link')).toBeTruthy()
    expect(reference.closest('a')).toBeNull()
    expect(reference.closest('.md-file-link')?.querySelector('.lucide-atom')).toBeTruthy()
    expect(screen.queryByText('Open external link?')).toBeNull()
  })
})

describe('Markdown streaming motion', () => {
  it('keeps live text on the lightweight streaming surface', () => {
    const { container } = render(<Markdown text="A smoother streamed reply" streaming />)

    const liveText = container.querySelector('[data-streaming-markdown]')
    expect(liveText?.textContent).toBe('A smoother streamed reply')
    expect(liveText?.getAttribute('aria-busy')).toBe('true')
  })

  it('replaces the live source with full Markdown at completion', () => {
    const rendered = render(<Markdown text="**Finished reply**" streaming />)

    expect(rendered.container.querySelector('strong')).toBeNull()
    expect(rendered.container.textContent).toBe('**Finished reply**')

    rendered.rerender(<Markdown text="**Finished reply**" />)
    expect(screen.getByText('Finished reply').closest('[data-streamdown="strong"]')).toBeTruthy()
    expect(rendered.container.querySelector('[data-streaming-markdown]')).toBeNull()
  })
})
