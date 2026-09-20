import type { Event, WebContents, WebPreferences } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { browserUserAgent, configureEmbeddedBrowser } from './embedded-browser.js'

describe('embedded browser guest', () => {
  it('accepts a blank bootstrap document but not a privileged one', () => {
    const owner = ownerHarness()
    configureEmbeddedBrowser(owner.contents)
    const willAttach = owner.listener('will-attach-webview')

    const allowed = { preventDefault: vi.fn() }
    willAttach(allowed, {}, { src: 'about:blank' })
    expect(allowed.preventDefault).not.toHaveBeenCalled()

    const denied = { preventDefault: vi.fn() }
    willAttach(denied, {}, { src: 'file:///private/data' })
    expect(denied.preventDefault).toHaveBeenCalledOnce()
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
    // about:blank is only a bootstrap allowance, not a navigable target.
    expect(openWindow({ url: 'about:blank' })).toEqual({ action: 'deny' })
    expect(openWindow({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(guest.loadURL).toHaveBeenCalledOnce()
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
