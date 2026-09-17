import type { Event, Session, WebContents, WebPreferences } from 'electron'

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
    // A guest with webviewTag could nest webviews whose will-attach-webview
    // fires on the guest's own webContents — outside this hardening listener.
    webPreferences.webviewTag = false

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
    // will-navigate does not fire for programmatic loadURL() or src attribute
    // changes; stopping a rejected main-frame navigation at start keeps its
    // response from ever committing into the guest.
    guest.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument && !isBrowserGuestUrl(details.url, true)) {
        guest.stop()
      }
    })
    // A guest that still ends up off the web gets unloaded.
    guest.on('did-navigate', (_event, url) => {
      if (!isBrowserGuestUrl(url, true)) {
        void guest.loadURL('about:blank').catch(() => {})
      }
    })
  })
}

export function browserGuestUrl(value: unknown): string {
  if (typeof value !== 'string' || !isBrowserGuestUrl(value)) {
    throw new Error('Invalid browser URL')
  }
  return value
}

function isBrowserGuestUrl(value: unknown, allowBlank = false): value is string {
  if (typeof value !== 'string') return false
  if (allowBlank && value === 'about:blank') return true
  try {
    const url = new URL(value)
    if (url.protocol === 'https:') return true
    // Plain HTTP stays loopback-only: dev previews bind 127.0.0.1 (see
    // LoopbackPreviewUrlSchema), while unrestricted HTTP would let a guest
    // page pull link-local metadata endpoints or LAN services into this
    // shared session.
    return url.protocol === 'http:' && isLoopbackHostname(url.hostname)
  } catch {
    return false
  }
}

/**
 * WHATWG parsing already normalizes non-decimal IPv4 spellings, trailing-dot
 * IPs and compressed IPv6 literals, so string checks cover every loopback
 * spelling a URL can carry.
 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === '[::1]') return true
  if (/^127(?:\.\d{1,3}){3}$/.test(hostname)) return true
  const domain = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname
  return domain === 'localhost' || domain.endsWith('.localhost')
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
