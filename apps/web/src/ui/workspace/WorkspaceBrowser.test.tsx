// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceBrowser } from './WorkspaceBrowser.js'
import { PLAIN_HTTP_LOOPBACK_ONLY } from './browser-url.js'

// What Electron rejects <webview>.loadURL() with, verbatim from the desktop shell.
const DNS_REJECTION =
  "Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_NAME_NOT_RESOLVED (-105) loading 'https://example.com/'"

const DNS_FAILURE_WITHOUT_URL = {
  title: "Can't reach this page",
  detail: 'No site answers at this address. Check it for typos.',
}

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

  it('reports the page URL and title for its tab label, once per change', async () => {
    const onPageInfo = vi.fn()
    const { rerender } = render(<WorkspaceBrowser active tabId="tab-1" onPageInfo={onPageInfo} />)
    const view = guests[0]!
    expect(onPageInfo).toHaveBeenLastCalledWith('tab-1', { url: '', title: '' })
    act(() => view.dispatchEvent(new Event('dom-ready')))

    const address = screen.getByLabelText('Browser address')
    fireEvent.change(address, { target: { value: 'example.com/docs' } })
    fireEvent.submit(address.closest('form')!)
    await waitFor(() =>
      expect(onPageInfo).toHaveBeenLastCalledWith('tab-1', {
        url: 'https://example.com/docs',
        title: 'Example',
      }),
    )
    act(() => dispatchGuestEvent(view, 'page-title-updated', { title: 'Docs · Example' }))
    expect(onPageInfo).toHaveBeenLastCalledWith('tab-1', {
      url: 'https://example.com/docs',
      title: 'Docs · Example',
    })

    // A new owner callback is not a page change and must not report again (#283).
    const calls = onPageInfo.mock.calls.length
    const nextOwner = vi.fn()
    rerender(<WorkspaceBrowser active tabId="tab-1" onPageInfo={nextOwner} />)
    expect(onPageInfo).toHaveBeenCalledTimes(calls)
    expect(nextOwner).not.toHaveBeenCalled()
    act(() => dispatchGuestEvent(view, 'page-title-updated', { title: 'Docs' }))
    expect(nextOwner).toHaveBeenCalledWith('tab-1', {
      url: 'https://example.com/docs',
      title: 'Docs',
    })
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

  it('loads an address entered before the guest has finished starting', async () => {
    render(<WorkspaceBrowser active />)
    const view = guests[0]!
    const address = screen.getByLabelText('Browser address') as HTMLInputElement
    fireEvent.change(address, { target: { value: '127.0.0.1:5173/' } })
    fireEvent.submit(address.closest('form')!)

    expect(view.loadURL).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(address.value).toBe('http://127.0.0.1:5173/')

    act(() => view.dispatchEvent(new Event('dom-ready')))
    await waitFor(() => expect(view.loadURL).toHaveBeenCalledWith('http://127.0.0.1:5173/'))
    expect(view.loadURL).toHaveBeenCalledOnce()
  })

  it('leaves an address the user is typing in place when the page navigates', async () => {
    render(<WorkspaceBrowser active />)
    const view = guests[0]!
    act(() => view.dispatchEvent(new Event('dom-ready')))
    const address = screen.getByLabelText('Browser address') as HTMLInputElement
    fireEvent.change(address, { target: { value: 'example.com/first' } })
    fireEvent.submit(address.closest('form')!)
    await waitFor(() => expect(address.value).toBe('https://example.com/first'))

    fireEvent.focus(address)
    fireEvent.change(address, { target: { value: 'example.com/sec' } })
    act(() => {
      view.getURL.mockReturnValue('https://example.com/redirected')
      dispatchGuestEvent(view, 'did-navigate', { url: 'https://example.com/redirected' })
      view.dispatchEvent(new Event('did-stop-loading'))
    })
    expect(address.value).toBe('example.com/sec')

    fireEvent.blur(address)
    act(() => {
      view.getURL.mockReturnValue('https://example.com/later')
      dispatchGuestEvent(view, 'did-navigate', { url: 'https://example.com/later' })
    })
    expect(address.value).toBe('https://example.com/later')
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
    expect(failureView()).toEqual(DNS_FAILURE_WITHOUT_URL)

    act(() => {
      dispatchGuestEvent(view, 'did-fail-load', {
        errorCode: -3,
        errorDescription: 'ABORTED',
        isMainFrame: true,
      })
    })
    await waitFor(() => expect(failureView()).toEqual(DNS_FAILURE_WITHOUT_URL))
  })

  it.each(['dom-ready', 'did-stop-loading'])(
    'shows a page skeleton only before the first page reaches %s',
    (readyEvent) => {
      const { container } = render(<WorkspaceBrowser active />)
      const view = guests[0]!
      act(() => view.dispatchEvent(new Event('dom-ready')))
      expect(screen.queryByRole('status')).toBeNull()
      view.loadURL.mockImplementation(async (url: string) => {
        view.getURL.mockReturnValue(url)
        view.isLoading.mockReturnValue(true)
        view.dispatchEvent(new Event('did-start-loading'))
      })

      const address = screen.getByLabelText('Browser address')
      fireEvent.change(address, { target: { value: 'example.com/first' } })
      fireEvent.submit(address.closest('form')!)

      const status = screen.getByRole('status')
      const canvas = container.querySelector('.workspace-browser__canvas')!
      const host = container.querySelector('.workspace-browser__guest-host')!
      expect(status.textContent).toBe('Loading page…')
      expect(status.parentElement).toBe(host)
      expect(status.querySelector('.workspace-browser__skeleton-media')).toBeTruthy()
      expect(canvas.getAttribute('aria-busy')).toBe('true')
      expect(container.querySelector('.workspace-browser__placeholder')).toBeNull()
      expect(host.contains(view)).toBe(true)

      act(() => {
        view.isLoading.mockReturnValue(readyEvent === 'dom-ready')
        view.dispatchEvent(new Event(readyEvent))
      })
      expect(screen.queryByRole('status')).toBeNull()
      act(() => {
        view.isLoading.mockReturnValue(false)
        view.dispatchEvent(new Event('did-stop-loading'))
      })
      expect(canvas.getAttribute('aria-busy')).toBe('false')

      fireEvent.change(address, { target: { value: 'example.com/second' } })
      fireEvent.submit(address.closest('form')!)
      expect(view.loadURL).toHaveBeenLastCalledWith('https://example.com/second')
      expect(canvas.getAttribute('aria-busy')).toBe('true')
      expect(screen.queryByRole('status')).toBeNull()
      expect(host.getAttribute('data-visible')).toBe('true')
      expect(host.contains(view)).toBe(true)
      expect(screen.getByLabelText('Browser address')).toBe(address)
    },
  )

  it.each(['event', 'rejection'])(
    'removes the first-page skeleton after a load failure %s',
    async (failureKind) => {
      const { container } = render(<WorkspaceBrowser active />)
      const view = guests[0]!
      act(() => view.dispatchEvent(new Event('dom-ready')))
      let rejectLoad!: (error: Error) => void
      view.loadURL.mockImplementation(
        (url: string) =>
          new Promise<void>((_resolve, reject) => {
            rejectLoad = reject
            view.getURL.mockReturnValue(url)
            view.isLoading.mockReturnValue(true)
            view.dispatchEvent(new Event('did-start-loading'))
          }),
      )
      const address = screen.getByLabelText('Browser address')
      fireEvent.change(address, { target: { value: 'example.com' } })
      fireEvent.submit(address.closest('form')!)
      expect(screen.getByRole('status').textContent).toBe('Loading page…')

      await act(async () => {
        if (failureKind === 'rejection') rejectLoad(new Error(DNS_REJECTION))
        else
          dispatchGuestEvent(view, 'did-fail-load', {
            errorCode: -105,
            errorDescription: 'NAME_NOT_RESOLVED',
            isMainFrame: true,
          })
      })
      expect(screen.queryByRole('status')).toBeNull()
      expect(failureView()).toEqual(
        failureKind === 'rejection'
          ? { title: "Can't reach example.com", detail: DNS_FAILURE_WITHOUT_URL.detail }
          : DNS_FAILURE_WITHOUT_URL,
      )
      expect(container.querySelector('.workspace-browser__canvas')?.getAttribute('aria-busy')).toBe(
        'false',
      )
    },
  )

  it('explains a failed load once, in words, and keeps the address that failed', async () => {
    render(<WorkspaceBrowser active />)
    const view = guests[0]!
    act(() => view.dispatchEvent(new Event('dom-ready')))
    const address = screen.getByLabelText('Browser address') as HTMLInputElement
    fireEvent.change(address, { target: { value: 'example.com/first' } })
    fireEvent.submit(address.closest('form')!)
    await waitFor(() => expect((view.getURL as () => string)()).toBe('https://example.com/first'))

    let rejectLoad!: (error: Error) => void
    view.loadURL.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectLoad = reject
          view.isLoading.mockReturnValue(true)
          view.dispatchEvent(new Event('did-start-loading'))
        }),
    )
    fireEvent.change(address, { target: { value: 'nonexistent-host.invalid' } })
    fireEvent.submit(address.closest('form')!)
    await act(async () => {
      view.isLoading.mockReturnValue(false)
      dispatchGuestEvent(view, 'did-fail-load', {
        errorCode: -105,
        errorDescription: 'ERR_NAME_NOT_RESOLVED',
        isMainFrame: true,
        validatedURL: 'https://nonexistent-host.invalid/',
      })
      view.dispatchEvent(new Event('did-stop-loading'))
      // Electron rejects after the event; that must not replace the message with its own text.
      rejectLoad(new Error(DNS_REJECTION))
    })

    expect(failureView()).toEqual({
      title: "Can't reach nonexistent-host.invalid",
      detail: DNS_FAILURE_WITHOUT_URL.detail,
    })
    // The guest still shows the previous page; the address shows what failed.
    expect((view.getURL as () => string)()).toBe('https://example.com/first')
    expect(address.value).toBe('https://nonexistent-host.invalid/')

    fireEvent.click(screen.getByTitle('Reload'))
    expect(view.loadURL).toHaveBeenLastCalledWith('https://nonexistent-host.invalid/')
    expect(view.reload).not.toHaveBeenCalled()
  })

  it('treats Stop as cancelling the load, not as an error', async () => {
    render(<WorkspaceBrowser active />)
    const view = guests[0]!
    act(() => view.dispatchEvent(new Event('dom-ready')))
    let rejectLoad!: (error: Error) => void
    view.loadURL.mockImplementation(
      (url: string) =>
        new Promise<void>((_resolve, reject) => {
          rejectLoad = reject
          view.getURL.mockReturnValue(url)
          view.isLoading.mockReturnValue(true)
          view.dispatchEvent(new Event('did-start-loading'))
        }),
    )
    const address = screen.getByLabelText('Browser address')
    fireEvent.change(address, { target: { value: '127.0.0.1:4432/hang' } })
    fireEvent.submit(address.closest('form')!)

    fireEvent.click(screen.getByTitle('Stop loading'))
    expect(view.stop).toHaveBeenCalledOnce()
    await act(async () => {
      view.isLoading.mockReturnValue(false)
      dispatchGuestEvent(view, 'did-fail-load', {
        errorCode: -2,
        errorDescription: 'ERR_FAILED',
        isMainFrame: true,
        validatedURL: 'http://127.0.0.1:4432/hang',
      })
      view.dispatchEvent(new Event('did-stop-loading'))
      rejectLoad(
        new Error(
          "Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_FAILED (-2) loading 'http://127.0.0.1:4432/hang'",
        ),
      )
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    ['not a url', 'Enter a valid URL.'],
    ['http://example.com/', PLAIN_HTTP_LOOPBACK_ONLY],
    ['192.168.0.10:5173', PLAIN_HTTP_LOOPBACK_ONLY],
  ])('refuses %s before loading and keeps the typed text', (typed, message) => {
    render(<WorkspaceBrowser active />)
    const view = guests[0]!
    act(() => view.dispatchEvent(new Event('dom-ready')))
    const address = screen.getByLabelText('Browser address') as HTMLInputElement
    fireEvent.change(address, { target: { value: typed } })
    fireEvent.submit(address.closest('form')!)

    expect(screen.getByRole('alert').textContent).toBe(message)
    expect(address.value).toBe(typed)
    expect(view.loadURL).not.toHaveBeenCalled()
    // A refused address is a notice on the toolbar, not a failed page.
    expect(failureView()).toBeNull()
  })

  it('shows a failed page as a calm view with Retry and Edit address instead of the guest', async () => {
    const { container } = render(<WorkspaceBrowser active />)
    const view = guests[0]!
    act(() => view.dispatchEvent(new Event('dom-ready')))
    const address = screen.getByLabelText('Browser address') as HTMLInputElement
    fireEvent.change(address, { target: { value: 'nonexistent-host.invalid' } })
    fireEvent.submit(address.closest('form')!)
    await act(async () => {
      dispatchGuestEvent(view, 'did-fail-load', {
        errorCode: -105,
        errorDescription: 'ERR_NAME_NOT_RESOLVED',
        isMainFrame: true,
        validatedURL: 'https://nonexistent-host.invalid/',
      })
    })

    const failure = container.querySelector('.workspace-browser__failure')!
    expect(failure.getAttribute('role')).toBe('alert')
    expect(failureView()?.title).toBe("Can't reach nonexistent-host.invalid")
    expect(container.querySelector('.workspace-browser__error')).toBeNull()
    const host = container.querySelector('.workspace-browser__guest-host')!
    expect(host.getAttribute('data-visible')).toBe('false')
    expect(container.querySelector('.workspace-browser__placeholder')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Edit address' }))
    expect(document.activeElement).toBe(address)
    expect(address.selectionStart).toBe(0)
    expect(address.selectionEnd).toBe(address.value.length)

    view.loadURL.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(view.loadURL).toHaveBeenCalledWith('https://nonexistent-host.invalid/')
    await waitFor(() => expect(failureView()).toBeNull())
    expect(host.getAttribute('data-visible')).toBe('true')
  })

  it('offers Retry after the page renderer stops and reloads the page', () => {
    render(<WorkspaceBrowser active />)
    const view = guests[0]!
    act(() => view.dispatchEvent(new Event('dom-ready')))
    view.getURL.mockReturnValue('https://example.com/')
    act(() => view.dispatchEvent(new Event('did-stop-loading')))
    act(() => dispatchGuestEvent(view, 'render-process-gone', { details: { reason: 'crashed' } }))

    expect(failureView()).toEqual({
      title: 'This page stopped',
      detail: 'Its renderer ended (crashed). Retry to load it again.',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(view.reload).toHaveBeenCalledOnce()
  })

  it('keeps the page and shows a thin progress line for loads after the first', () => {
    const { container } = render(<WorkspaceBrowser active />)
    const view = guests[0]!
    act(() => view.dispatchEvent(new Event('dom-ready')))
    view.loadURL.mockImplementation(async (url: string) => {
      view.getURL.mockReturnValue(url)
      view.isLoading.mockReturnValue(true)
      view.dispatchEvent(new Event('did-start-loading'))
    })
    const address = screen.getByLabelText('Browser address')
    fireEvent.change(address, { target: { value: 'example.com/first' } })
    fireEvent.submit(address.closest('form')!)
    // The first page has the skeleton, not the line.
    expect(screen.getByRole('status').textContent).toBe('Loading page…')
    expect(container.querySelector('.workspace-browser__progress')).toBeNull()
    act(() => {
      view.isLoading.mockReturnValue(false)
      view.dispatchEvent(new Event('did-stop-loading'))
    })

    fireEvent.change(address, { target: { value: 'example.com/second' } })
    fireEvent.submit(address.closest('form')!)
    expect(screen.queryByRole('status')).toBeNull()
    expect(container.querySelector('.workspace-browser__progress')).toBeTruthy()
    act(() => {
      view.isLoading.mockReturnValue(false)
      view.dispatchEvent(new Event('did-stop-loading'))
    })
    expect(container.querySelector('.workspace-browser__progress')).toBeNull()
  })
})

function failureView(): { title: string; detail: string } | null {
  const view = document.querySelector('.workspace-browser__failure')
  if (!view) return null
  return {
    title: view.querySelector('strong')?.textContent ?? '',
    detail: view.querySelector('.workspace-empty > span')?.textContent ?? '',
  }
}

function dispatchGuestEvent(
  view: HTMLElement,
  name: string,
  detail: Record<string, unknown>,
): void {
  const event = new Event(name)
  Object.assign(event, detail)
  view.dispatchEvent(event)
}
