// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { revealProjectFile } from '../bridge.js'
import { preserveProjectFileLinks } from '../project-file-link.js'
import { Markdown } from './Markdown.js'

vi.mock('../bridge.js', () => ({
  canRevealProjectFile: true,
  revealProjectFile: vi.fn(() => Promise.resolve()),
}))

vi.mock('../project-file-link.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../project-file-link.js')>()
  return { ...actual, preserveProjectFileLinks: vi.fn(actual.preserveProjectFileLinks) }
})

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
        projectPath="/Users/blueemi/Developer/harness"
      />,
    )

    const reference = screen.getByText('Sidebar.tsx')
    fireEvent.click(reference)

    expect(reference.closest('.md-file-link')).toBeTruthy()
    expect(reference.closest('a')).toBeNull()
    expect(reference.closest('.md-file-link')?.querySelector('.lucide-atom')).toBeTruthy()
    expect(screen.queryByText('Open external link?')).toBeNull()
  })

  it('preserves a cross-drive Windows file URL for project-aware rendering', () => {
    const { container } = render(
      <Markdown
        text={'Updated [index.html](file:///E:/randomtesting/A_personalharness/site/index.html).'}
        projectPath="E:\randomtesting\A_personalharness\site"
      />,
    )

    expect(container.textContent).not.toContain('[blocked]')
    const action = screen.getByRole('button', { name: 'index.html' })
    expect(action.getAttribute('title')).toContain(
      'E:\\randomtesting\\A_personalharness\\site\\index.html',
    )
    fireEvent.click(action)
    expect(revealProjectFile).toHaveBeenCalledWith(
      'E:\\randomtesting\\A_personalharness\\site\\index.html',
      'E:\\randomtesting\\A_personalharness\\site',
    )
  })

  it('keeps preserved files with unknown extensions inside the project action flow', () => {
    render(
      <Markdown
        text={'Saved [artifact.log](file:///E:/randomtesting/A_personalharness/site/artifact.log).'}
        projectPath="E:\randomtesting\A_personalharness\site"
      />,
    )

    const action = screen.getByRole('button', { name: 'artifact.log' })
    fireEvent.click(action)
    expect(revealProjectFile).toHaveBeenCalledWith(
      'E:\\randomtesting\\A_personalharness\\site\\artifact.log',
      'E:\\randomtesting\\A_personalharness\\site',
    )
  })

  it('explains why a local file link outside the project is unavailable', () => {
    const { container } = render(
      <Markdown
        text={'See [secret.txt](file:///E:/randomtesting/A_personalharness/secret.txt).'}
        projectPath="E:\randomtesting\A_personalharness\site"
      />,
    )

    expect(container.textContent).not.toContain('[blocked]')
    expect(screen.getByText('This file is outside the selected project')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'secret.txt' })).toBeNull()
  })

  it('explains why network file links are unavailable', () => {
    render(
      <Markdown
        text={'See [secret.txt](file://server/share/secret.txt).'}
        projectPath="E:\randomtesting\A_personalharness\site"
      />,
    )

    expect(screen.getByText('Network file links are not allowed')).toBeTruthy()
  })
})

describe('Markdown streaming motion', () => {
  it('defers full project-file parsing until the streamed message completes', () => {
    const preserve = vi.mocked(preserveProjectFileLinks)
    preserve.mockClear()
    const text = 'Updated [index.html](file:///E:/project/index.html).'
    const { rerender } = render(<Markdown text={text} streaming projectPath="E:\project" />)

    expect(preserve).not.toHaveBeenCalled()
    rerender(<Markdown text={text} projectPath="E:\project" />)
    expect(preserve).toHaveBeenCalledOnce()
  })

  it('marks newly streamed words for a zero-stagger reveal', () => {
    const { container } = render(<Markdown text="A smoother streamed reply" streaming />)

    expect(container.querySelectorAll('[data-sd-animate]').length).toBeGreaterThan(0)
  })
})
