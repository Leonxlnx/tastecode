// @vitest-environment happy-dom
import { cleanup, fireEvent, render as renderView, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import {
  defaultMarkdownServices,
  Markdown,
  MarkdownServicesProvider,
  type MarkdownServices,
} from './Markdown.js'

const revealProjectFile = vi.fn(async (_path: string, _projectPath: string) => undefined)
const preserveProjectFileLinks = vi.fn(defaultMarkdownServices.preserveProjectFileLinks)
const markdownServices: MarkdownServices = {
  ...defaultMarkdownServices,
  canRevealProjectFile: true,
  revealProjectFile,
  preserveProjectFileLinks,
}

function Services({ children }: { children: ReactNode }) {
  return <MarkdownServicesProvider services={markdownServices}>{children}</MarkdownServicesProvider>
}

function render(view: ReactElement) {
  return renderView(view, { wrapper: Services })
}

afterEach(() => {
  cleanup()
  revealProjectFile.mockReset()
  revealProjectFile.mockResolvedValue(undefined)
  preserveProjectFileLinks.mockClear()
})

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
    expect(screen.getByText('README.md').querySelector('.lucide-file-text')).toBeTruthy()
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

  it('shows a retryable error when the native reveal request fails', async () => {
    revealProjectFile.mockRejectedValueOnce(new Error('reveal failed'))
    render(
      <Markdown
        text={'Saved [artifact.bin](file:///E:/randomtesting/A_personalharness/site/artifact.bin).'}
        projectPath="E:\randomtesting\A_personalharness\site"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'artifact.bin' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not show file')
    expect(screen.getByRole('button', { name: /artifact.bin/i }).getAttribute('title')).toContain(
      'Try showing',
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
    preserveProjectFileLinks.mockClear()
    const text = 'Updated [index.html](file:///E:/project/index.html).'
    const { rerender } = render(<Markdown text={text} streaming projectPath="E:\project" />)

    expect(preserveProjectFileLinks).not.toHaveBeenCalled()
    rerender(<Markdown text={text} projectPath="E:\project" />)
    expect(preserveProjectFileLinks).toHaveBeenCalledOnce()
  })

  it('keeps a local destination readable and inert while streaming', () => {
    const text = 'Updated [index.html](file:///E:/project/index.html).'
    const rendered = render(<Markdown text={text} streaming projectPath="E:\project" />)

    expect(rendered.container.textContent).toContain('index.html')
    expect(rendered.container.textContent).not.toContain('[blocked]')
    expect(rendered.container.querySelector('a, button')).toBeNull()
  })

  it('keeps common Markdown styled while appending safely', () => {
    const rendered = render(<Markdown text={'## Title\n\n- one\n\n```ts\nconst a ='} streaming />)
    const heading = rendered.container.querySelector('h2')
    rendered.rerender(
      <Markdown
        text={'## Title\n\n- one\n\n```ts\nconst a = 1'}
        streaming
        liveUpdate={{ kind: 'append', text: ' 1' }}
        updateVersion={1}
      />,
    )

    expect(rendered.container.querySelector('h2')).toBe(heading)
    expect(heading?.textContent).toBe('Title')
    expect(rendered.container.querySelector('li')?.textContent).toBe('one')
    expect(rendered.container.querySelector('pre')?.textContent).toContain('const a = 1')
    expect(rendered.container.querySelector('[data-live-markdown-leaf]')).toBeTruthy()
    expect(rendered.container.querySelector('[style*="animation"]')).toBeTruthy()
  })

  it('does not replay streaming motion for an initial or reset document', () => {
    const text = 'x'.repeat(4_096)
    const rendered = render(<Markdown text={text} streaming />)

    expect(rendered.container.querySelector('[style*="animation"]')).toBeNull()
    rendered.rerender(
      <Markdown
        text="replacement"
        streaming
        liveUpdate={{ kind: 'reset', text: 'replacement' }}
        updateVersion={1}
      />,
    )
    expect(rendered.container.querySelector('[style*="animation"]')).toBeNull()
  })

  it('keeps sealed leaves on one long streamed code line', () => {
    const source = `\`\`\`ts\n${'x'.repeat(300)}`
    const { container } = render(<Markdown text={source} streaming />)
    const leaves = [
      ...container.querySelectorAll<HTMLElement>('pre code > [data-live-markdown-leaf]'),
    ]

    expect(leaves).toHaveLength(2)
    expect(leaves.every((leaf) => leaf.style.display === 'inline')).toBe(true)
    expect(leaves.every((leaf) => leaf.style.minHeight === '0')).toBe(true)
    expect(container.querySelector('pre')?.textContent).toBe('x'.repeat(300))
  })
})
