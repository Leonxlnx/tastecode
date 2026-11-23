// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '../transport.js'
import { CompletedMarkdown } from './CompletedMarkdown.js'
import { ChatImageContext } from './MarkdownImage.js'
import { localImagePath, resolveChatImage } from './chat-image-source.js'

const bridge = vi.hoisted(() => ({
  isDesktop: false,
  revealPath: vi.fn(async () => undefined),
}))

vi.mock('../bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bridge.js')>()
  return {
    ...actual,
    get isDesktop() {
      return bridge.isDesktop
    },
    revealPath: bridge.revealPath,
  }
})

beforeEach(() => {
  bridge.isDesktop = false
  bridge.revealPath.mockClear()
  vi.stubGlobal('IntersectionObserver', undefined)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const dataUrl = 'data:image/png;base64,iVBORw0KGgo='

function chat(text: string) {
  const request = vi.fn().mockResolvedValue({ mimeType: 'image/png', data: 'iVBORw0KGgo=' })
  const transport = { request } as unknown as Transport
  const view = render(
    <ChatImageContext.Provider value={(source) => resolveChatImage(transport, 'chat', source)}>
      <CompletedMarkdown text={text} />
    </ChatImageContext.Provider>,
  )
  return { ...view, request }
}

describe('images in chat replies', () => {
  it('loads a screenshot on this computer through the server', async () => {
    const { request, container } = chat(
      'The rail:\n![Rail, dark](/tmp/turn-rail-shot/rail-dark.png)\n![Rail, light](</tmp/turn rail/light.png>)',
    )
    await waitFor(() => expect(screen.getByAltText('Rail, dark').getAttribute('src')).toBe(dataUrl))
    await waitFor(() =>
      expect(screen.getByAltText('Rail, light').getAttribute('src')).toBe(dataUrl),
    )
    expect(request).toHaveBeenCalledWith('attachments.read', {
      threadId: 'chat',
      path: '/tmp/turn-rail-shot/rail-dark.png',
    })
    expect(request).toHaveBeenCalledWith('attachments.read', {
      threadId: 'chat',
      path: '/tmp/turn rail/light.png',
    })
    expect(container.textContent).not.toContain('Image not available')
  })

  it('shows a web image as it is, without asking the server', async () => {
    const { request } = chat('![Logo](https://raw.githubusercontent.com/o/r/main/logo.png)')
    await waitFor(() =>
      expect(screen.getByAltText('Logo').getAttribute('src')).toBe(
        'https://raw.githubusercontent.com/o/r/main/logo.png',
      ),
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('opens an enlarged zoomable viewer when clicking a chat image and closes with Escape', async () => {
    chat('Before:\n![Before](/tmp/shots/before.png)')
    await waitFor(() => expect(screen.getByAltText('Before').getAttribute('src')).toBe(dataUrl))

    fireEvent.click(screen.getByRole('button', { name: 'Open preview of Before' }))

    const dialog = await screen.findByRole('dialog', { name: 'Preview Before' })
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(dataUrl)
    expect(screen.getByRole('link', { name: 'Download image' }).getAttribute('href')).toBe(dataUrl)

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByText('125%')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Preview Before' })).toBeNull()
  })

  it('falls back to the file name when a chat image has empty alt text', async () => {
    chat('![](/tmp/shots/after%20fix.png)')
    const button = await screen.findByRole('button', { name: 'Open preview of after fix.png' })
    fireEvent.click(button)
    expect(await screen.findByRole('dialog', { name: 'Preview after fix.png' })).toBeTruthy()
  })

  it('offers Show in folder for local chat images on desktop and Download for remote images', async () => {
    bridge.isDesktop = true
    chat('![Local](/tmp/shots/local.png)\n\n![Remote](https://example.com/remote.png)')
    await waitFor(() => expect(screen.getByAltText('Local').getAttribute('src')).toBe(dataUrl))

    fireEvent.click(screen.getByRole('button', { name: 'Open preview of Local' }))
    const reveal = await screen.findByRole('button', { name: 'Show in folder' })
    fireEvent.click(reveal)
    expect(bridge.revealPath).toHaveBeenCalledWith('/tmp/shots/local.png')
    fireEvent.keyDown(window, { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: 'Open preview of Remote' }))
    expect(await screen.findByRole('link', { name: 'Download image' })).toBeTruthy()
  })

  it('keeps linked Markdown images clickable as links without nesting a preview button', async () => {
    chat('[![Badge](https://example.com/badge.png)](https://example.com/docs)')
    await waitFor(() =>
      expect(screen.getByAltText('Badge').getAttribute('src')).toBe(
        'https://example.com/badge.png',
      ),
    )

    const link = screen.getByRole('link', { name: 'Badge' })
    expect(link.getAttribute('href')).toBe('https://example.com/docs')
    expect(link.querySelector('button')).toBeNull()
    expect(screen.queryByRole('button', { name: /Open preview/ })).toBeNull()
  })
})

describe('localImagePath', () => {
  it.each([
    ['/tmp/shot.png', '/tmp/shot.png'],
    ['/tmp/turn%20rail/a.png', '/tmp/turn rail/a.png'],
    ['file:///Users/me/shot.png', '/Users/me/shot.png'],
    ['file:///C:/Shots/a.png', 'C:/Shots/a.png'],
    ['C:\\Shots\\a.png', 'C:\\Shots\\a.png'],
  ])('reads %s as a file on the computer', (source, file) => {
    expect(localImagePath(source)).toBe(file)
  })

  it.each([
    'https://example.com/a.png',
    '//example.com/a.png',
    'shots/a.png',
    'data:image/png;base64,AAAA',
    'file://server/share/a.png',
  ])('leaves %s to the browser', (source) => {
    expect(localImagePath(source)).toBeUndefined()
  })
})
