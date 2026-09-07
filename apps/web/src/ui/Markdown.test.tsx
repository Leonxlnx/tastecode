// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { revealProjectFile } from '../bridge.js'
import { preserveProjectFileLinks } from '../project-file-link.js'
import { CompletedMarkdown } from './CompletedMarkdown.js'
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

describe('Markdown plain fast path', () => {
  it.each([
    'Issue #123 keeps user_profile_1 unchanged.',
    'Open C:\\workspace\\project and inspect [ready].',
    'Compare x < y and y > z.',
  ])('matches the full renderer for %s', (text) => {
    const full = render(<CompletedMarkdown text={text} />)
    const fast = render(<Markdown text={text} />)
    const paragraphs = (container: HTMLElement) =>
      [...container.querySelectorAll('p')].map((paragraph) => paragraph.textContent)

    expect(paragraphs(fast.container)).toEqual(paragraphs(full.container))
    expect(fast.container.textContent).toBe(full.container.textContent)
    expect(full.container.querySelector('a, code, em, strong, blockquote, table')).toBeNull()
    expect(fast.container.querySelector('a, code, em, strong, blockquote, table')).toBeNull()
  })
})

describe('Markdown inline references', () => {
  it('renders file references with file-type icons instead of code pills', async () => {
    const { container } = render(
      <Markdown text={'Updated `Sidebar.tsx`, `app.css`, and ran `pnpm typecheck`.'} />,
    )

    const component = await screen.findByText('Sidebar.tsx')
    const stylesheet = screen.getByText('app.css')
    const command = screen.getByText('pnpm typecheck')

    expect(component.tagName).toBe('SPAN')
    expect(component.className).toBe('md-file-ref')
    expect(component.classList.contains('md-file-ref')).toBe(true)
    expect(
      component.querySelector('[data-file-icon="react"] .tabler-icon-brand-react'),
    ).toBeTruthy()
    expect(stylesheet.classList.contains('md-file-ref')).toBe(true)
    expect(
      stylesheet.querySelector('[data-file-icon="style"] .tabler-icon-brand-css3'),
    ).toBeTruthy()
    expect(command.classList.contains('md-file-ref')).toBe(false)
    expect(container.querySelectorAll('.md-file-ref')).toHaveLength(2)
  })

  it('chooses icons from the file extension', async () => {
    const { container } = render(
      <Markdown
        text={
          '`types.ts` `script.js` `index.html` `data.json` `README.md` `schema.sql` `run.sh` `main.rs` `logo.png`'
        }
      />,
    )

    await waitFor(() =>
      expect(container.querySelector('[data-file-icon="typescript"]')).toBeTruthy(),
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
    expect(screen.getByText('README.md').querySelector('.tabler-icon-markdown')).toBeTruthy()
  })

  it('keeps linked local files out of the external-link warning flow', async () => {
    render(
      <Markdown
        text={
          'Updated [Sidebar.tsx](/Users/blueemi/Developer/harness/apps/web/src/ui/Sidebar.tsx:119).'
        }
        projectPath="/Users/blueemi/Developer/harness"
      />,
    )

    const reference = await screen.findByText('Sidebar.tsx')
    fireEvent.click(reference)

    expect(reference.closest('.md-file-link')).toBeTruthy()
    expect(reference.closest('a')).toBeNull()
    expect(
      reference.closest('.md-file-link')?.querySelector('.tabler-icon-brand-react'),
    ).toBeTruthy()
    expect(screen.queryByText('Open external link?')).toBeNull()
  })

  it('preserves a cross-drive Windows file URL for project-aware rendering', async () => {
    const { container } = render(
      <Markdown
        text={'Updated [index.html](file:///E:/randomtesting/A_personalharness/site/index.html).'}
        projectPath="E:\randomtesting\A_personalharness\site"
      />,
    )

    expect(container.textContent).not.toContain('[blocked]')
    const action = await screen.findByRole('button', { name: 'index.html' })
    expect(action.getAttribute('title')).toContain(
      'E:\\randomtesting\\A_personalharness\\site\\index.html',
    )
    fireEvent.click(action)
    expect(revealProjectFile).toHaveBeenCalledWith(
      'E:\\randomtesting\\A_personalharness\\site\\index.html',
      'E:\\randomtesting\\A_personalharness\\site',
    )
  })

  it('keeps preserved files with unknown extensions inside the project action flow', async () => {
    render(
      <Markdown
        text={'Saved [artifact.log](file:///E:/randomtesting/A_personalharness/site/artifact.log).'}
        projectPath="E:\randomtesting\A_personalharness\site"
      />,
    )

    const action = await screen.findByRole('button', { name: 'artifact.log' })
    fireEvent.click(action)
    expect(revealProjectFile).toHaveBeenCalledWith(
      'E:\\randomtesting\\A_personalharness\\site\\artifact.log',
      'E:\\randomtesting\\A_personalharness\\site',
    )
  })

  it('shows a retryable error when the native reveal request fails', async () => {
    vi.mocked(revealProjectFile).mockRejectedValueOnce(new Error('reveal failed'))
    render(
      <Markdown
        text={'Saved [artifact.bin](file:///E:/randomtesting/A_personalharness/site/artifact.bin).'}
        projectPath="E:\randomtesting\A_personalharness\site"
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'artifact.bin' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not show file')
    expect(screen.getByRole('button', { name: /artifact.bin/i }).getAttribute('title')).toContain(
      'Try showing',
    )
  })

  it('explains why a local file link outside the project is unavailable', async () => {
    const { container } = render(
      <Markdown
        text={'See [secret.txt](file:///E:/randomtesting/A_personalharness/secret.txt).'}
        projectPath="E:\randomtesting\A_personalharness\site"
      />,
    )

    expect(container.textContent).not.toContain('[blocked]')
    expect(await screen.findByText('This file is outside the selected project')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'secret.txt' })).toBeNull()
  })

  it('explains why network file links are unavailable', async () => {
    render(
      <Markdown
        text={'See [secret.txt](file://server/share/secret.txt).'}
        projectPath="E:\randomtesting\A_personalharness\site"
      />,
    )

    expect(await screen.findByText('Network file links are not allowed')).toBeTruthy()
  })
})

describe('Markdown streaming motion', () => {
  it('defers full project-file parsing until the streamed message completes', async () => {
    const preserve = vi.mocked(preserveProjectFileLinks)
    preserve.mockClear()
    const text = 'Updated [index.html](file:///E:/project/index.html).'
    const { rerender } = render(<Markdown text={text} streaming projectPath="E:\project" />)

    expect(preserve).not.toHaveBeenCalled()
    rerender(<Markdown text={text} projectPath="E:\project" />)
    await waitFor(() => expect(preserve).toHaveBeenCalledOnce())
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

  it('keeps rich structure in a large non-animated provider burst', () => {
    const paragraph = 'x'.repeat(8 * 1024)
    const text = `## Large answer\n\n${paragraph} **done**\n\n\`\`\`ts\nconst value = 1\n\`\`\``
    const rendered = render(<Markdown text={text} streaming />)

    expect(rendered.container.querySelector('h2')?.textContent).toBe('Large answer')
    expect(rendered.container.querySelector('p')?.textContent?.trim()).toBe(`${paragraph} done`)
    expect(rendered.container.querySelector('strong')?.textContent).toBe('done')
    expect(rendered.container.querySelector('pre')?.textContent).toContain('const value = 1')
    expect(rendered.container.querySelector('[style*="animation"]')).toBeNull()
  })

  it('folds finished streaming motion back into one text node', () => {
    let text = 'start'
    const rendered = render(<Markdown text={text} streaming />)

    for (let version = 1; version <= 50; version += 1) {
      text += 'x'
      rendered.rerender(
        <Markdown
          text={text}
          streaming
          liveUpdate={{ kind: 'append', text: 'x' }}
          updateVersion={version}
        />,
      )
      const addition = rendered.container.querySelector<HTMLElement>('[style*="animation"]')
      expect(addition).toBeTruthy()
      fireEvent.animationEnd(addition!)
    }

    const leaf = rendered.container.querySelector('[data-live-markdown-leaf]')
    expect(leaf?.textContent).toBe(text)
    expect(leaf?.childNodes).toHaveLength(1)
    expect(rendered.container.querySelector('[style*="animation"]')).toBeNull()
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

  it('skips temporary animation nodes for a very large provider burst', () => {
    const rendered = render(<Markdown text="start" streaming />)
    const addition = 'x'.repeat(4 * 1024 + 1)

    rendered.rerender(
      <Markdown
        text={`start${addition}`}
        streaming
        liveUpdate={{ kind: 'append', text: addition }}
        updateVersion={1}
      />,
    )

    expect(rendered.container.querySelector('[style*="animation"]')).toBeNull()
    expect(rendered.container.textContent).toBe(`start${addition}`)
  })

  it('compacts sealed leaves on one long streamed code line', () => {
    const source = `\`\`\`ts\n${'x'.repeat(300)}`
    const { container } = render(<Markdown text={source} streaming />)
    const leaves = [...container.querySelectorAll('pre code > [data-live-markdown-leaf]')]

    expect(leaves).toHaveLength(1)
    expect(leaves.every((leaf) => (leaf as HTMLElement).style.display === 'inline')).toBe(true)
    expect(leaves.every((leaf) => (leaf as HTMLElement).style.minHeight === '0')).toBe(true)
    expect(container.querySelector('pre')?.textContent).toBe('x'.repeat(300))
  })
})
