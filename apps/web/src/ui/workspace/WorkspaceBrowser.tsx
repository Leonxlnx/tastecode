import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe2,
  LoaderCircle,
  Laptop,
  Monitor,
  RefreshCw,
  Smartphone,
  Tablet,
} from 'lucide-react'
import { isDesktop, openExternalUrl } from '../../bridge.js'
import { WorkspaceEmptyState } from './WorkspaceEmptyState.js'
import { browserUrl } from './browser-url.js'
import {
  BROWSER_VIEWPORTS,
  fitBrowserViewport,
  type BrowserViewportId,
} from './browser-viewport.js'

const VIEWPORT_ICONS = {
  fluid: Monitor,
  desktop: Laptop,
  tablet: Tablet,
  mobile: Smartphone,
} satisfies Record<BrowserViewportId, typeof Monitor>
const FIXED_VIEWPORT_GUTTER = 24

type BrowserState = {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

type BrowserGuest = HTMLElement & {
  canGoBack(): boolean
  canGoForward(): boolean
  getTitle(): string
  getURL(): string
  goBack(): void
  goForward(): void
  isLoading(): boolean
  loadURL(url: string): Promise<void>
  reload(): void
  stop(): void
}

const EMPTY_STATE: BrowserState = {
  url: '',
  title: 'New tab',
  loading: false,
  canGoBack: false,
  canGoForward: false,
}

export type BrowserNavigationRequest = {
  requestId: string
  url: string
}

export const WorkspaceBrowser = memo(function WorkspaceBrowser({
  active,
  navigation,
}: {
  active: boolean
  navigation?: BrowserNavigationRequest | undefined
}) {
  const canvas = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const guest = useRef<BrowserGuest | null>(null)
  const lastNavigationRequest = useRef<string | undefined>(undefined)
  const [address, setAddress] = useState('')
  const [state, setState] = useState<BrowserState>(EMPTY_STATE)
  const [viewport, setViewport] = useState<BrowserViewportId>('fluid')
  const [error, setError] = useState<string>()

  const syncGuestState = useCallback(() => {
    const view = guest.current
    if (!view) return
    try {
      const currentUrl = webPageUrl(view.getURL())
      setState({
        url: currentUrl,
        title: view.getTitle() || 'New tab',
        loading: view.isLoading(),
        canGoBack: view.canGoBack(),
        canGoForward: view.canGoForward(),
      })
      if (currentUrl) setAddress(currentUrl)
    } catch {
      // The guest can detach between an event and this state read. Its next
      // lifecycle event, or a remount, supplies the authoritative state.
    }
  }, [])

  useLayoutEffect(() => {
    const element = host.current
    if (!element || !isDesktop) return

    const view = document.createElement('webview') as BrowserGuest
    view.className = 'workspace-browser__guest'
    view.setAttribute('aria-label', 'Browser page')
    view.setAttribute('partition', 'persist:harness-browser')
    view.setAttribute(
      'webpreferences',
      'contextIsolation=yes, nodeIntegration=no, sandbox=yes, spellcheck=no',
    )
    view.setAttribute('src', 'about:blank')

    const onAttach = () => syncGuestState()
    const onStart = () => {
      setError(undefined)
      setState((current) => ({ ...current, loading: true }))
    }
    const onStop = () => syncGuestState()
    const onNavigate = (event: Event) => {
      const url = webPageUrl((event as Event & { url?: unknown }).url)
      if (url) {
        setAddress(url)
        setState((current) => ({ ...current, url }))
      }
      syncGuestState()
    }
    const onNavigateInPage = (event: Event) => {
      const navigation = event as Event & { isMainFrame?: boolean; url?: unknown }
      if (navigation.isMainFrame !== false) onNavigate(event)
    }
    const onTitle = (event: Event) => {
      const title = (event as Event & { title?: unknown }).title
      if (typeof title === 'string') setState((current) => ({ ...current, title }))
    }
    const onFail = (event: Event) => {
      const failure = event as Event & {
        errorCode?: number
        errorDescription?: string
        isMainFrame?: boolean
      }
      if (failure.isMainFrame !== false && failure.errorCode !== -3) {
        setError(failure.errorDescription || 'The page could not be loaded.')
      }
      syncGuestState()
    }
    const onRendererGone = (event: Event) => {
      const reason = (event as Event & { details?: { reason?: string } }).details?.reason
      setError(`Page renderer stopped${reason ? `: ${reason}` : '.'}`)
      syncGuestState()
    }

    view.addEventListener('did-attach', onAttach)
    view.addEventListener('did-start-loading', onStart)
    view.addEventListener('did-stop-loading', onStop)
    view.addEventListener('did-navigate', onNavigate)
    view.addEventListener('did-navigate-in-page', onNavigateInPage)
    view.addEventListener('page-title-updated', onTitle)
    view.addEventListener('did-fail-load', onFail)
    view.addEventListener('render-process-gone', onRendererGone)
    element.append(view)
    guest.current = view

    if (typeof view.loadURL !== 'function') {
      setError('The in-app browser is unavailable in this window.')
    }

    return () => {
      guest.current = null
      lastNavigationRequest.current = undefined
      view.removeEventListener('did-attach', onAttach)
      view.removeEventListener('did-start-loading', onStart)
      view.removeEventListener('did-stop-loading', onStop)
      view.removeEventListener('did-navigate', onNavigate)
      view.removeEventListener('did-navigate-in-page', onNavigateInPage)
      view.removeEventListener('page-title-updated', onTitle)
      view.removeEventListener('did-fail-load', onFail)
      view.removeEventListener('render-process-gone', onRendererGone)
      view.remove()
    }
  }, [syncGuestState])

  useLayoutEffect(() => {
    const canvasElement = canvas.current
    const hostElement = host.current
    if (!canvasElement || !hostElement) return
    const selected =
      BROWSER_VIEWPORTS.find((option) => option.id === viewport) ?? BROWSER_VIEWPORTS[0]!

    const layout = () => {
      const gutter = selected.id === 'fluid' ? 0 : FIXED_VIEWPORT_GUTTER
      const fitted = fitBrowserViewport(
        canvasElement.clientWidth - gutter,
        canvasElement.clientHeight - gutter,
        selected,
      )
      hostElement.style.width = `${fitted.width}px`
      hostElement.style.height = `${fitted.height}px`

      const view = guest.current
      if (!view) return
      if (selected.width && selected.height) {
        const scale = Math.min(fitted.width / selected.width, fitted.height / selected.height)
        view.style.width = `${selected.width}px`
        view.style.height = `${selected.height}px`
        view.style.transform = `scale(${scale})`
      } else {
        view.style.width = '100%'
        view.style.height = '100%'
        view.style.transform = 'none'
      }
    }

    const observer = new ResizeObserver(layout)
    observer.observe(canvasElement)
    layout()
    return () => observer.disconnect()
  }, [viewport])

  const navigate = useCallback(
    (value: string) => {
      const url = browserUrl(value)
      if (!url) {
        setError('Enter a valid HTTP or HTTPS URL.')
        return false
      }
      const view = guest.current
      if (!view || typeof view.loadURL !== 'function') {
        setError('The in-app browser is unavailable in this window.')
        return false
      }

      setAddress(url)
      setState((current) => ({ ...current, url, loading: true }))
      setError(undefined)
      void view.loadURL(url).catch((cause: unknown) => {
        if (!isAbortedNavigation(cause)) setError(errorMessage(cause))
        syncGuestState()
      })
      return true
    },
    [syncGuestState],
  )

  useLayoutEffect(() => {
    if (!navigation || lastNavigationRequest.current === navigation.requestId) return
    if (navigate(navigation.url)) lastNavigationRequest.current = navigation.requestId
  }, [navigate, navigation])

  const action = (nextAction: 'back' | 'forward' | 'reload' | 'stop') => {
    const view = guest.current
    if (!view) return
    setError(undefined)
    try {
      if (nextAction === 'back' && view.canGoBack()) view.goBack()
      else if (nextAction === 'forward' && view.canGoForward()) view.goForward()
      else if (nextAction === 'reload' && state.url) view.reload()
      else if (nextAction === 'stop') view.stop()
      syncGuestState()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <div className="workspace-browser">
      <div className="workspace-browser__toolbar">
        <button
          type="button"
          title="Back"
          disabled={!state.canGoBack}
          onClick={() => action('back')}
        >
          <ArrowLeft size={15} aria-hidden />
        </button>
        <button
          type="button"
          title="Forward"
          disabled={!state.canGoForward}
          onClick={() => action('forward')}
        >
          <ArrowRight size={15} aria-hidden />
        </button>
        <button
          type="button"
          title={state.loading ? 'Stop loading' : 'Reload'}
          disabled={!state.url}
          onClick={() => action(state.loading ? 'stop' : 'reload')}
        >
          {state.loading ? (
            <LoaderCircle className="spinner" size={15} aria-hidden />
          ) : (
            <RefreshCw size={14} aria-hidden />
          )}
        </button>
        <form
          className="workspace-browser__address"
          onSubmit={(event) => {
            event.preventDefault()
            navigate(address)
          }}
        >
          <Globe2 size={14} aria-hidden />
          <input
            value={address}
            placeholder="Enter a URL"
            aria-label="Browser address"
            spellCheck={false}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            type="button"
            title="Open in system browser"
            disabled={!state.url}
            onClick={() =>
              void openExternalUrl(state.url).catch((cause: unknown) =>
                setError(errorMessage(cause)),
              )
            }
          >
            <ExternalLink size={14} aria-hidden />
          </button>
        </form>

        <div className="workspace-browser__viewports" aria-label="Preview size">
          {BROWSER_VIEWPORTS.map((option) => {
            const Icon = VIEWPORT_ICONS[option.id]
            return (
              <button
                type="button"
                key={option.id}
                title={option.label}
                aria-label={option.label}
                aria-pressed={viewport === option.id}
                onClick={() => setViewport(option.id)}
              >
                <Icon size={15} aria-hidden />
              </button>
            )
          })}
        </div>
      </div>

      <div ref={canvas} className="workspace-browser__canvas" data-viewport={viewport}>
        <div
          ref={host}
          className="workspace-browser__guest-host"
          data-visible={Boolean(state.url)}
          aria-hidden={!active}
        />
        {!state.url ? (
          <div className="workspace-browser__placeholder">
            <WorkspaceEmptyState
              kind="browser"
              title={isDesktop ? 'Start browsing' : 'Desktop browser unavailable'}
              detail={
                isDesktop
                  ? 'Enter a URL to open a page.'
                  : 'The in-app browser runs in the desktop app.'
              }
            />
          </div>
        ) : null}
        {error ? (
          <div className="workspace-browser__error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  )
})

function webPageUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : ''
  } catch {
    return ''
  }
}

function isAbortedNavigation(cause: unknown): boolean {
  return cause instanceof Error && /ERR_ABORTED|\(-3\)/i.test(cause.message)
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
