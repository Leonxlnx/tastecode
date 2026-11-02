// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '../transport.js'
import { CompletedMarkdown } from './CompletedMarkdown.js'
import { ChatImageContext } from './MarkdownImage.js'
import { localImagePath, resolveChatImage } from './chat-image-source.js'

beforeEach(() => vi.stubGlobal('IntersectionObserver', undefined))
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
