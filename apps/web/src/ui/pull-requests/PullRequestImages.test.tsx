// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '../../transport.js'
import { CompletedMarkdown } from '../CompletedMarkdown.js'
import { PullRequestImages } from './PullRequestImages.js'

beforeEach(() => vi.stubGlobal('IntersectionObserver', undefined))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const source = 'https://github.com/owner/repo/blob/main/docs/before.png?raw=true'
const dataUrl = 'data:image/png;base64,iVBORw0KGgo='
function fixture(
  text: string,
  request = vi.fn().mockResolvedValue({
    mediaType: 'image/png',
    data: 'iVBORw0KGgo=',
  }),
) {
  const transport = { request } as unknown as Transport
  const content = (body: string) => (
    <PullRequestImages transport={transport} repository="owner/repo" refOid="abc">
      <CompletedMarkdown text={body} />
    </PullRequestImages>
  )
  return { ...render(content(text)), request, content }
}

describe('pull-request Markdown images', () => {
  it.each([
    `![Before](${source})`,
    `<img src="${source}" alt="Before" width="640" />`,
    `| Screenshot |\n| --- |\n| ![Before](${source}) |`,
  ])('resolves Markdown and HTML images without requesting private URLs directly', async (text) => {
    const { request, container } = fixture(text)
    expect(container.querySelector(`img[src="${source}"]`)).toBeNull()
    await waitFor(() => expect(screen.getByAltText('Before').getAttribute('src')).toBe(dataUrl))
    expect(request).toHaveBeenCalledWith('pullRequests.image', { url: source.split('?')[0] })
    expect(container.textContent).not.toContain('Image not available')
  })

  it('loads public attachments without a credential-bearing request', async () => {
    const attachment = 'https://user-images.githubusercontent.com/12345/example.png'
    const { request } = fixture(`![Attachment](${attachment})`)
    await waitFor(() =>
      expect(screen.getByAltText('Attachment').getAttribute('src')).toBe(attachment),
    )
    expect(request).not.toHaveBeenCalled()
    expect(screen.getByAltText('Attachment').getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('falls back to a direct image, then offers retry without a broken image icon', async () => {
    const request = vi.fn().mockRejectedValue(new Error('Unavailable'))
    fixture(`![Before](${source})`, request)
    await waitFor(() => expect(screen.getByAltText('Before').getAttribute('src')).toBe(source))
    fireEvent.error(screen.getByAltText('Before'))
    expect(screen.queryByAltText('Before')).toBeNull()
    expect(screen.getByText('Before: Image unavailable')).toBeTruthy()
    request.mockResolvedValue({ mediaType: 'image/png', data: 'iVBORw0KGgo=' })
    fireEvent.click(screen.getByRole('button', { name: 'Retry image' }))
    await waitFor(() => expect(screen.getByAltText('Before').getAttribute('src')).toBe(dataUrl))
  })

  it('ignores a stale response when the Markdown source changes', async () => {
    let resolve!: (image: { mediaType: string; data: string }) => void
    const request = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          }),
      )
      .mockResolvedValue({ mediaType: 'image/gif', data: 'R0lGODlh' })
    const view = fixture(`![Before](${source})`, request)
    view.rerender(view.content(`![After](${source.replace('before', 'after')})`))
    await waitFor(() =>
      expect(screen.getByAltText('After').getAttribute('src')).toBe(
        'data:image/gif;base64,R0lGODlh',
      ),
    )
    resolve({ mediaType: 'image/png', data: 'iVBORw0KGgo=' })
    await waitFor(() => expect(screen.queryByAltText('Before')).toBeNull())
  })

  it('authenticates private uploaded images', async () => {
    const attachment =
      'https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc'
    const { request } = fixture(`![Uploaded screenshot](${attachment})`)
    await waitFor(() =>
      expect(screen.getByAltText('Uploaded screenshot').getAttribute('src')).toBe(dataUrl),
    )
    expect(request).toHaveBeenCalledWith('pullRequests.image', { url: attachment })
  })

  it('only resolves near-viewport images and disconnects its visibility observer', async () => {
    let intersect!: IntersectionObserverCallback
    const disconnect = vi.fn()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersect = callback
        }
        observe() {}
        disconnect = disconnect
      },
    )
    const { request } = fixture(`![Before](${source})`)
    expect(request).not.toHaveBeenCalled()
    intersect([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver)
    await waitFor(() => expect(screen.getByAltText('Before').getAttribute('src')).toBe(dataUrl))
    expect(disconnect).toHaveBeenCalled()
    expect(screen.getByAltText('Before').getAttribute('decoding')).toBe('async')
    expect(screen.getByAltText('Before').getAttribute('loading')).toBe('lazy')
  })

  it('deduplicates duplicate embeds and does not reload on parent rerenders', async () => {
    const text = `![Before](${source})\n\n![Again](${source})`
    const view = fixture(text)
    await waitFor(() => expect(screen.getByAltText('Again').getAttribute('src')).toBe(dataUrl))
    view.rerender(view.content(text))
    expect(view.request).toHaveBeenCalledTimes(1)
  })

  it('renders SVGs through img only, never as inline markup', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>throw 1</script><rect width="10" height="10"/></svg>'
    const request = vi.fn().mockResolvedValue({ mediaType: 'image/svg+xml', data: btoa(svg) })
    const { container } = fixture(`![Diagram](${source.replace('.png', '.svg')})`, request)
    await waitFor(() =>
      expect(screen.getByAltText('Diagram').getAttribute('src')).toBe(
        `data:image/svg+xml;base64,${btoa(svg)}`,
      ),
    )
    expect(container.querySelector('svg, script, iframe, object')).toBeNull()
  })

  it.each([
    '![Relative diagram](docs/diagram.svg)',
    '<img src="./docs/diagram.svg" alt="Relative diagram" />',
  ])('resolves relative images before Markdown hardening: %s', async (text) => {
    const view = fixture(text)
    await waitFor(() =>
      expect(screen.getByAltText('Relative diagram').getAttribute('src')).toBe(dataUrl),
    )
    expect(view.request).toHaveBeenCalledWith('pullRequests.image', {
      url: 'https://github.com/owner/repo/blob/abc/docs/diagram.svg',
    })
  })

  it('keeps Markdown HTML and URL sanitization enabled', () => {
    const { container, request } = fixture(
      '<script>throw 1</script><img src="javascript:alert(1)" onerror="alert(1)" /><iframe src="https://example.com"/>',
    )
    expect(container.querySelector('script,iframe,[onerror],img[src^="javascript:"]')).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
})
