// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceBrowser } from './WorkspaceBrowser.js'

const nativeBrowser = vi.hoisted(() => ({
  openExternal: vi.fn(),
}))

vi.mock('../../bridge.js', () => ({
  isDesktop: true,
  openExternalUrl: nativeBrowser.openExternal,
}))

type FakeBrowserGuest = HTMLElement & {
  canGoBack: ReturnType<typeof vi.fn>
  canGoForward: ReturnType<typeof vi.fn>
  getTitle: ReturnType<typeof vi.fn>
  getURL: ReturnType<typeof vi.fn>
  goBack: ReturnType<typeof vi.fn>
  goForward: ReturnType<typeof vi.fn>
  isLoading: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

let guests: FakeBrowserGuest[] = []

beforeEach(() => {
  guests = []
  nativeBrowser.openExternal.mockResolvedValue(undefined)

  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )

  const originalCreateElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((
    tagName: string,
    options?: ElementCreationOptions,
  ) => {
    if (tagName !== 'webview') return originalCreateElement(tagName, options)
    const view = originalCreateElement('div') as unknown as FakeBrowserGuest
    let url = 'about:blank'
    let title = ''
    let loading = false
    view.canGoBack = vi.fn(() => false)
    view.canGoForward = vi.fn(() => false)
    view.getTitle = vi.fn(() => title)
    view.getURL = vi.fn(() => url)
    view.goBack = vi.fn()
    view.goForward = vi.fn()
    view.isLoading = vi.fn(() => loading)
    view.loadURL = vi.fn(async (nextUrl: string) => {
      loading = true
      view.dispatchEvent(new Event('did-start-loading'))
      url = nextUrl
      title = 'Example'
      loading = false
      dispatchGuestEvent(view, 'did-navigate', { url })
      view.dispatchEvent(new Event('did-stop-loading'))
    })
    view.reload = vi.fn()
    view.stop = vi.fn()
    guests.push(view)
    return view
  }) as typeof document.createElement)

  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('workspace-browser__canvas') ? 800 : 0
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('workspace-browser__canvas') ? 600 : 0
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('WorkspaceBrowser', () => {
  it('navigates in an embedded Chromium guest and applies real responsive viewport sizes', async () => {
    render(<WorkspaceBrowser active />)

    const view = guests[0]!
    expect(view).toBeDefined()
    expect(view.getAttribute('partition')).toBe('persist:harness-browser')
    expect(view.getAttribute('src')).toBe('about:blank')

    const address = screen.getByLabelText('Browser address')
    fireEvent.change(address, { target: { value: 'example.com/docs' } })
    fireEvent.submit(address.closest('form')!)

    await waitFor(() => expect(view.loadURL).toHaveBeenCalledWith('https://example.com/docs'))
    expect((address as HTMLInputElement).value).toBe('https://example.com/docs')

    fireEvent.click(screen.getByRole('button', { name: 'Mobile · 390 × 844' }))
    const host = document.querySelector<HTMLElement>('.workspace-browser__guest-host')!
    expect(host.style.width).toBe('266px')
    expect(host.style.height).toBe('576px')
    expect(view.style.width).toBe('390px')
    expect(view.style.height).toBe('844px')
    expect(view.style.transform).toBe(`scale(${266 / 390})`)

    fireEvent.click(screen.getByTitle('Open in system browser'))
    expect(nativeBrowser.openExternal).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('shows invalid input instead of sending privileged URLs to Chromium', () => {
    render(<WorkspaceBrowser active />)
    const view = guests[0]!

    const address = screen.getByLabelText('Browser address')
    fireEvent.change(address, { target: { value: 'file:///private/data' } })
    fireEvent.submit(address.closest('form')!)

    expect(screen.getByRole('alert').textContent).toBe('Enter a valid HTTP or HTTPS URL.')
    expect(view.loadURL).not.toHaveBeenCalled()
  })

  it('surfaces main-frame load failures and ignores cancelled navigation', async () => {
    render(<WorkspaceBrowser active />)
    const view = guests[0]!

    act(() => {
      dispatchGuestEvent(view, 'did-fail-load', {
        errorCode: -105,
        errorDescription: 'NAME_NOT_RESOLVED',
        isMainFrame: true,
      })
    })
    expect(screen.getByRole('alert').textContent).toBe('NAME_NOT_RESOLVED')

    act(() => {
      dispatchGuestEvent(view, 'did-fail-load', {
        errorCode: -3,
        errorDescription: 'ABORTED',
        isMainFrame: true,
      })
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('NAME_NOT_RESOLVED'))
  })
})

function dispatchGuestEvent(
  view: HTMLElement,
  name: string,
  detail: Record<string, unknown>,
): void {
  const event = new Event(name)
  Object.assign(event, detail)
  view.dispatchEvent(event)
}
