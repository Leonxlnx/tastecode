import '@fontsource-variable/jetbrains-mono'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { IconCopy as Copy, IconRotate as RotateCcw, IconX as X } from '@tabler/icons-react'
import { memo, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { isMacOS, writeClipboardText } from '../bridge.js'
import { prepareAppHaptics } from '../haptics.js'
import type { Transport, ConnectionState } from '../transport.js'
import { errorMessage } from '../boundary.js'
import { beginPanelResize } from './panel-resize.js'
import { acquireTerminalLease } from './terminal-ownership.js'
import { Skeleton, SkeletonLines, SkeletonStatus } from './Skeleton.js'
import '../styles/terminal-pane.css'

const MIN_HEIGHT = 160

type TerminalStatus =
  | { state: 'connecting' }
  | { state: 'open' }
  | { state: 'reconnecting' }
  | { state: 'error'; message: string }

type TerminalOutput = { data: string; outputOffset?: number | undefined }

export type TerminalPaneProps = {
  terminalKey?: string
  transport: Transport
  height?: number
  theme: 'light' | 'dark'
  mode?: 'inline' | 'workspace'
  active?: boolean
  onHeightChange?: (height: number) => void
  onClose: () => void
} & ({ threadId: string; projectPath?: never } | { threadId?: never; projectPath: string })

export const TerminalPane = memo(function TerminalPane(props: TerminalPaneProps) {
  const pane = useRef<HTMLElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal>(null)
  const activate = useRef<() => void>(() => {})
  const reconnect = useRef<() => void>(() => {})
  const refit = useRef<() => void>(() => {})
  const resizeCleanup = useRef<() => void>(() => {})
  const onClose = useRef(props.onClose)
  const workspace = props.mode === 'workspace'
  const active = props.active !== false
  const activeRef = useRef(active)
  const heightRef = useRef(props.height ?? MIN_HEIGHT)
  const [height, setHeight] = useState(props.height ?? MIN_HEIGHT)
  const [status, setStatus] = useState<TerminalStatus>({ state: 'connecting' })
  const [hasSelection, setHasSelection] = useState(false)
  const target = useMemo(() => terminalTarget(props), [props.projectPath, props.threadId])
  onClose.current = props.onClose
  activeRef.current = active
  heightRef.current = height

  useLayoutEffect(() => {
    const container = host.current
    if (!container) return

    const macOS = isMacOS()
    const windows = navigator.platform.startsWith('Win')
    const instance = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      customGlyphs: true,
      drawBoldTextInBrightColors: !workspace,
      fontFamily: terminalFont(workspace ? 'workspace' : 'app'),
      fontSize: workspace ? 13 : 12.5,
      fontWeight: workspace ? 400 : 'normal',
      fontWeightBold: workspace ? 700 : 'bold',
      letterSpacing: 0,
      lineHeight: workspace ? 1 : 1.25,
      macOptionIsMeta: workspace && macOS,
      minimumContrastRatio: workspace ? 1.5 : 1,
      rescaleOverlappingGlyphs: true,
      screenReaderMode: true,
      scrollback: 10_000,
      theme: terminalTheme(workspace ? 'workspace' : 'app'),
      ...(windows ? { windowsPty: { backend: 'conpty' as const } } : {}),
    })
    const fit = new FitAddon()
    instance.loadAddon(fit)
    const unicode = new Unicode11Addon()
    instance.loadAddon(unicode)
    instance.unicode.activeVersion = '11'
    instance.open(container)
    terminal.current = instance
    let disposed = false

    // Start the renderer import independently so optional GPU initialization
    // can never delay the shell. Context loss degrades to xterm's DOM renderer
    // instead of taking the terminal down.
    void import('@xterm/addon-webgl')
      .then(({ WebglAddon }) => {
        const webgl = new WebglAddon()
        if (disposed) {
          webgl.dispose()
          return
        }
        try {
          instance.loadAddon(webgl)
          webgl.onContextLoss(() => webgl.dispose())
        } catch (error) {
          console.warn('[terminal] WebGL unavailable; using DOM renderer', error)
        }
      })
      .catch((error) => {
        console.warn('[terminal] WebGL addon unavailable; using DOM renderer', error)
      })

    // The image addon instantiates WebAssembly internally, which the desktop
    // CSP intentionally forbids. Keep link detection without weakening that
    // boundary or leaving an unhandled rejection whenever a terminal opens.
    void import('@xterm/addon-web-links')
      .then(({ WebLinksAddon }) => {
        const links = new WebLinksAddon((_event, uri) => {
          window.open(uri, '_blank', 'noopener,noreferrer')
        })
        if (disposed) {
          links.dispose()
          return
        }
        instance.loadAddon(links)
      })
      .catch((error) => {
        console.warn('[terminal] link addon unavailable', error)
      })

    const terminalKey = props.terminalKey
    const lease = terminalKey
      ? acquireTerminalLease(props.transport, JSON.stringify([target.ownerKey, terminalKey]))
      : undefined
    let terminalId: string | undefined
    let opening = false
    let attached = false
    let finished = false
    let recoveryVersion = 0
    let outputOffset = 0
    let resizeFrame: number | undefined
    let lastResize: { columns: number; rows: number } | undefined
    const earlyOutput = new Map<string, TerminalOutput[]>()
    const earlyExits = new Set<string>()
    const closingIds = new Set<string>()

    const closeUnleasedTerminal = (id: string) => {
      if (lease && !closingIds.has(id)) {
        closingIds.add(id)
        lease.closeWhenUnleased(id)
      }
    }

    const writeOutput = (chunk: TerminalOutput) => {
      const start = chunk.outputOffset ?? outputOffset
      const end = start + chunk.data.length
      if (end <= outputOffset) return
      if (start > outputOffset) {
        instance.write('\r\n[Some terminal output is no longer available.]\r\n')
      }
      instance.write(chunk.data.slice(Math.max(0, outputOffset - start)))
      outputOffset = end
    }

    const finish = () => {
      finished = true
      attached = false
      opening = false
      recoveryVersion += 1
      terminalId = undefined
      lastResize = undefined
      earlyOutput.clear()
      earlyExits.clear()
      onClose.current()
    }

    const sendSize = () => {
      if (!activeRef.current || container.clientWidth < 1 || container.clientHeight < 1) return
      fit.fit()
      if (!terminalId || !attached || props.transport.state !== 'open') return
      const nextResize = { columns: instance.cols, rows: instance.rows }
      if (lastResize?.columns === nextResize.columns && lastResize.rows === nextResize.rows) {
        return
      }
      lastResize = nextResize
      void props.transport
        .request('terminal.resize', {
          terminalId,
          ...nextResize,
        })
        .catch(() => {
          if (lastResize === nextResize) lastResize = undefined
        })
    }

    const scheduleFit = () => {
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined
        sendSize()
      })
    }
    refit.current = scheduleFit

    // Fontsource makes JetBrains Mono deterministic on every desktop OS. A
    // late webfont swap changes cell metrics, so refit once the font settles
    // and invalidate the GPU atlas before drawing more output.
    const fontsReady = document.fonts?.ready
    if (fontsReady) {
      void fontsReady.then(() => {
        if (disposed) return
        instance.options.fontFamily = terminalFont(workspace ? 'workspace' : 'app')
        instance.clearTextureAtlas()
        scheduleFit()
      })
    }

    const open = () => {
      if (
        (!terminalId && !activeRef.current) ||
        attached ||
        opening ||
        finished ||
        disposed ||
        props.transport.state !== 'open'
      )
        return
      opening = true
      const version = ++recoveryVersion
      setStatus({ state: 'connecting' })
      if (activeRef.current && container.clientWidth > 0 && container.clientHeight > 0) fit.fit()
      const openedSize = { columns: instance.cols, rows: instance.rows }
      const current = terminalId
      const opened = current
        ? Promise.resolve({ terminalId: current })
        : props.transport.request('terminal.open', {
            ...target.request,
            ...(terminalKey ? { terminalKey } : {}),
            ...openedSize,
          })
      void opened
        .then(async ({ terminalId: openedId }) => {
          if (disposed) {
            closeUnleasedTerminal(openedId)
            return
          }
          if (version !== recoveryVersion) {
            // A known id still owns its shell while the connection is down.
            if (!terminalId && props.transport.state !== 'open') terminalId = openedId
            return
          }
          terminalId = openedId
          const snapshot = await props.transport.request('terminal.status', {
            terminalId: openedId,
          })
          if (disposed || version !== recoveryVersion) return
          opening = false
          if (snapshot.status === 'unknown') {
            terminalId = undefined
            finished = true
            earlyOutput.clear()
            earlyExits.clear()
            setStatus({
              state: 'error',
              message: 'This terminal is no longer available. The server may have restarted.',
            })
            return
          }
          // Hold live chunks until the snapshot fills the offline gap. Sort by
          // absolute position, then skip overlap with bytes already sent to xterm.
          // Legacy offset-less pushes during recovery are covered by the snapshot.
          const chunks = (earlyOutput.get(openedId) ?? []).filter(
            (chunk): chunk is TerminalOutput & { outputOffset: number } =>
              chunk.outputOffset !== undefined,
          )
          chunks.push({ data: snapshot.output, outputOffset: snapshot.outputOffset })
          chunks.sort((left, right) => left.outputOffset - right.outputOffset)
          for (const chunk of chunks) writeOutput(chunk)
          earlyOutput.clear()
          if (snapshot.status === 'exited' || earlyExits.has(openedId)) {
            finish()
            return
          }
          earlyExits.clear()
          attached = true
          lastResize = current ? undefined : openedSize
          setStatus({ state: 'open' })
          if (activeRef.current) {
            instance.focus()
            scheduleFit()
          }
        })
        .catch((error) => {
          if (disposed || version !== recoveryVersion) return
          opening = false
          earlyOutput.clear()
          earlyExits.clear()
          setStatus({ state: 'error', message: errorMessage(error) })
        })
    }
    reconnect.current = () => {
      finished = false
      lastResize = undefined
      if (!terminalId) {
        outputOffset = 0
        instance.reset()
      }
      open()
    }
    activate.current = open

    const onConnection = (connection: ConnectionState) => {
      if (finished) return
      if (connection === 'open') open()
      else {
        recoveryVersion += 1
        attached = false
        lastResize = undefined
        opening = false
        earlyOutput.clear()
        earlyExits.clear()
        setStatus({ state: connection === 'connecting' ? 'connecting' : 'reconnecting' })
      }
    }

    const offState = props.transport.onState(onConnection)
    const offOutput = props.transport.on('terminal.output', (event) => {
      if (event.terminalId === terminalId && attached) {
        if (event.outputOffset === undefined || event.outputOffset <= outputOffset) {
          writeOutput(event)
          return
        }
        attached = false
        open()
      }
      // Only while our own open is in flight. terminal.output is a global
      // broadcast, so buffering whenever we have no id meant a pane left on
      // an exited terminal accumulated every other session's output forever.
      if (opening && (!terminalId || event.terminalId === terminalId)) {
        const buffered = earlyOutput.get(event.terminalId) ?? []
        buffered.push(event)
        earlyOutput.set(event.terminalId, buffered)
      }
    })
    const offExit = props.transport.on('terminal.exit', (event) => {
      if (opening && (!terminalId || event.terminalId === terminalId)) {
        earlyExits.add(event.terminalId)
        return
      }
      if (event.terminalId !== terminalId) return
      finish()
    })
    const input = instance.onData((data) => {
      if (!terminalId || !attached || props.transport.state !== 'open') return
      void props.transport.request('terminal.input', { terminalId, data }).catch(() => undefined)
    })
    const selection = instance.onSelectionChange(() => setHasSelection(instance.hasSelection()))
    instance.attachCustomKeyEventHandler((event) => {
      if (!terminalCopyShortcut(event, instance.hasSelection(), macOS)) return true
      copyTerminalSelection(instance)
      return false
    })

    const observer = new ResizeObserver(scheduleFit)
    observer.observe(container)
    onConnection(props.transport.state)
    scheduleFit()

    return () => {
      disposed = true
      recoveryVersion += 1
      lease?.release()
      if (terminalId) {
        const closingId = terminalId
        queueMicrotask(() => closeUnleasedTerminal(closingId))
      }
      resizeCleanup.current()
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      refit.current = () => {}
      activate.current = () => {}
      observer.disconnect()
      input.dispose()
      selection.dispose()
      offState()
      offOutput()
      offExit()
      terminal.current = null
      instance.dispose()
    }
  }, [props.transport, target, workspace, props.terminalKey])

  useLayoutEffect(() => {
    if (props.height !== undefined) setHeight(props.height)
  }, [props.height])

  useLayoutEffect(() => {
    if (!active) return
    activate.current()
    refit.current()
    terminal.current?.focus()
  }, [active])

  useLayoutEffect(() => {
    if (terminal.current) {
      terminal.current.options.theme = terminalTheme(workspace ? 'workspace' : 'app')
    }
  }, [props.theme, workspace])

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const paneElement = pane.current
    if (!paneElement) return
    prepareAppHaptics()
    resizeCleanup.current()
    resizeCleanup.current = beginPanelResize(event, {
      axis: 'clientY',
      initialSize: heightRef.current,
      minSize: MIN_HEIGHT,
      maxSize: Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.72)),
      style: paneElement.style,
      property: 'height',
      onResize: (size) => {
        heightRef.current = size
      },
      onFinish: (size, commit) => {
        resizeCleanup.current = () => {}
        if (commit) {
          setHeight(size)
          props.onHeightChange?.(size)
        }
      },
    })
  }

  return (
    <section
      ref={pane}
      className={`terminal-pane${workspace ? ' terminal-pane--workspace' : ''}`}
      style={workspace ? undefined : { height }}
      aria-label="Session terminal"
    >
      {!workspace ? (
        <div
          className="terminal-pane__resize"
          role="separator"
          aria-label="Resize terminal"
          aria-orientation="horizontal"
          onPointerEnter={prepareAppHaptics}
          onPointerDown={beginResize}
        />
      ) : null}
      {workspace && status.state !== 'error' ? (
        <span className="visually-hidden" aria-live="polite">
          {statusText(status)}
        </span>
      ) : (
        <header className="terminal-pane__header">
          <span className="terminal-pane__title">Terminal</span>
          <span
            className={`terminal-pane__status is-${status.state}${status.state === 'open' ? ' visually-hidden' : ''}`}
            aria-live="polite"
          >
            {statusText(status)}
          </span>
          <div className="terminal-pane__actions">
            {status.state === 'error' ? (
              <button
                className="icon-btn icon-btn--always"
                title="Restart terminal"
                onClick={() => reconnect.current()}
              >
                <RotateCcw size={13} aria-hidden />
              </button>
            ) : null}
            <button
              className="icon-btn icon-btn--always"
              title="Copy selection"
              disabled={!hasSelection}
              onClick={() => terminal.current && copyTerminalSelection(terminal.current)}
            >
              <Copy size={13} aria-hidden />
            </button>
            <button
              className="icon-btn icon-btn--always"
              title="Hide terminal"
              onClick={props.onClose}
            >
              <X size={14} aria-hidden />
            </button>
          </div>
        </header>
      )}
      <div
        ref={host}
        className="terminal-pane__viewport"
        aria-busy={workspace ? status.state === 'connecting' : undefined}
      >
        {workspace && status.state === 'connecting' ? (
          <SkeletonStatus label="Connecting terminal…" className="terminal-pane__skeleton">
            <div className="terminal-pane__skeleton-prompt">
              <Skeleton width={8} height={9} />
              <Skeleton width="24%" height={9} />
            </div>
            <SkeletonLines lines={3} widths={['44%', '28%', '36%']} />
          </SkeletonStatus>
        ) : null}
      </div>
    </section>
  )
})

type TerminalTarget = {
  ownerKey: string
  request: { threadId: string } | { projectPath: string }
}

function terminalTarget(props: TerminalPaneProps): TerminalTarget {
  if (props.threadId !== undefined) {
    return { ownerKey: `thread:${props.threadId}`, request: { threadId: props.threadId } }
  }
  return {
    ownerKey: `project:${props.projectPath}`,
    request: { projectPath: props.projectPath },
  }
}

function statusText(status: TerminalStatus): string {
  if (status.state === 'open') return 'Connected'
  if (status.state === 'connecting') return 'Connecting…'
  if (status.state === 'reconnecting') return 'Reconnecting…'
  return status.message
}

export function terminalCopyShortcut(
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey' | 'type'>,
  hasSelection: boolean,
  macOS = isMacOS(),
): boolean {
  if (!hasSelection || event.type !== 'keydown' || event.key.toLowerCase() !== 'c') return false
  if (event.altKey) return false
  if (macOS) return event.metaKey && !event.ctrlKey
  return event.ctrlKey && event.shiftKey && !event.metaKey
}

export function copyTerminalSelection(instance: Pick<Terminal, 'getSelection'>): void {
  const text = instance.getSelection()
  if (!text) return
  void writeClipboardText(text).catch((error) => {
    console.warn('[terminal] clipboard write failed', error)
  })
}

type TerminalProfile = 'app' | 'workspace'

export function terminalFont(profile: TerminalProfile = 'app'): string {
  const property = profile === 'workspace' ? '--font-terminal' : '--font-mono'
  return getComputedStyle(document.documentElement).getPropertyValue(property).trim()
}

export function terminalTheme(profile: TerminalProfile = 'app'): ITheme {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string) => style.getPropertyValue(name).trim()
  const dark = document.documentElement.dataset['theme'] !== 'light'
  if (profile === 'workspace') {
    const theme = dark ? GHOSTTY_DARK_THEME : GHOSTTY_LIGHT_THEME
    const background =
      token('--terminal-workspace-bg') || theme.background || (dark ? '#0d0d0d' : '#eff1f5')
    return { ...theme, background, cursorAccent: background }
  }
  return {
    background: token('--bg'),
    foreground: token('--text'),
    cursor: token('--text-2'),
    cursorAccent: token('--bg'),
    selectionBackground: token('--surface-3'),
    selectionForeground: token('--text'),
    // Muted ANSI palette tuned to the app. Without it xterm falls back to
    // harsh pure-RGB defaults that clash with every accent.
    ...(dark ? DARK_ANSI : LIGHT_ANSI),
  }
}

const GHOSTTY_DARK_THEME: ITheme = {
  background: '#0d0d0d',
  foreground: '#d8dee9',
  cursor: '#d8dee9',
  cursorAccent: '#0d0d0d',
  selectionBackground: '#3b4048',
  selectionForeground: '#f2f4f8',
  selectionInactiveBackground: '#2b2f35',
  black: '#1d1f21',
  red: '#cc6566',
  green: '#b6bd68',
  yellow: '#f0c674',
  blue: '#82a2be',
  magenta: '#b294bb',
  cyan: '#8abeb7',
  white: '#c4c8c6',
  brightBlack: '#777777',
  brightRed: '#d54e53',
  brightGreen: '#b9ca4b',
  brightYellow: '#e7c547',
  brightBlue: '#7aa6da',
  brightMagenta: '#c397d8',
  brightCyan: '#70c0b1',
  brightWhite: '#ffffff',
}

const GHOSTTY_LIGHT_THEME: ITheme = {
  background: '#eff1f5',
  foreground: '#4c4f69',
  cursor: '#4c4f69',
  cursorAccent: '#eff1f5',
  selectionBackground: '#acb0be',
  selectionForeground: '#4c4f69',
  selectionInactiveBackground: '#ccd0da',
  black: '#5c5f77',
  red: '#d20f39',
  green: '#40a02b',
  yellow: '#df8e1d',
  blue: '#1e66f5',
  magenta: '#ea76cb',
  cyan: '#179299',
  white: '#acb0be',
  brightBlack: '#6c6f85',
  brightRed: '#de293e',
  brightGreen: '#49af3d',
  brightYellow: '#eea02d',
  brightBlue: '#456eff',
  brightMagenta: '#fe85d8',
  brightCyan: '#2d9fa8',
  brightWhite: '#bcc0cc',
}

const DARK_ANSI = {
  black: '#282c34',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#d8b26e',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#d7dae0',
  brightBlack: '#5c6370',
  brightRed: '#ef8189',
  brightGreen: '#a9d38c',
  brightYellow: '#e6c384',
  brightBlue: '#7cc0f4',
  brightMagenta: '#d48fe6',
  brightCyan: '#6fc9d4',
  brightWhite: '#eceef2',
}

const LIGHT_ANSI = {
  black: '#383a42',
  red: '#ca4a55',
  green: '#4f8a3d',
  yellow: '#a3841c',
  blue: '#2f6fdb',
  magenta: '#a24bb5',
  cyan: '#0d7f8f',
  white: '#c9cdd4',
  brightBlack: '#6b6f78',
  brightRed: '#e05561',
  brightGreen: '#5fa14c',
  brightYellow: '#b9962e',
  brightBlue: '#4a84e6',
  brightMagenta: '#b563c8',
  brightCyan: '#1f97a8',
  brightWhite: '#e8eaee',
}
