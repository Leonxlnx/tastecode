import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import {
  IconArrowLeft as ArrowLeft,
  IconFileDiff as FileDiff,
  IconFolderOpen as FolderOpen,
  IconWorld as Globe2,
  IconMessageCirclePlus as MessageCirclePlus,
  IconTerminal2 as SquareTerminal,
  IconX as X,
  IconPlus as Plus,
  type TablerIcon,
} from '@tabler/icons-react'
import type { PullRequestTarget } from '@harness/contracts'
import { performAppHaptic, prepareAppHaptics } from '../../haptics.js'
import { cancelInstall, installState, subscribeInstalls } from '../../provider-install.js'
import type { Transport } from '../../transport.js'
import { beginPanelResize, settlePanelSize } from '../panel-resize.js'
import type {
  SideChatParentStatus,
  SideChatPromptRequest,
  SideChatStartOptions,
} from './WorkspaceSideChat.js'
import type { BrowserNavigationRequest } from './WorkspaceBrowser.js'
import { browserPageLabel, type BrowserPageInfo } from './browser-page.js'
import { WorkspaceTabs } from './WorkspaceTabs.js'
import {
  DEFAULT_BOTTOM_PANEL_HEIGHT,
  DEFAULT_WORKSPACE_PANEL_WIDTH,
  MIN_WORKSPACE_PANEL_WIDTH,
} from './workspace-panel-width.js'
import { Menu, MenuItem } from '../Menu.js'
import { RowIssue } from '../RowIssue.js'
import { Skeleton, SkeletonRows, SkeletonStatus } from '../Skeleton.js'
import '../workspace-panel.css'

/** --dur-slow: the panel's own opacity and slide (workspace-panel.css). */
const PANEL_LEAVE_MS = 260

const WorkspaceReview = lazy(() =>
  import('./WorkspaceReview.js').then((module) => ({ default: module.WorkspaceReview })),
)
const WorkspaceTerminal = lazy(() =>
  import('./WorkspaceTerminal.js').then((module) => ({ default: module.WorkspaceTerminal })),
)
const AttachedProviderTerminal = lazy(() =>
  import('../InstallTerminal.js').then((module) => ({ default: module.InstallTerminal })),
)
const WorkspaceBrowser = lazy(() =>
  import('./WorkspaceBrowser.js').then((module) => ({ default: module.WorkspaceBrowser })),
)
const WorkspaceFiles = lazy(() =>
  import('./WorkspaceFiles.js').then((module) => ({ default: module.WorkspaceFiles })),
)
const WorkspaceSideChat = lazy(() =>
  import('./WorkspaceSideChat.js').then((module) => ({ default: module.WorkspaceSideChat })),
)

export type WorkspaceProviderLoginRequest = {
  id: number
  title: string
  installKey: string
  canCancelSignIn?: boolean
}

export type WorkspaceTool = 'review' | 'terminal' | 'browser' | 'files' | 'side-chat'

type WorkspaceTab =
  | {
      id: string
      kind: WorkspaceTool
      /** Opened by the user, not restored or opened for them: take focus. */
      userOpened?: boolean
    }
  | {
      id: string
      kind: 'provider-login'
      requestId: number
      title: string
      installKey: string
      canCancelSignIn: boolean
    }

const TOOLS: Array<{
  kind: WorkspaceTool
  title: string
  Icon: TablerIcon
}> = [
  {
    kind: 'review',
    title: 'Review',
    Icon: FileDiff,
  },
  {
    kind: 'terminal',
    title: 'Terminal',
    Icon: SquareTerminal,
  },
  {
    kind: 'browser',
    title: 'Browser',
    Icon: Globe2,
  },
  {
    kind: 'files',
    title: 'Files',
    Icon: FolderOpen,
  },
  {
    kind: 'side-chat',
    title: 'Temporary chat',
    Icon: MessageCirclePlus,
  },
]

const MIN_CHAT_WIDTH = 360
const DESIGN_PREVIEW_TAB_ID = 'design-preview'

function WorkspacePanelComponent(props: {
  placement?: 'right' | 'bottom'
  open: boolean
  expanded: boolean
  width: number
  transport: Transport
  threadId?: string | undefined
  projectPath?: string | undefined
  projectName?: string | undefined
  branch?: string | undefined
  theme: 'light' | 'dark'
  sideChatParentStatus: SideChatParentStatus
  sideChatStartOptions: SideChatStartOptions
  sideChatPromptRequest?: SideChatPromptRequest | undefined
  nativeSurfacesVisible: boolean
  onOpen: () => void
  onClose: () => void
  onWidthChange: (width: number) => void
  terminalToggleRequest?: number | undefined
  providerLogin?: WorkspaceProviderLoginRequest | undefined
  onProviderLoginClose?: ((id: number) => void) | undefined
  externalToolRequest?: { request: number; kind: WorkspaceTool } | undefined
  designPreviewRequest?: BrowserNavigationRequest | undefined
  /** Opens the Pull requests surface on the pull request the Review tab shows. */
  onOpenPullRequest?: ((target: PullRequestTarget) => void) | undefined
}) {
  const bottom = props.placement === 'bottom'
  const [tabs, setTabs] = useState<WorkspaceTab[]>([])
  const [activeId, setActiveId] = useState<string>()
  const tool = tabs.find((tab) => tab.id === activeId) ?? tabs.at(-1)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const showTool = useCallback((next: WorkspaceTab) => {
    setTabs((current) => [...current.filter((tab) => tab.id !== next.id), next])
    setActiveId(next.id)
  }, [])
  // Each Browser tab's page, keyed by tab id, so two tabs never both read "Browser".
  const [browserPages, setBrowserPages] = useState<ReadonlyMap<string, BrowserPageInfo>>(
    () => new Map(),
  )
  const updateBrowserPage = useCallback((id: string, page: BrowserPageInfo) => {
    setBrowserPages((current) => {
      const previous = current.get(id)
      if (previous?.url === page.url && previous.title === page.title) return current
      return new Map(current).set(id, page)
    })
  }, [])
  const forgetBrowserPage = useCallback((id: string) => {
    setBrowserPages((current) => {
      if (!current.has(id)) return current
      const next = new Map(current)
      next.delete(id)
      return next
    })
  }, [])
  const tabLabels = useMemo(() => {
    let terminalNumber = 0
    return tabs.map((tab) => {
      const definition = TOOLS.find((item) => item.kind === tab.kind) ?? TOOLS[1]!
      const Icon = definition.Icon
      if (tab.kind === 'browser') {
        const page = browserPages.get(tab.id)
        const title = browserPageLabel(page)
        return {
          id: tab.id,
          title,
          icon: <Icon size={14} aria-hidden />,
          tooltip: page?.url || title,
          accessibleName: `Browser: ${title}`,
        }
      }
      const title =
        tab.kind === 'provider-login'
          ? tab.title
          : tab.kind === 'terminal'
            ? `Terminal ${++terminalNumber}`
            : definition.title
      return { id: tab.id, title, icon: <Icon size={14} aria-hidden /> }
    })
  }, [tabs, browserPages])
  // Surfaces keep an order no tab move changes; React moving an iframe or webview reloads it.
  const surfaces = useMemo(() => [...tabs].sort((a, b) => (a.id < b.id ? -1 : 1)), [tabs])
  const [designPreview, setDesignPreview] = useState<BrowserNavigationRequest>()
  const toolRef = useRef(tool)
  const panelElement = useRef<HTMLElement>(null)
  const resizeCleanup = useRef<() => void>(() => {})
  const handledTerminalRequest = useRef(0)
  const handledExternalRequest = useRef(0)
  const handledPreviewRequest = useRef<string | undefined>(undefined)
  toolRef.current = tool

  // A Browser tab the user just opened, whose surface may still be loading.
  const focusNewBrowserTab = useRef<string | undefined>(undefined)
  const openTool = useCallback(
    (kind: WorkspaceTool) => {
      const id = ['terminal', 'browser', 'files'].includes(kind) ? crypto.randomUUID() : kind
      if (kind === 'browser') focusNewBrowserTab.current = id
      showTool({ id, kind, userOpened: true })
      props.onOpen()
    },
    [props.onOpen, showTool],
  )
  // The first Browser tab loads its module lazily, which can take a moment.
  // Until its address can take focus, park focus on the new tab so a URL typed
  // meanwhile cannot land in the chat composer and be sent as a message. A
  // surface that already mounted has focused its address; leave that alone.
  // Runs after children, so after the Browser's own focus and any menu's.
  useLayoutEffect(() => {
    const id = focusNewBrowserTab.current
    if (!id) return
    focusNewBrowserTab.current = undefined
    const panel = panelElement.current
    if (
      panel
        ?.querySelector('.workspace-panel__surface:not([hidden])')
        ?.contains(document.activeElement)
    )
      return
    const tab = Array.from(panel?.querySelectorAll<HTMLElement>('[data-tab-motion-id]') ?? []).find(
      (element) => element.dataset['tabMotionId'] === id,
    )
    tab?.querySelector<HTMLElement>('[role="tab"]')?.focus()
  })

  const closeTool = useCallback(() => {
    const current = tabsRef.current
    setTabs([])
    setActiveId(undefined)
    setBrowserPages(new Map())
    for (const tab of current) {
      if (tab.kind === 'provider-login') props.onProviderLoginClose?.(tab.requestId)
    }
    props.onClose()
  }, [props.onClose, props.onProviderLoginClose])

  // The right panel's X hides it like the layout toggle: every tab, browser
  // page and running terminal stays mounted and comes back on the next open.
  // A provider login is not one of the user's tabs; its owner closes it, and
  // the sign-in keeps running without it.
  const hidePanel = useCallback(() => {
    const hadFocus = Boolean(panelElement.current?.contains(document.activeElement))
    for (const tab of tabsRef.current) {
      if (tab.kind === 'provider-login') props.onProviderLoginClose?.(tab.requestId)
    }
    props.onClose()
    // The hidden panel turns inert, which would drop focus to the page. Hand
    // it to the toggle that brings the panel back.
    if (hadFocus) document.querySelector<HTMLElement>('.panel-toggles__workspace')?.focus()
  }, [props.onClose, props.onProviderLoginClose])

  const closeTab = useCallback(
    (id: string) => {
      const current = tabsRef.current.find((tab) => tab.id === id)
      if (!current) return
      const remaining = tabsRef.current.filter((tab) => tab.id !== id)
      setTabs(remaining)
      forgetBrowserPage(id)
      if (current?.kind === 'provider-login') props.onProviderLoginClose?.(current.requestId)
      else if (!remaining.length) props.onClose()
    },
    [forgetBrowserPage, props.onClose, props.onProviderLoginClose],
  )

  // Ctrl+W in a Browser tab removes the surface that had focus. Hand focus to
  // the tab shown next, as a tab's own X does, or to the toggle that reopens
  // the panel when that was the last tab.
  const focusAfterShortcutClose = useRef(false)
  const closeTabByShortcut = useCallback(
    (id: string) => {
      focusAfterShortcutClose.current = true
      closeTab(id)
    },
    [closeTab],
  )
  useLayoutEffect(() => {
    if (!focusAfterShortcutClose.current) return
    focusAfterShortcutClose.current = false
    const next = panelElement.current?.querySelector<HTMLElement>(
      '.workspace-tabs__tab.is-active [role="tab"]',
    )
    if (next) next.focus()
    else
      document
        .querySelector<HTMLElement>(
          bottom ? '.panel-toggles__terminal' : '.panel-toggles__workspace',
        )
        ?.focus()
  })

  useEffect(() => {
    const request = props.terminalToggleRequest ?? 0
    if (!request || request === handledTerminalRequest.current) return
    handledTerminalRequest.current = request
    if (props.open && toolRef.current?.kind === 'terminal') props.onClose()
    else {
      const terminal = tabsRef.current.find((tab) => tab.kind === 'terminal')
      if (terminal) {
        setActiveId(terminal.id)
        props.onOpen()
      } else openTool('terminal')
    }
  }, [openTool, props.open, props.onClose, props.terminalToggleRequest])

  useEffect(() => {
    const request = props.externalToolRequest
    if (!request || request.request === handledExternalRequest.current) return
    handledExternalRequest.current = request.request
    openTool(request.kind)
  }, [openTool, props.externalToolRequest])

  useEffect(() => {
    if (props.sideChatPromptRequest) openTool('side-chat')
  }, [openTool, props.sideChatPromptRequest])

  useEffect(() => {
    const request = props.providerLogin
    if (!request) {
      setTabs((current) => current.filter((tab) => tab.kind !== 'provider-login'))
      return
    }
    showTool({
      id: `provider-login-${request.id}`,
      kind: 'provider-login',
      requestId: request.id,
      title: request.title,
      installKey: request.installKey,
      canCancelSignIn: request.canCancelSignIn !== false,
    })
    props.onOpen()
  }, [
    showTool,
    props.onOpen,
    props.providerLogin?.id,
    props.providerLogin?.title,
    props.providerLogin?.installKey,
    props.providerLogin?.canCancelSignIn,
  ])

  useEffect(() => {
    const request = props.designPreviewRequest
    if (!request || request.requestId === handledPreviewRequest.current) return
    handledPreviewRequest.current = request.requestId
    setDesignPreview(request)
    showTool({ id: DESIGN_PREVIEW_TAB_ID, kind: 'browser' })
    props.onOpen()
  }, [props.designPreviewRequest, props.onOpen, showTool])

  useEffect(() => () => resizeCleanup.current(), [])

  // Hiding the right panel takes its grid column away in the same frame, so
  // the panel vanished with it and its fade-out was never seen. For the length
  // of that fade it now leaves over the chat at its last open width, while the
  // chat underneath already has its width back.
  const openWidth = useRef(0)
  const wasOpen = useRef(props.open)
  // Edge drags and window resizes while open keep the width current.
  useEffect(() => {
    const panel = panelElement.current
    if (bottom || !props.open || !panel || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!panel.classList.contains('is-open')) return
      const width = panel.getBoundingClientRect().width
      if (width > 0) openWidth.current = width
    })
    observer.observe(panel)
    return () => observer.disconnect()
  }, [bottom, props.open])
  useLayoutEffect(() => {
    const panel = panelElement.current
    const closing = wasOpen.current && !props.open
    wasOpen.current = props.open
    if (!panel || bottom) return
    // Measured here as well as by the observer: a panel hidden before the
    // browser rendered a frame of it open would otherwise have no width yet.
    // The layout this reads is the one the open has to compute anyway.
    if (props.open) {
      const width = panel.getBoundingClientRect().width
      if (width > 0) openWidth.current = width
    }
    const settle = () => {
      panel.removeAttribute('data-leaving')
      panel.style.removeProperty('--workspace-panel-leave-w')
    }
    settle()
    if (!closing || openWidth.current <= 0) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    panel.style.setProperty('--workspace-panel-leave-w', `${openWidth.current}px`)
    panel.setAttribute('data-leaving', '')
    const leave = window.setTimeout(settle, PANEL_LEAVE_MS)
    return () => window.clearTimeout(leave)
  }, [bottom, props.open])

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    if (props.expanded) return
    event.preventDefault()
    prepareAppHaptics()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeCleanup.current()
    const layout = event.currentTarget.closest<HTMLElement>(
      bottom ? '.bottom-terminal' : '.workspace-layout',
    )
    const previousTransition = layout?.style.transition
    if (layout) layout.style.transition = 'none'
    const bounds = panelSizeBounds(layout, bottom)
    resizeCleanup.current = beginPanelResize(event, {
      axis: bottom ? 'clientY' : 'clientX',
      initialSize: props.width,
      minSize: bounds.min,
      maxSize: bounds.max,
      style: layout?.style,
      property: bottom ? 'height' : '--workspace-panel-w',
      onFinish: (size, commit) => {
        resizeCleanup.current = () => {}
        if (commit) props.onWidthChange(size)
        else
          layout?.style.setProperty(bottom ? 'height' : '--workspace-panel-w', `${props.width}px`)
        if (layout) layout.style.transition = previousTransition ?? ''
      },
    })
  }

  const hostOf = (handle: HTMLElement) =>
    handle.closest<HTMLElement>(bottom ? '.bottom-terminal' : '.workspace-layout')

  // Double-clicking the edge restores the default size, as split views in
  // editors do. It eases there from the size drawn now, which is smaller than
  // the saved one when the window clamps the panel.
  const resetSize = (handle: HTMLElement) => {
    if (props.expanded) return
    resizeCleanup.current()
    const target = bottom ? DEFAULT_BOTTOM_PANEL_HEIGHT : DEFAULT_WORKSPACE_PANEL_WIDTH
    const layout = hostOf(handle)
    const drawn = bottom
      ? layout?.getBoundingClientRect().height
      : panelElement.current?.getBoundingClientRect().width
    performAppHaptic('alignment')
    resizeCleanup.current = settlePanelSize({
      from: drawn || props.width,
      to: target,
      style: layout?.style,
      property: bottom ? 'height' : '--workspace-panel-w',
      onFinish: () => {
        resizeCleanup.current = () => {}
        props.onWidthChange(target)
      },
    })
  }

  // The edge also takes focus, so the panel can be sized without a pointer:
  // Left and Right (Up and Down at the bottom) step 16px, 64px with Shift,
  // Home and End go to the limits and Enter restores the default size.
  const [sizeLimit, setSizeLimit] = useState<number>()
  const resizeByKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (props.expanded || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'Enter') {
      event.preventDefault()
      resetSize(event.currentTarget)
      return
    }
    const layout = hostOf(event.currentTarget)
    const bounds = panelSizeBounds(layout, bottom)
    const current = Math.min(bounds.max, Math.max(bounds.min, props.width))
    const step = event.shiftKey ? 64 : 16
    const next =
      event.key === (bottom ? 'ArrowUp' : 'ArrowLeft')
        ? current + step
        : event.key === (bottom ? 'ArrowDown' : 'ArrowRight')
          ? current - step
          : event.key === 'Home'
            ? bounds.min
            : event.key === 'End'
              ? bounds.max
              : undefined
    if (next === undefined) return
    event.preventDefault()
    resizeCleanup.current()
    setSizeLimit(bounds.max)
    const size = Math.round(Math.min(bounds.max, Math.max(bounds.min, next)))
    layout?.style.setProperty(bottom ? 'height' : '--workspace-panel-w', `${size}px`)
    props.onWidthChange(size)
  }
  const sizeNow = Math.round(sizeLimit ? Math.min(sizeLimit, props.width) : props.width)

  return (
    <aside
      ref={panelElement}
      className={`workspace-panel${tool ? ' has-tool' : ''}${bottom ? ' workspace-panel--bottom' : ''}${props.open ? ' is-open' : ''}${props.expanded ? ' is-expanded' : ''}`}
      aria-label={bottom ? 'Bottom workspace tools' : 'Workspace tools'}
      aria-hidden={!props.open}
      inert={props.open ? undefined : true}
    >
      <div
        className="workspace-panel__resize"
        role="separator"
        aria-label={bottom ? 'Resize bottom workspace tools' : 'Resize workspace tools'}
        aria-orientation={bottom ? 'horizontal' : 'vertical'}
        aria-valuenow={sizeNow}
        aria-valuemin={panelSizeBounds(null, bottom).min}
        aria-valuemax={sizeLimit}
        aria-valuetext={`${sizeNow} pixels ${bottom ? 'tall' : 'wide'}`}
        tabIndex={props.expanded ? -1 : 0}
        onPointerEnter={() => {
          if (!props.expanded) prepareAppHaptics()
        }}
        onPointerDown={beginResize}
        onDoubleClick={(event) => resetSize(event.currentTarget)}
        onFocus={(event) => setSizeLimit(panelSizeBounds(hostOf(event.currentTarget), bottom).max)}
        onKeyDown={resizeByKey}
      />
      <button
        type="button"
        className="workspace-panel__close"
        aria-label={bottom ? 'Close bottom panel' : 'Hide right panel'}
        title={bottom ? undefined : 'Hide panel'}
        onClick={bottom ? closeTool : hidePanel}
      >
        <X size={16} aria-hidden />
      </button>
      {bottom ? null : (
        // Shown only in the narrow layout, where the open panel covers the chat.
        <button type="button" className="workspace-panel__back" onClick={hidePanel}>
          <ArrowLeft size={14} aria-hidden />
          <span>Back to chat</span>
        </button>
      )}
      <WorkspaceTabs
        tabs={tabLabels}
        activeId={tool?.id}
        onSelect={setActiveId}
        onClose={closeTab}
        onReorder={(sourceId, targetId) =>
          setTabs((current) => {
            const source = current.findIndex((tab) => tab.id === sourceId)
            const target = current.findIndex((tab) => tab.id === targetId)
            if (source < 0 || target < 0 || source === target) return current
            const next = [...current]
            const [moved] = next.splice(source, 1)
            next.splice(target, 0, moved!)
            return next
          })
        }
      >
        <Menu
          label="Add workspace tab"
          drop={bottom ? 'up' : 'down'}
          align="left"
          triggerClassName="workspace-tabs__add-button"
          trigger={() => <Plus size={16} aria-hidden />}
        >
          {(close) => (
            <>
              {TOOLS.map((item) => (
                <MenuItem
                  key={item.kind}
                  title={item.title}
                  icon={<item.Icon size={15} aria-hidden />}
                  onClick={() => {
                    close()
                    openTool(item.kind)
                  }}
                />
              ))}
            </>
          )}
        </Menu>
        {tool?.kind === 'provider-login' && tool.canCancelSignIn ? (
          <ProviderLoginCancel transport={props.transport} installKey={tool.installKey} />
        ) : null}
      </WorkspaceTabs>
      <div className="workspace-panel__body">
        {surfaces.length ? (
          surfaces.map((tab) => (
            <div className="workspace-panel__surface" key={tab.id} hidden={tab.id !== tool?.id}>
              <Suspense fallback={<WorkspaceLoading />}>
                <WorkspaceToolSurface
                  tab={tab}
                  active={props.open && props.nativeSurfacesVisible && tab.id === tool?.id}
                  transport={props.transport}
                  threadId={props.threadId}
                  projectPath={props.projectPath}
                  projectName={props.projectName}
                  branch={props.branch}
                  theme={props.theme}
                  sideChatParentStatus={props.sideChatParentStatus}
                  sideChatStartOptions={props.sideChatStartOptions}
                  sideChatPromptRequest={props.sideChatPromptRequest}
                  onOpenPullRequest={props.onOpenPullRequest}
                  browserNavigation={tab.id === DESIGN_PREVIEW_TAB_ID ? designPreview : undefined}
                  onBrowserPage={updateBrowserPage}
                  onCloseTab={closeTabByShortcut}
                  onClose={() => closeTab(tab.id)}
                />
              </Suspense>
            </div>
          ))
        ) : (
          <WorkspaceSelector onOpen={openTool} />
        )}
      </div>
    </aside>
  )
}

/** The sizes a panel can take inside its host right now: the chat keeps its minimum width. */
function panelSizeBounds(layout: HTMLElement | null, bottom: boolean) {
  if (bottom) {
    return {
      min: 200,
      max: Math.max(200, (layout?.parentElement?.clientHeight || window.innerHeight) - 80),
    }
  }
  return {
    min: MIN_WORKSPACE_PANEL_WIDTH,
    max: Math.max(
      MIN_WORKSPACE_PANEL_WIDTH,
      (layout?.clientWidth || window.innerWidth) - MIN_CHAT_WIDTH,
    ),
  }
}

/** Keep the closed host subscribed without reconciling its full shell on unrelated app updates. */
export const WorkspacePanel = memo(WorkspacePanelComponent)

function WorkspaceToolSurface(props: {
  tab: WorkspaceTab
  active: boolean
  transport: Transport
  threadId?: string | undefined
  projectPath?: string | undefined
  projectName?: string | undefined
  branch?: string | undefined
  theme: 'light' | 'dark'
  sideChatParentStatus: SideChatParentStatus
  sideChatStartOptions: SideChatStartOptions
  sideChatPromptRequest?: SideChatPromptRequest | undefined
  onOpenPullRequest?: ((target: PullRequestTarget) => void) | undefined
  browserNavigation?: BrowserNavigationRequest | undefined
  onBrowserPage: (tabId: string, page: BrowserPageInfo) => void
  /** Ctrl+W in a Browser tab. Stable, so a memoized Browser surface keeps its props. */
  onCloseTab: (tabId: string) => void
  onClose: () => void
}) {
  if (props.tab.kind === 'provider-login') {
    return (
      <div className="workspace-provider-login">
        <AttachedProviderTerminal
          transport={props.transport}
          installKey={props.tab.installKey}
          ariaLabel={`${props.tab.title} terminal`}
          profile="workspace"
        />
      </div>
    )
  }
  if (props.tab.kind === 'review') {
    return (
      <WorkspaceReview
        transport={props.transport}
        projectPath={props.projectPath}
        threadId={props.threadId}
        branch={props.branch}
        theme={props.theme}
        turnRunning={
          props.sideChatParentStatus !== 'idle' && props.sideChatParentStatus !== 'failed'
        }
        visible={props.active}
        onOpenPullRequest={props.onOpenPullRequest}
      />
    )
  }
  if (props.tab.kind === 'terminal') {
    return (
      <WorkspaceTerminal
        terminalKey={props.tab.id}
        active={props.active}
        transport={props.transport}
        threadId={props.threadId}
        projectPath={props.projectPath}
        onClose={props.onClose}
      />
    )
  }
  if (props.tab.kind === 'browser') {
    return (
      <WorkspaceBrowser
        active={props.active}
        navigation={props.browserNavigation}
        focusAddressOnOpen={props.tab.userOpened}
        tabId={props.tab.id}
        onPageInfo={props.onBrowserPage}
        onClose={props.onCloseTab}
      />
    )
  }
  if (props.tab.kind === 'files') {
    return (
      <WorkspaceFiles
        transport={props.transport}
        projectPath={props.projectPath}
        projectName={props.projectName}
        threadId={props.threadId}
      />
    )
  }
  return (
    <WorkspaceSideChat
      active={props.active}
      projectName={props.projectName}
      parentThreadId={props.threadId}
      parentStatus={props.sideChatParentStatus}
      transport={props.transport}
      startOptions={props.sideChatStartOptions}
      promptRequest={props.sideChatPromptRequest}
    />
  )
}

function ProviderLoginCancel(props: { transport: Transport; installKey: string }) {
  const login = useSyncExternalStore(subscribeInstalls, () => installState(props.installKey))
  const [error, setError] = useState<string>()

  if (login?.phase !== 'running') return null

  const cancel = () => {
    setError(undefined)
    void cancelInstall(props.transport, props.installKey).catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    )
  }

  return (
    <div className="workspace-provider-login__actions">
      {error ? <RowIssue message={error} announce /> : null}
      <button type="button" disabled={login.canceling} onClick={cancel}>
        {login.canceling ? 'Canceling…' : 'Cancel sign-in'}
      </button>
    </div>
  )
}

function WorkspaceSelector({ onOpen }: { onOpen: (kind: WorkspaceTool) => void }) {
  return (
    <div className="workspace-selector">
      <div className="workspace-selector__list">
        {TOOLS.map((tool) => {
          const Icon = tool.Icon
          return (
            <button type="button" key={tool.kind} onClick={() => onOpen(tool.kind)}>
              <Icon size={16} aria-hidden />
              <span>{tool.title}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function WorkspaceLoading() {
  return (
    <SkeletonStatus label="Loading workspace tool" className="workspace-panel__loading">
      <div className="workspace-panel__loading-bar">
        <Skeleton className="skeleton--icon" />
        <Skeleton width={128} height={9} />
      </div>
      <SkeletonRows rows={7} icon detail density="tall" />
    </SkeletonStatus>
  )
}
