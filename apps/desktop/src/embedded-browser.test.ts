import type { Event, WebContents, WebPreferences } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { browserGuestUrl, browserUserAgent, configureEmbeddedBrowser } from './embedded-browser.js'

describe('embedded browser guest', () => {
  it('accepts HTTPS pages, loopback HTTP and a blank bootstrap document', () => {
    expect(browserGuestUrl('http://127.0.0.1:4311/preview')).toBe('http://127.0.0.1:4311/preview')
    expect(browserGuestUrl('http://127.38.0.1:5173/')).toBe('http://127.38.0.1:5173/')
    expect(browserGuestUrl('http://localhost:5173/')).toBe('http://localhost:5173/')
    expect(browserGuestUrl('http://app.localhost:5173/')).toBe('http://app.localhost:5173/')
    expect(browserGuestUrl('http://[::1]:5173/')).toBe('http://[::1]:5173/')
    expect(browserGuestUrl('https://example.com/')).toBe('https://example.com/')
    // The URL parser normalizes exotic spellings before the policy sees them.
    expect(browserGuestUrl('http://2130706433/')).toBe('http://2130706433/')
    expect(browserGuestUrl('http://0x7f.0.0.1/')).toBe('http://0x7f.0.0.1/')
    expect(() => browserGuestUrl('file:///etc/passwd')).toThrow('Invalid browser URL')
    expect(() => browserGuestUrl('javascript:alert(1)')).toThrow('Invalid browser URL')
  })

  it('rejects plain HTTP off the host machine', () => {
    // Cloud metadata endpoints, LAN services and WAN sites share one answer.
    expect(() => browserGuestUrl('http://169.254.169.254/latest/meta-data')).toThrow(
      'Invalid browser URL',
    )
    expect(() => browserGuestUrl('http://169.254.169.254./')).toThrow('Invalid browser URL')
    expect(() => browserGuestUrl('http://2852039166/')).toThrow('Invalid browser URL')
    expect(() => browserGuestUrl('http://192.168.1.1/')).toThrow('Invalid browser URL')
    expect(() => browserGuestUrl('http://10.0.0.1/')).toThrow('Invalid browser URL')
    expect(() => browserGuestUrl('http://100.64.0.1/')).toThrow('Invalid browser URL')
    expect(() => browserGuestUrl('http://example.com/')).toThrow('Invalid browser URL')
    expect(() => browserGuestUrl('http://[fe80::1]/')).toThrow('Invalid browser URL')
    expect(() => browserGuestUrl('http://[::ffff:a9fe:a9fe]/')).toThrow('Invalid browser URL')
    expect(() => browserGuestUrl('http://127.0.0.1.evil.example/')).toThrow('Invalid browser URL')
    expect(() => browserGuestUrl('http://localhost.evil.example/')).toThrow('Invalid browser URL')
  })

  it('strips Electron product markers without damaging the Chromium user agent', () => {
    expect(
      browserUserAgent(
        'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36 Electron/43.4.0 TasteCode/1.0.0',
      ),
    ).toBe('Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36')
  })

  it('hardens guests before attachment and rejects privileged bootstrap URLs', () => {
    const owner = ownerHarness()
    configureEmbeddedBrowser(owner.contents)
    const willAttach = owner.listener('will-attach-webview')
    const event = { preventDefault: vi.fn() }
    const preferences = {
      allowRunningInsecureContent: true,
      nodeIntegration: true,
      preload: '/tmp/untrusted.cjs',
      sandbox: false,
      webSecurity: false,
    }

    willAttach(event, preferences, { src: 'file:///private/data' })

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(preferences).toMatchObject({
      allowRunningInsecureContent: false,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:harness-browser',
      sandbox: true,
      webSecurity: true,
    })
    expect(preferences).not.toHaveProperty('preload')
  })

  it('denies permissions and keeps new-window links inside the guest', async () => {
    const owner = ownerHarness()
    configureEmbeddedBrowser(owner.contents)
    const session = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    }
    const guest = {
      getUserAgent: vi.fn(() => 'Mozilla/5.0 Chrome/150 Safari/537.36 Electron/43.4.0'),
      loadURL: vi.fn(async () => undefined),
      on: vi.fn(),
      session,
      setUserAgent: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    }

    owner.listener('did-attach-webview')({}, guest)

    expect(session.setPermissionCheckHandler).toHaveBeenCalledOnce()
    expect(session.setPermissionRequestHandler).toHaveBeenCalledOnce()
    expect(guest.setUserAgent).toHaveBeenCalledWith('Mozilla/5.0 Chrome/150 Safari/537.36')

    const openWindow = guest.setWindowOpenHandler.mock.calls[0]![0]
    expect(openWindow({ url: 'https://example.com/next' })).toEqual({ action: 'deny' })
    await vi.waitFor(() => expect(guest.loadURL).toHaveBeenCalledWith('https://example.com/next'))
    expect(openWindow({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(guest.loadURL).toHaveBeenCalledOnce()
  })

  it('denies guest navigation to non-loopback HTTP at every hook', () => {
    const owner = ownerHarness()
    configureEmbeddedBrowser(owner.contents)

    const event = { preventDefault: vi.fn() }
    owner.listener('will-attach-webview')(event, {}, { src: 'http://169.254.169.254/' })
    expect(event.preventDefault).toHaveBeenCalledOnce()

    const guestListeners = new Map<string, (...args: any[]) => void>()
    const guest = {
      getUserAgent: vi.fn(() => ''),
      loadURL: vi.fn(async () => undefined),
      on: vi.fn((name: string, listener: (...args: any[]) => void) =>
        guestListeners.set(name, listener),
      ),
      session: {
        setPermissionCheckHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
      },
      setUserAgent: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      stop: vi.fn(),
    }
    owner.listener('did-attach-webview')({}, guest)

    const willNavigate = guestListeners.get('will-navigate')
    willNavigate?.(event, 'http://169.254.169.254/latest/meta-data')
    willNavigate?.(event, 'https://example.com/')
    willNavigate?.(event, 'http://127.0.0.1:4311/preview')
    expect(event.preventDefault).toHaveBeenCalledTimes(2)

    // Programmatic loadURL() skips will-navigate; did-start-navigation stops it.
    const startNavigation = guestListeners.get('did-start-navigation')
    startNavigation?.({
      isMainFrame: true,
      isSameDocument: false,
      url: 'http://169.254.169.254/latest/meta-data',
    })
    expect(guest.stop).toHaveBeenCalledOnce()
    startNavigation?.({
      isMainFrame: true,
      isSameDocument: false,
      url: 'http://127.0.0.1:4311/preview',
    })
    startNavigation?.({
      isMainFrame: false,
      isSameDocument: false,
      url: 'http://169.254.169.254/latest/meta-data',
    })
    startNavigation?.({
      isMainFrame: true,
      isSameDocument: false,
      url: 'about:blank',
    })
    expect(guest.stop).toHaveBeenCalledOnce()
  })
})

function ownerHarness() {
  const listeners = new Map<string, (...args: never[]) => void>()
  function on(
    event: 'will-attach-webview',
    listener: (
      event: Event,
      webPreferences: WebPreferences,
      params: Record<string, string>,
    ) => void,
  ): void
  function on(
    event: 'did-attach-webview',
    listener: (event: Event, webContents: WebContents) => void,
  ): void
  function on(event: string, listener: (...args: never[]) => void): void {
    listeners.set(event, listener)
  }
  return {
    contents: {
      on: vi.fn(on),
    },
    listener(event: string): (...args: any[]) => void {
      const listener = listeners.get(event)
      if (!listener) throw new Error(`Missing ${event} listener`)
      return listener
    },
  }
}
