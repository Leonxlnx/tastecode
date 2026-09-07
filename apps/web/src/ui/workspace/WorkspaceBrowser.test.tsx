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
    const element = originalCreateElement('div')
    let url = 'about:blank'
    let title = ''
    let loading = false
    const loadURL = vi.fn(async (nextUrl: string) => {
      loading = true
      element.dispatchEvent(new Event('did-start-loading'))
      url = nextUrl
      title = 'Example'
      loading = false
      dispatchGuestEvent(element, 'did-navigate', { url })
      element.dispatchEvent(new Event('did-stop-loading'))
    })
    const view: FakeBrowserGuest = Object.assign(element, {
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false),
      getTitle: vi.fn(() => title),
      getURL: vi.fn(() => url),
      goBack: vi.fn(),
      goForward: vi.fn(),
      isLoading: vi.fn(() => loading),
      loadURL,
      reload: vi.fn(),
      stop: vi.fn(),
    })
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
    act(() => view.dispatchEvent(new Event('dom-ready')))

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

  it('opens a design preview and reloads the same URL for a later review pass', async () => {
    const first = {
      requestId: '00000000-0000-4000-8000-000000000001',
      url: 'http://127.0.0.1:4173/',
    }
    const { rerender } = render(<WorkspaceBrowser active navigation={first} />)
    const view = guests[0]!

    expect(view.loadURL).not.toHaveBeenCalled()
    act(() => view.dispatchEvent(new Event('dom-ready')))
    await waitFor(() => expect(view.loadURL).toHaveBeenCalledWith(first.url))
    expect((screen.getByLabelText('Browser address') as HTMLInputElement).value).toBe(first.url)

    rerender(
      <WorkspaceBrowser
        active
        navigation={{ ...first, requestId: '00000000-0000-4000-8000-000000000002' }}
      />,
    )
    await waitFor(() => expect(view.loadURL).toHaveBeenCalledTimes(2))

    rerender(
      <WorkspaceBrowser
        active
        navigation={{
          requestId: '00000000-0000-4000-8000-000000000003',
          url: 'http://127.0.0.1:5183/',
        }}
      />,
    )
    await waitFor(() => expect(view.loadURL).toHaveBeenLastCalledWith('http://127.0.0.1:5183/'))
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
