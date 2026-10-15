import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
import { Skeleton, SkeletonLines, SkeletonStatus } from '../Skeleton.js'
import { WorkspaceEmptyState } from './WorkspaceEmptyState.js'
import {
  browserLoadFailureView,
  loadRejectionFailure,
  type BrowserLoadFailureView,
} from './browser-load-error.js'
import type { BrowserPageInfo } from './browser-page.js'
import { browserAddress } from './browser-url.js'
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
  validatedURL: z.string().optional(),
})
const RendererGoneEventSchema = z.object({
  details: z.object({ reason: z.string().optional() }).optional(),
})

const EMPTY_STATE: BrowserState = {
  url: '',
  title: '',
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
  focusAddressOnOpen,
  tabId,
  onPageInfo,
}: {
  active: boolean
  navigation?: BrowserNavigationRequest | undefined
  /** The user opened this tab to type a URL: focus the address once it mounts. */
  focusAddressOnOpen?: boolean | undefined
  /** Passed back to onPageInfo, so one stable owner callback serves every tab. */
  tabId?: string | undefined
  /** The page's URL and title whenever either changes, for the tab label. */
  onPageInfo?: ((tabId: string, page: BrowserPageInfo) => void) | undefined
}) {
  const canvas = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const guest = useRef<BrowserGuest | null>(null)
  const readyGuest = useRef<BrowserGuest | null>(null)
  const lastNavigationRequest = useRef<string | undefined>(undefined)
  // Page navigation must not overwrite an address the user is still typing.
  const editingAddress = useRef(false)
  // A load that fails before it commits leaves the guest on the previous page;
  // the address keeps the one that failed so the user can correct it.
  const failedAddress = useRef<string | undefined>(undefined)
  // did-fail-load already explained this navigation; its loadURL rejection repeats it.
  const failureReported = useRef(false)
  // Stop cancels the load on purpose: its failure is not an error to show.
  const stopRequested = useRef(false)
  const navigationSequence = useRef(0)
  const [guestReadyRevision, setGuestReadyRevision] = useState(0)
  const [address, setAddress] = useState('')
  const [state, setState] = useState<BrowserState>(EMPTY_STATE)
  const [hasRenderedPage, setHasRenderedPage] = useState(false)
  const [viewport, setViewport] = useState<BrowserViewportId>('fluid')
  // A notice about the toolbar: an address it refused, a native call that failed.
  const [error, setError] = useState<string>()
  // A page that failed to load or stopped; the canvas shows it instead of the guest.
  const [failure, setFailure] = useState<BrowserLoadFailureView>()
  const addressInput = useRef<HTMLInputElement>(null)
  const focusedOnOpen = useRef(false)
  // An address entered before the guest finished starting, loaded once it has.
  const pendingAddress = useRef<string | undefined>(undefined)

  // After any menu that opened the tab has handed focus back, which happens
  // earlier in the same commit, so a typed URL lands in the address.
  useLayoutEffect(() => {
    if (!focusAddressOnOpen || focusedOnOpen.current) return
    focusedOnOpen.current = true
    addressInput.current?.focus()
  }, [focusAddressOnOpen])

  // Read through a ref: the report below runs when the page changes, never
  // because the owner handed over a new function (#283).
  const pageInfoListener = useRef(onPageInfo)
  pageInfoListener.current = onPageInfo

  useEffect(() => {
    if (tabId === undefined) return
    pageInfoListener.current?.(tabId, { url: state.url, title: state.url ? state.title : '' })
  }, [tabId, state.url, state.title])

  const syncGuestState = useCallback((pageReady = false) => {
    const view = guest.current
    if (!view) return
    try {
      const currentUrl = webPageUrl(view.getURL())
      setState({
        url: currentUrl,
        title: view.getTitle(),
        loading: view.isLoading(),
        canGoBack: view.canGoBack(),
        canGoForward: view.canGoForward(),
      })
      const shownAddress = failedAddress.current ?? currentUrl
      if (shownAddress && !editingAddress.current) setAddress(shownAddress)
      if (currentUrl && pageReady) setHasRenderedPage(true)
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
      syncGuestState(true)
    }
    const onStart = () => {
      stopRequested.current = false
      setError(undefined)
      setFailure(undefined)
      setState((current) => ({ ...current, loading: true }))
    }
    const onStop = () => syncGuestState(true)
    const onNavigate = (event: Event) => {
      const navigation = NavigationEventSchema.safeParse(event)
      const url = webPageUrl(navigation.success ? navigation.data.url : undefined)
      if (url) {
        failedAddress.current = undefined
        if (!editingAddress.current) setAddress(url)
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
      if (failure.success && failure.data.isMainFrame !== false && !stopRequested.current) {
        const url = webPageUrl(failure.data.validatedURL)
        const failedView = browserLoadFailureView({
          code: failure.data.errorCode,
          name: failure.data.errorDescription,
          url,
        })
        if (failedView) {
          failureReported.current = true
          if (url) failedAddress.current = url
          setFailure(failedView)
        }
      }
      syncGuestState()
    }
    const onRendererGone = (event: Event) => {
      const stopped = RendererGoneEventSchema.safeParse(event)
      const reason = stopped.success ? stopped.data.details?.reason : undefined
      setFailure({
        title: 'This page stopped',
        detail: `Its renderer ended${reason ? ` (${reason})` : ''}. Retry to load it again.`,
      })
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
      const { url, error: invalid } = browserAddress(value)
      if (!url) {
        setError(invalid)
        return false
      }
      const view = guest.current
      if (!view || typeof view.loadURL !== 'function') {
        setError('The in-app browser is unavailable in this window.')
        return false
      }
      if (readyGuest.current !== view) {
        // Typed into a tab that opened a moment ago: load it as soon as the guest is ready.
        pendingAddress.current = url
        editingAddress.current = false
        setAddress(url)
        setError(undefined)
        return true
      }
      pendingAddress.current = undefined

      editingAddress.current = false
      failedAddress.current = undefined
      failureReported.current = false
      stopRequested.current = false
      const sequence = ++navigationSequence.current
      setAddress(url)
      setState((current) => ({ ...current, url, loading: true }))
      setError(undefined)
      setFailure(undefined)
      void view.loadURL(url).catch((cause: unknown) => {
        // A newer navigation replaced this one and reports for itself.
        if (sequence !== navigationSequence.current) return
        if (!failureReported.current && !stopRequested.current) {
          const failedView = browserLoadFailureView(loadRejectionFailure(cause, url))
          if (failedView) {
            failedAddress.current = url
            setFailure(failedView)
          }
        }
        syncGuestState()
      })
      return true
    },
    [syncGuestState],
  )

  useLayoutEffect(() => {
    const pending = pendingAddress.current
    if (!pending || !guest.current || readyGuest.current !== guest.current) return
    navigate(pending)
  }, [guestReadyRevision, navigate])

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
      // Reload retries the address that failed, not the page still shown under it.
      else if (nextAction === 'reload' && failedAddress.current) {
        navigate(failedAddress.current)
        return
      } else if (nextAction === 'reload' && state.url) view.reload()
      else if (nextAction === 'stop') {
        stopRequested.current = true
        failedAddress.current = undefined
        view.stop()
      }
      syncGuestState()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const editAddress = () => {
    const input = addressInput.current
    if (!input) return
    input.focus()
    input.select()
  }

  const loadingFirstPage = Boolean(state.url) && state.loading && !hasRenderedPage && !failure
  // Later loads keep the current page visible under a thin progress line.
  const loadingLaterPage = state.loading && hasRenderedPage && !failure

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
            ref={addressInput}
            value={address}
            placeholder="Enter a URL"
            aria-label="Browser address"
            spellCheck={false}
            onChange={(event) => {
              editingAddress.current = true
              setAddress(event.target.value)
            }}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => {
              editingAddress.current = false
            }}
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

      <div
        ref={canvas}
        className="workspace-browser__canvas"
        data-viewport={viewport}
        aria-busy={state.loading && !failure}
      >
        {loadingLaterPage ? <div className="workspace-browser__progress" aria-hidden /> : null}
        <div
          ref={host}
          className="workspace-browser__guest-host"
          data-visible={Boolean(state.url) && !failure}
          aria-hidden={!active}
        >
          {loadingFirstPage ? (
            <SkeletonStatus label="Loading page…" className="workspace-browser__skeleton">
              <div className="workspace-browser__skeleton-header">
                <Skeleton width={72} height={11} />
                <Skeleton width="26%" height={9} />
              </div>
              <div className="workspace-browser__skeleton-body">
                <Skeleton width="58%" height={18} />
                <SkeletonLines lines={3} widths={['94%', '88%', '64%']} />
                <Skeleton className="skeleton--block workspace-browser__skeleton-media" />
                <SkeletonLines lines={2} widths={['90%', '72%']} />
              </div>
            </SkeletonStatus>
          ) : null}
        </div>
        {failure ? (
          <div className="workspace-browser__failure" role="alert">
            <WorkspaceEmptyState
              kind="browser-failed"
              title={failure.title}
              detail={failure.detail}
            >
              <div className="workspace-browser__failure-actions">
                <button type="button" className="btn" onClick={() => action('reload')}>
                  Retry
                </button>
                <button type="button" className="ghost" onClick={editAddress}>
                  Edit address
                </button>
              </div>
            </WorkspaceEmptyState>
          </div>
        ) : !state.url ? (
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
