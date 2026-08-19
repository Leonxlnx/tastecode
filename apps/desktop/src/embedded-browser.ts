import type { Event, Session, WebContents, WebPreferences } from 'electron'
import { z } from 'zod'

const BROWSER_PARTITION = 'persist:harness-browser'
const configuredSessions = new WeakSet<Session>()

export interface EmbeddedBrowserOwner {
  on(
    event: 'will-attach-webview',
    listener: (
      event: Event,
      webPreferences: WebPreferences,
      params: Record<string, string>,
    ) => void,
  ): unknown
  on(
    event: 'did-attach-webview',
    listener: (event: Event, webContents: WebContents) => void,
  ): unknown
}

/**
 * Configure renderer-owned <webview> guests before any remote content is
 * attached. The page lives in Chromium's guest process, while the UI remains a
 * normal DOM element that follows the sidebar's layout without native overlays.
 */
export function configureEmbeddedBrowser(owner: EmbeddedBrowserOwner): void {
  owner.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.allowRunningInsecureContent = false
    webPreferences.backgroundThrottling = false
    webPreferences.contextIsolation = true
    webPreferences.navigateOnDragDrop = false
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.nodeIntegrationInWorker = false
    webPreferences.partition = BROWSER_PARTITION
    webPreferences.plugins = false
    webPreferences.sandbox = true
    webPreferences.spellcheck = false
    webPreferences.webSecurity = true

    if (!isBrowserGuestUrl(params['src'], true)) event.preventDefault()
  })

  owner.on('did-attach-webview', (_event, guest) => {
    configureBrowserSession(guest.session)
    guest.setUserAgent(browserUserAgent(guest.getUserAgent()))

    guest.setWindowOpenHandler(({ url }) => {
      if (isBrowserGuestUrl(url)) {
        void guest.loadURL(url).catch((error) => {
          console.warn('[browser] failed to open guest link', error)
        })
      }
      return { action: 'deny' }
    })

    guest.on('will-navigate', (event, url) => {
      if (!isBrowserGuestUrl(url)) event.preventDefault()
    })
    guest.on('will-redirect', (event, url) => {
      if (!isBrowserGuestUrl(url)) event.preventDefault()
    })
  })
}

export function browserGuestUrl(value: unknown): string {
  const parsed = z.string().safeParse(value)
  if (!parsed.success || !isBrowserGuestUrl(parsed.data)) {
    throw new Error('Invalid browser URL')
  }
  return parsed.data
}

export function isBrowserGuestUrl(value: unknown, allowBlank = false): value is string {
  const parsed = z.string().safeParse(value)
  if (!parsed.success) return false
  if (allowBlank && parsed.data === 'about:blank') return true
  try {
    const url = new URL(parsed.data)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/** Present the guest as Chromium instead of exposing the Electron shell. */
export function browserUserAgent(value: string): string {
  return value
    .replace(/\sElectron\/[\w.-]+/gi, '')
    .replace(/\s(?:TasteCode|PersonalHarness|@harness\/desktop)\/[\w.-]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function configureBrowserSession(browserSession: Session): void {
  if (configuredSessions.has(browserSession)) return
  configuredSessions.add(browserSession)
  browserSession.setPermissionCheckHandler(() => false)
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
}
