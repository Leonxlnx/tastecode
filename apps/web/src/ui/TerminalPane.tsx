import '@fontsource-variable/jetbrains-mono'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Copy, RotateCcw, X } from 'lucide-react'
import { memo, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { isMacOS, writeClipboardText } from '../bridge.js'
import {
  appHapticsEnabled,
  performAppHaptic,
  prepareAppHaptics,
  ResizeHaptics,
} from '../haptics.js'
import type { Transport, ConnectionState } from '../transport.js'
import { errorMessage } from '../boundary.js'
import '../styles/terminal-pane.css'

const MIN_HEIGHT = 160

export async function preloadTerminalRuntime(): Promise<void> {
  await Promise.allSettled([import('@xterm/addon-webgl'), import('@xterm/addon-web-links')])
}

type TerminalStatus =
  | { state: 'connecting' }
  | { state: 'open' }
  | { state: 'reconnecting' }
  | { state: 'error'; message: string }

type TerminalPaneProps = {
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

    let terminalId: string | undefined
    let opening = false
    let resizeFrame: number | undefined
    let lastResize: { columns: number; rows: number } | undefined
    const earlyOutput = new Map<string, string[]>()

    const sendSize = () => {
      if (!activeRef.current || container.clientWidth < 1 || container.clientHeight < 1) return
      fit.fit()
      if (!terminalId || props.transport.state !== 'open') return
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
        !activeRef.current ||
        terminalId ||
        opening ||
        disposed ||
        props.transport.state !== 'open'
      )
        return
      opening = true
      setStatus({ state: 'connecting' })
      if (activeRef.current && container.clientWidth > 0 && container.clientHeight > 0) fit.fit()
      const openedSize = { columns: instance.cols, rows: instance.rows }
      void props.transport
        .request('terminal.open', {
          ...target.request,
          ...openedSize,
        })
        .then(({ terminalId: openedId }) => {
          opening = false
          if (disposed) return
          terminalId = openedId
          lastResize = openedSize
          if (activeRef.current) {
            for (const data of earlyOutput.get(openedId) ?? []) instance.write(data)
          }
          earlyOutput.clear()
          setStatus({ state: 'open' })
          if (activeRef.current) {
            instance.focus()
            scheduleFit()
          }
        })
        .catch((error) => {
          opening = false
          if (!disposed) {
            setStatus({
              state: 'error',
              message: errorMessage(error),
            })
          }
        })
    }
    reconnect.current = () => {
      terminalId = undefined
      lastResize = undefined
      instance.clear()
      open()
    }
    activate.current = open

    const onConnection = (connection: ConnectionState) => {
      if (connection === 'open') open()
      else {
        terminalId = undefined
        lastResize = undefined
        opening = false
        if (connection === 'connecting') setStatus({ state: 'connecting' })
        else if (connection === 'reconnecting') setStatus({ state: 'reconnecting' })
      }
    }

    const offState = props.transport.onState(onConnection)
    const offOutput = props.transport.on('terminal.output', (event) => {
      if (event.terminalId === terminalId && activeRef.current) instance.write(event.data)
      // Only while our own open is in flight. terminal.output is a global
      // broadcast, so buffering whenever we have no id meant a pane left on
      // an exited terminal accumulated every other session's output forever.
      else if (!terminalId && opening && activeRef.current) {
        const buffered = earlyOutput.get(event.terminalId) ?? []
        buffered.push(event.data)
        earlyOutput.set(event.terminalId, buffered)
      }
    })
    const offExit = props.transport.on('terminal.exit', (event) => {
      if (event.terminalId !== terminalId) return
      terminalId = undefined
      lastResize = undefined
      earlyOutput.clear()
      onClose.current()
    })
    const input = instance.onData((data) => {
      if (!terminalId || props.transport.state !== 'open') return
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
  }, [props.transport, target, workspace])

  useLayoutEffect(() => {
    if (!active) return
    activate.current()
    refit.current()
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
    const startY = event.clientY
    const startHeight = heightRef.current
    const maximum = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.72))
    const haptics = appHapticsEnabled()
      ? new ResizeHaptics({
          startValue: startHeight,
          startTime: event.timeStamp,
          minValue: MIN_HEIGHT,
          maxValue: maximum,
        })
      : undefined
    let currentHeight = startHeight
    let resizeFrame: number | undefined
    let pendingResize: { rawHeight: number; height: number; time: number } | undefined
    let active = true
    const applyPendingResize = () => {
      resizeFrame = undefined
      const pending = pendingResize
      pendingResize = undefined
      if (!pending) return
      const tracking = pending.height !== currentHeight
      if (tracking) {
        currentHeight = pending.height
        heightRef.current = pending.height
        paneElement.style.height = `${pending.height}px`
      }
      const feedback = haptics?.sample({
        rawValue: pending.rawHeight,
        value: pending.height,
        tracking,
        time: pending.time,
      })
      if (feedback) performAppHaptic(feedback)
    }
    const move = (next: globalThis.PointerEvent) => {
      const rawHeight = startHeight + startY - next.clientY
      const nextHeight = Math.min(maximum, Math.max(MIN_HEIGHT, rawHeight))
      pendingResize = { rawHeight, height: nextHeight, time: next.timeStamp }
      if (resizeFrame === undefined) resizeFrame = requestAnimationFrame(applyPendingResize)
    }
    const cleanup = (commit: boolean) => {
      if (!active) return
      active = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      resizeCleanup.current = () => {}
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      resizeFrame = undefined
      if (commit) {
        applyPendingResize()
        setHeight(currentHeight)
        props.onHeightChange?.(currentHeight)
      } else {
        pendingResize = undefined
      }
    }
    const finish = () => cleanup(true)
    resizeCleanup.current = () => cleanup(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
    window.addEventListener('blur', finish, { once: true })
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
      {workspace ? (
        <span className="visually-hidden" aria-live="polite">
          {statusText(status)}
        </span>
      ) : (
        <header className="terminal-pane__header">
          <span className="terminal-pane__title">Terminal</span>
          <span className={`terminal-pane__status is-${status.state}`} aria-live="polite">
            {statusText(status)}
          </span>
          <div className="terminal-pane__actions">
            {status.state === 'error' ? (
              <button
                className="icon-btn"
                title="Restart terminal"
                onClick={() => reconnect.current()}
              >
                <RotateCcw size={13} aria-hidden />
              </button>
            ) : null}
            <button
              className="icon-btn"
              title="Copy selection"
              disabled={!hasSelection}
              onClick={() => terminal.current && copyTerminalSelection(terminal.current)}
            >
              <Copy size={13} aria-hidden />
            </button>
            <button className="icon-btn" title="Hide terminal" onClick={props.onClose}>
              <X size={14} aria-hidden />
            </button>
          </div>
        </header>
      )}
      <div ref={host} className="terminal-pane__viewport" />
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
