import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
  type PointerEvent,
} from 'react'
import {
  FileDiff,
  FolderOpen,
  Globe2,
  Maximize2,
  MessageCirclePlus,
  Minimize2,
  Plus,
  SquareTerminal,
  X,
  type LucideIcon,
} from 'lucide-react'
import { PreviewCaptureRequestSchema } from '@harness/contracts'
import {
  appHapticsEnabled,
  performAppHaptic,
  prepareAppHaptics,
  ResizeHaptics,
} from '../../haptics.js'
import type { Transport } from '../../transport.js'
import type {
  SideChatParentStatus,
  SideChatPromptRequest,
  SideChatStartOptions,
} from './WorkspaceSideChat.js'
import type { BrowserNavigationRequest } from './WorkspaceBrowser.js'
import '../workspace-panel.css'

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

export type WorkspacePanelHaptics = {
  enabled: typeof appHapticsEnabled
  perform: typeof performAppHaptic
  prepare: typeof prepareAppHaptics
}

export type WorkspacePanelTerminal = ComponentType<ComponentProps<typeof WorkspaceTerminal>>
export type WorkspacePanelProviderTerminal = ComponentType<
  ComponentProps<typeof AttachedProviderTerminal>
>

export type WorkspaceProviderLoginRequest = {
  id: number
  title: string
  installKey: string
}

const defaultWorkspacePanelHaptics: WorkspacePanelHaptics = {
  enabled: appHapticsEnabled,
  perform: performAppHaptic,
  prepare: prepareAppHaptics,
}

export type WorkspaceTool = 'review' | 'terminal' | 'browser' | 'files' | 'side-chat'

type WorkspaceTab =
  | { id: string; kind: WorkspaceTool }
  | {
      id: string
      kind: 'provider-login'
      requestId: number
      title: string
      installKey: string
    }

const TOOLS: Array<{
  kind: WorkspaceTool
  title: string
  Icon: LucideIcon
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

const MIN_PANEL_WIDTH = 360
const MIN_CHAT_WIDTH = 360
const DESIGN_PREVIEW_TAB_ID = 'design-preview'

export function WorkspacePanel(props: {
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
  onClosed?: () => void
  onExpandedChange: (expanded: boolean) => void
  onWidthChange: (width: number) => void
  haptics?: WorkspacePanelHaptics | undefined
  terminalComponent?: WorkspacePanelTerminal | undefined
  providerLogin?: WorkspaceProviderLoginRequest | undefined
  providerTerminalComponent?: WorkspacePanelProviderTerminal | undefined
  onProviderLoginClose?: ((id: number) => void) | undefined
}) {
  const hapticServices = props.haptics ?? defaultWorkspacePanelHaptics
  const [tabs, setTabs] = useState<WorkspaceTab[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [designPreview, setDesignPreview] = useState<BrowserNavigationRequest>()
  const [addOpen, setAddOpen] = useState(false)
  const addWrap = useRef<HTMLDivElement>(null)
  const resizeCleanup = useRef<() => void>(() => {})
  const tabsRef = useRef(tabs)
  const onClose = useRef(props.onClose)
  const onProviderLoginClose = useRef(props.onProviderLoginClose)
  const clearAfterClose = useRef(false)
  const providerLoginTabId = useRef<string | undefined>(undefined)
  const nextTabId = useRef(1)
  tabsRef.current = tabs
  onClose.current = props.onClose
  onProviderLoginClose.current = props.onProviderLoginClose

  const openTool = useCallback(
    (kind: WorkspaceTool) => {
      clearAfterClose.current = false
      props.onOpen()
      const repeatable = kind === 'browser' || kind === 'terminal' || kind === 'files'
      const id = repeatable ? `${kind}-${nextTabId.current++}` : kind
      setTabs((current) =>
        repeatable || !current.some((tab) => tab.kind === kind)
          ? [...current, { id, kind }]
          : current,
      )
      setActiveId(id)
      setAddOpen(false)
    },
    [props.onOpen],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      const key = event.key.toLowerCase()
      const kind =
        key === 'g' && event.shiftKey
          ? 'review'
          : key === 't' && !event.shiftKey
            ? 'browser'
            : key === 'p' && event.altKey && !event.shiftKey
              ? 'files'
              : key === 's' && event.altKey
                ? 'side-chat'
                : undefined
      if (!kind) return
      event.preventDefault()
      openTool(kind)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openTool])

  useEffect(() => {
    if (!props.sideChatPromptRequest) return
    openTool('side-chat')
  }, [openTool, props.sideChatPromptRequest])

  useEffect(() => {
    const request = props.providerLogin
    const previousId = providerLoginTabId.current
    if (!request) {
      if (!previousId) return
      const next = tabsRef.current.filter((tab) => tab.id !== previousId)
      tabsRef.current = next
      setTabs(next)
      setActiveId((current) => (current === previousId ? next.at(-1)?.id : current))
      providerLoginTabId.current = undefined
      return
    }

    const id = `provider-login-${request.id}`
    clearAfterClose.current = false
    props.onOpen()
    const next = [
      ...tabsRef.current.filter((tab) => tab.kind !== 'provider-login'),
      {
        id,
        kind: 'provider-login',
        requestId: request.id,
        title: request.title,
        installKey: request.installKey,
      } as const,
    ]
    tabsRef.current = next
    setTabs(next)
    setActiveId(id)
    setAddOpen(false)
    providerLoginTabId.current = id
  }, [
    props.onOpen,
    props.providerLogin?.id,
    props.providerLogin?.installKey,
    props.providerLogin?.title,
  ])

  useEffect(
    () =>
      props.transport.on('preview.captureRequested', (value) => {
        const request = PreviewCaptureRequestSchema.safeParse(value)
        if (!request.success) return
        clearAfterClose.current = false
        props.onOpen()
        setTabs((current) =>
          current.some((tab) => tab.id === DESIGN_PREVIEW_TAB_ID)
            ? current
            : [...current, { id: DESIGN_PREVIEW_TAB_ID, kind: 'browser' }],
        )
        setActiveId(DESIGN_PREVIEW_TAB_ID)
        setDesignPreview({ requestId: request.data.requestId, url: request.data.url })
      }),
    [props.onOpen, props.transport],
  )

  useEffect(() => {
    if (!addOpen) return
    const dismiss = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !addWrap.current?.contains(event.target)) {
        setAddOpen(false)
      }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAddOpen(false)
    }
    document.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', escape)
    }
  }, [addOpen])

  useEffect(
    () => () => {
      resizeCleanup.current()
    },
    [],
  )

  useEffect(() => {
    if (!props.open && globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      props.onClosed?.()
    }
  }, [props.open, props.onClosed])

  const closeTab = useCallback((id: string) => {
    const current = tabsRef.current
    const index = current.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const closing = current[index]!
    const next = current.filter((tab) => tab.id !== id)
    if (closing.kind === 'provider-login') {
      tabsRef.current = next
      setTabs(next)
      setActiveId((currentActive) =>
        currentActive === id ? (next[index]?.id ?? next[index - 1]?.id) : currentActive,
      )
      providerLoginTabId.current = undefined
      onProviderLoginClose.current?.(closing.requestId)
      return
    }
    if (next.length === 0) {
      clearAfterClose.current = true
      onClose.current()
      return
    }
    tabsRef.current = next
    setTabs(next)
    setActiveId((currentActive) =>
      currentActive === id ? (next[index]?.id ?? next[index - 1]?.id) : currentActive,
    )
  }, [])

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    if (props.expanded) return
    event.preventDefault()
    hapticServices.prepare()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeCleanup.current()
    const startX = event.clientX
    const startWidth = props.width
    const layoutWidth =
      event.currentTarget.closest<HTMLElement>('.workspace-layout')?.clientWidth ||
      window.innerWidth
    const maximum = Math.max(MIN_PANEL_WIDTH, layoutWidth - MIN_CHAT_WIDTH)
    const haptics = hapticServices.enabled()
      ? new ResizeHaptics({
          startValue: startWidth,
          startTime: event.timeStamp,
          minValue: MIN_PANEL_WIDTH,
          maxValue: maximum,
        })
      : undefined
    let currentWidth = startWidth
    let active = true
    const move = (next: globalThis.PointerEvent) => {
      const rawWidth = startWidth + startX - next.clientX
      const nextWidth = Math.min(maximum, Math.max(MIN_PANEL_WIDTH, rawWidth))
      const feedback = haptics?.sample({
        rawValue: rawWidth,
        value: nextWidth,
        tracking: nextWidth !== currentWidth,
        time: next.timeStamp,
      })
      currentWidth = nextWidth
      props.onWidthChange(nextWidth)
      if (feedback) hapticServices.perform(feedback)
    }
    const cleanup = () => {
      if (!active) return
      active = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      window.removeEventListener('blur', cleanup)
      resizeCleanup.current = () => {}
    }
    resizeCleanup.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', cleanup, { once: true })
    window.addEventListener('pointercancel', cleanup, { once: true })
    window.addEventListener('blur', cleanup, { once: true })
  }

  return (
    <aside
      className={`workspace-panel${props.open ? ' is-open' : ''}${props.expanded ? ' is-expanded' : ''}`}
      aria-label="Workspace tools"
      aria-hidden={!props.open}
      inert={props.open ? undefined : true}
      onTransitionEnd={(event) => {
        if (
          event.target !== event.currentTarget ||
          event.propertyName !== 'transform' ||
          props.open
        )
          return
        props.onClosed?.()
        if (!clearAfterClose.current) return
        clearAfterClose.current = false
        tabsRef.current = []
        setTabs([])
        setActiveId(undefined)
      }}
    >
      <div
        className="workspace-panel__resize"
        role="separator"
        aria-label="Resize workspace tools"
        aria-orientation="vertical"
        onDoubleClick={() => props.onExpandedChange(true)}
        onPointerEnter={() => {
          if (!props.expanded) hapticServices.prepare()
        }}
        onPointerDown={beginResize}
      />

      <header className="workspace-panel__chrome">
        <div className="workspace-panel__tabs" role="tablist" aria-label="Workspace tabs">
          {tabs.map((tab) => {
            const tool = toolFor(tab)
            const Icon = tool.Icon
            return (
              <div
                className={`workspace-panel__tab-shell${activeId === tab.id ? ' is-active' : ''}`}
                key={tab.id}
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault()
                    closeTab(tab.id)
                  }
                }}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeId === tab.id}
                  className="workspace-panel__tab"
                  onClick={() => setActiveId(tab.id)}
                >
                  <Icon size={14} aria-hidden />
                  <span>{tool.title}</span>
                </button>
                <button
                  type="button"
                  className="workspace-panel__tab-close"
                  aria-label={`Close ${tool.title}`}
                  onClick={() => closeTab(tab.id)}
                >
                  <X size={13} aria-hidden />
                </button>
              </div>
            )
          })}

          <div ref={addWrap} className="workspace-panel__add-wrap">
            <button
              type="button"
              className="workspace-panel__add"
              aria-label="Add workspace tab"
              aria-haspopup="menu"
              aria-expanded={addOpen}
              onClick={() => setAddOpen((current) => !current)}
            >
              <Plus size={16} aria-hidden />
            </button>
            {addOpen ? (
              <div className="workspace-panel__add-menu" role="menu">
                {TOOLS.map((tool) => (
                  <ToolMenuItem key={tool.kind} tool={tool} onOpen={() => openTool(tool.kind)} />
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className="workspace-panel__controls">
          <button
            type="button"
            aria-label={props.expanded ? 'Restore workspace width' : 'Expand workspace tools'}
            aria-pressed={props.expanded}
            onClick={() => props.onExpandedChange(!props.expanded)}
          >
            {props.expanded ? (
              <Minimize2 size={14} aria-hidden />
            ) : (
              <Maximize2 size={14} aria-hidden />
            )}
          </button>
        </div>
      </header>

      <div className="workspace-panel__body">
        {tabs.length > 0 ? (
          tabs.map((tab) => (
            <div
              className="workspace-panel__surface"
              key={tab.id}
              role="tabpanel"
              hidden={activeId !== tab.id}
            >
              <Suspense fallback={<WorkspaceLoading />}>
                <WorkspaceToolSurface
                  tab={tab}
                  active={
                    props.open && props.nativeSurfacesVisible && !addOpen && activeId === tab.id
                  }
                  transport={props.transport}
                  threadId={props.threadId}
                  projectPath={props.projectPath}
                  projectName={props.projectName}
                  branch={props.branch}
                  theme={props.theme}
                  sideChatParentStatus={props.sideChatParentStatus}
                  sideChatStartOptions={props.sideChatStartOptions}
                  sideChatPromptRequest={props.sideChatPromptRequest}
                  browserNavigation={tab.id === DESIGN_PREVIEW_TAB_ID ? designPreview : undefined}
                  terminalComponent={props.terminalComponent}
                  providerTerminalComponent={props.providerTerminalComponent}
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
  browserNavigation?: BrowserNavigationRequest | undefined
  terminalComponent?: WorkspacePanelTerminal | undefined
  providerTerminalComponent?: WorkspacePanelProviderTerminal | undefined
  onClose: () => void
}) {
  if (props.tab.kind === 'provider-login') {
    const TerminalComponent = props.providerTerminalComponent ?? AttachedProviderTerminal
    return (
      <div className="workspace-provider-login">
        <TerminalComponent
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
      />
    )
  }
  if (props.tab.kind === 'terminal') {
    const TerminalComponent = props.terminalComponent ?? WorkspaceTerminal
    return (
      <TerminalComponent
        active={props.active}
        transport={props.transport}
        threadId={props.threadId}
        projectPath={props.projectPath}
        theme={props.theme}
        onClose={props.onClose}
      />
    )
  }
  if (props.tab.kind === 'browser') {
    return <WorkspaceBrowser active={props.active} navigation={props.browserNavigation} />
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

function WorkspaceSelector({ onOpen }: { onOpen: (kind: WorkspaceTool) => void }) {
  return (
    <div className="workspace-selector">
      <div className="workspace-selector__list">
        {TOOLS.map((tool) => {
          const Icon = tool.Icon
          return (
            <button type="button" key={tool.kind} onClick={() => onOpen(tool.kind)}>
              <Icon size={18} aria-hidden />
              <span>{tool.title}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ToolMenuItem({ tool, onOpen }: { tool: (typeof TOOLS)[number]; onOpen: () => void }) {
  const Icon = tool.Icon
  return (
    <button type="button" role="menuitem" onClick={onOpen}>
      <Icon size={15} aria-hidden />
      <span>{tool.title}</span>
    </button>
  )
}

function WorkspaceLoading() {
  return <div className="workspace-panel__loading" aria-label="Loading workspace tool" />
}

function toolFor(tab: WorkspaceTab): Pick<(typeof TOOLS)[number], 'title' | 'Icon'> {
  if (tab.kind === 'provider-login') return { title: tab.title, Icon: SquareTerminal }
  return TOOLS.find((tool) => tool.kind === tab.kind) ?? TOOLS[0]!
}
