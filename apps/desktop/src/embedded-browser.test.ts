import { describe, expect, it, vi } from 'vitest'
import { browserGuestUrl, browserUserAgent, configureEmbeddedBrowser } from './embedded-browser.js'

describe('embedded browser guest', () => {
  it('accepts only HTTP pages and a blank bootstrap document', () => {
    expect(browserGuestUrl('http://127.0.0.1:4311/preview')).toBe('http://127.0.0.1:4311/preview')
    expect(browserGuestUrl('https://example.com/')).toBe('https://example.com/')
    expect(() => browserGuestUrl('file:///etc/passwd')).toThrow('Invalid browser URL')
    expect(() => browserGuestUrl('javascript:alert(1)')).toThrow('Invalid browser URL')
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
    configureEmbeddedBrowser(owner.contents as never)
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
    configureEmbeddedBrowser(owner.contents as never)
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
})

function ownerHarness() {
  const listeners = new Map<string, (...args: never[]) => void>()
  return {
    contents: {
      on: vi.fn((event: string, listener: (...args: never[]) => void) => {
        listeners.set(event, listener)
      }),
    },
    listener(event: string): (...args: any[]) => void {
      const listener = listeners.get(event)
      if (!listener) throw new Error(`Missing ${event} listener`)
      return listener
    },
  }
}
