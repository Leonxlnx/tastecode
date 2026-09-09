import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { z } from 'zod'
import {
  IconArrowLeft as ArrowLeft,
  IconArrowRight as ArrowRight,
  IconExternalLink as ExternalLink,
  IconWorld as Globe2,
  IconLoader2 as LoaderCircle,
  IconDeviceLaptop as Laptop,
  IconDeviceDesktop as Monitor,
  IconRefresh as RefreshCw,
  IconDeviceMobile as Smartphone,
  IconDeviceTablet as Tablet,
} from '@tabler/icons-react'
import { isDesktop, openExternalUrl } from '../../bridge.js'
import { errorMessage } from '../../boundary.js'
import { IconMorph } from '../IconMorph.js'
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

declare global {
  interface HTMLElementTagNameMap {
    webview: BrowserGuest
  }
}

const NavigationEventSchema = z.object({
  isMainFrame: z.boolean().optional(),
  url: z.string().optional(),
})
const PageTitleEventSchema = z.object({ title: z.string() })
const LoadFailureEventSchema = z.object({
  errorCode: z.number().optional(),
  errorDescription: z.string().optional(),
  isMainFrame: z.boolean().optional(),
})
const RendererGoneEventSchema = z.object({
  details: z.object({ reason: z.string().optional() }).optional(),
})

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
  const readyGuest = useRef<BrowserGuest | null>(null)
  const lastNavigationRequest = useRef<string | undefined>(undefined)
  const [guestReadyRevision, setGuestReadyRevision] = useState(0)
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

    const view = document.createElement('webview')
    view.className = 'workspace-browser__guest'
    view.setAttribute('aria-label', 'Browser page')
    view.setAttribute('partition', 'persist:harness-browser')
    view.setAttribute(
      'webpreferences',
      'contextIsolation=yes, nodeIntegration=no, sandbox=yes, spellcheck=no',
    )
    view.setAttribute('src', 'about:blank')

    const onAttach = () => syncGuestState()
    const onReady = () => {
      if (guest.current !== view) return
      readyGuest.current = view
      setGuestReadyRevision((revision) => revision + 1)
      syncGuestState()
    }
    const onStart = () => {
      setError(undefined)
      setState((current) => ({ ...current, loading: true }))
    }
    const onStop = () => syncGuestState()
    const onNavigate = (event: Event) => {
      const navigation = NavigationEventSchema.safeParse(event)
      const url = webPageUrl(navigation.success ? navigation.data.url : undefined)
      if (url) {
        setAddress(url)
        setState((current) => ({ ...current, url }))
      }
      syncGuestState()
    }
    const onNavigateInPage = (event: Event) => {
      const navigation = NavigationEventSchema.safeParse(event)
      if (!navigation.success || navigation.data.isMainFrame !== false) onNavigate(event)
    }
    const onTitle = (event: Event) => {
      const title = PageTitleEventSchema.safeParse(event)
      if (title.success) setState((current) => ({ ...current, title: title.data.title }))
    }
    const onFail = (event: Event) => {
      const failure = LoadFailureEventSchema.safeParse(event)
      if (failure.success && failure.data.isMainFrame !== false && failure.data.errorCode !== -3) {
        setError(failure.data.errorDescription || 'The page could not be loaded.')
      }
      syncGuestState()
    }
    const onRendererGone = (event: Event) => {
      const stopped = RendererGoneEventSchema.safeParse(event)
      const reason = stopped.success ? stopped.data.details?.reason : undefined
      setError(`Page renderer stopped${reason ? `: ${reason}` : '.'}`)
      syncGuestState()
    }

    view.addEventListener('did-attach', onAttach)
    view.addEventListener('dom-ready', onReady)
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
      readyGuest.current = null
      lastNavigationRequest.current = undefined
      view.removeEventListener('did-attach', onAttach)
      view.removeEventListener('dom-ready', onReady)
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
      if (!view || typeof view.loadURL !== 'function' || readyGuest.current !== view) {
        setError(
          view && typeof view.loadURL === 'function'
            ? 'The in-app browser is still starting.'
            : 'The in-app browser is unavailable in this window.',
        )
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
    if (!guest.current || readyGuest.current !== guest.current) return
    if (navigate(navigation.url)) lastNavigationRequest.current = navigation.requestId
  }, [guestReadyRevision, navigate, navigation])

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
          <IconMorph active={state.loading ? 1 : 0}>
            <RefreshCw size={14} aria-hidden />
            <LoaderCircle className="spinner" size={15} aria-hidden />
          </IconMorph>
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
