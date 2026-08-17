// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requiredElement, requiredInstance, requiredValue } from '../../test-dom.js'
import {
  WorkspaceBrowser,
  type BrowserGuest,
  type WorkspaceBrowserServices,
} from './WorkspaceBrowser.js'

let guests: BrowserGuest[] = []
const openExternalUrl = vi.fn<WorkspaceBrowserServices['openExternalUrl']>()

function createBrowserGuest(): BrowserGuest {
  const view = document.createElement('webview')
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
}

const services = {
  isDesktop: true,
  openExternalUrl,
  createBrowserGuest,
} satisfies WorkspaceBrowserServices

beforeEach(() => {
  guests = []
  openExternalUrl.mockResolvedValue(undefined)

  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )

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
    render(<WorkspaceBrowser active services={services} />)

    const view = guests[0]!
    expect(view).toBeDefined()
    expect(view.getAttribute('partition')).toBe('persist:harness-browser')
    expect(view.getAttribute('src')).toBe('about:blank')
    act(() => view.dispatchEvent(new Event('dom-ready')))

    const address = requiredInstance(screen.getByLabelText('Browser address'), HTMLInputElement)
    fireEvent.change(address, { target: { value: 'example.com/docs' } })
    fireEvent.submit(requiredValue(address.closest('form'), 'browser address form'))

    await waitFor(() => expect(view.loadURL).toHaveBeenCalledWith('https://example.com/docs'))
    expect(address.value).toBe('https://example.com/docs')

    fireEvent.click(screen.getByRole('button', { name: 'Mobile · 390 × 844' }))
    const host = requiredElement(document, '.workspace-browser__guest-host', HTMLElement)
    expect(host.style.width).toBe('266px')
    expect(host.style.height).toBe('576px')
    expect(view.style.width).toBe('390px')
    expect(view.style.height).toBe('844px')
    expect(view.style.transform).toBe(`scale(${266 / 390})`)

    fireEvent.click(screen.getByTitle('Open in system browser'))
    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('opens a design preview and reloads the same URL for a later review pass', async () => {
    const first = {
      requestId: '00000000-0000-4000-8000-000000000001',
      url: 'http://127.0.0.1:4173/',
    }
    const { rerender } = render(<WorkspaceBrowser active navigation={first} services={services} />)
    const view = guests[0]!

    expect(view.loadURL).not.toHaveBeenCalled()
    act(() => view.dispatchEvent(new Event('dom-ready')))
    await waitFor(() => expect(view.loadURL).toHaveBeenCalledWith(first.url))
    expect(requiredInstance(screen.getByLabelText('Browser address'), HTMLInputElement).value).toBe(
      first.url,
    )

    rerender(
      <WorkspaceBrowser
        active
        services={services}
        navigation={{ ...first, requestId: '00000000-0000-4000-8000-000000000002' }}
      />,
    )
    await waitFor(() => expect(view.loadURL).toHaveBeenCalledTimes(2))

    rerender(
      <WorkspaceBrowser
        active
        services={services}
        navigation={{
          requestId: '00000000-0000-4000-8000-000000000003',
          url: 'http://127.0.0.1:5183/',
        }}
      />,
    )
    await waitFor(() => expect(view.loadURL).toHaveBeenLastCalledWith('http://127.0.0.1:5183/'))
  })

  it('shows invalid input instead of sending privileged URLs to Chromium', () => {
    render(<WorkspaceBrowser active services={services} />)
    const view = guests[0]!

    const address = screen.getByLabelText('Browser address')
    fireEvent.change(address, { target: { value: 'file:///private/data' } })
    fireEvent.submit(requiredValue(address.closest('form'), 'browser address form'))

    expect(screen.getByRole('alert').textContent).toBe('Enter a valid HTTP or HTTPS URL.')
    expect(view.loadURL).not.toHaveBeenCalled()
  })

  it('surfaces main-frame load failures and ignores cancelled navigation', async () => {
    render(<WorkspaceBrowser active services={services} />)
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

type GuestEventDetail =
  { url: string } | { errorCode: number; errorDescription: string; isMainFrame: boolean }

function dispatchGuestEvent(view: HTMLElement, name: string, detail: GuestEventDetail): void {
  const event = new Event(name)
  Object.assign(event, detail)
  view.dispatchEvent(event)
}
