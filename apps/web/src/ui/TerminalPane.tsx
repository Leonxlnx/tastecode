import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Copy, RotateCcw, X } from 'lucide-react'
import { memo, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import type { Transport, ConnectionState } from '../transport.js'

const MIN_HEIGHT = 160
const owners = new Map<string, symbol>()

type TerminalStatus =
  | { state: 'connecting' }
  | { state: 'open' }
  | { state: 'reconnecting' }
  | { state: 'exited'; exitCode: number | null }
  | { state: 'error'; message: string }

export const TerminalPane = memo(function TerminalPane(props: {
  transport: Transport
  threadId: string
  height: number
  theme: 'light' | 'dark'
  onHeightChange: (height: number) => void
  onClose: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal>(null)
  const reconnect = useRef<() => void>(() => {})
  const resizeCleanup = useRef<() => void>(() => {})
  const heightRef = useRef(props.height)
  const [height, setHeight] = useState(props.height)
  const [status, setStatus] = useState<TerminalStatus>({ state: 'connecting' })
  const [hasSelection, setHasSelection] = useState(false)
  heightRef.current = height

  useLayoutEffect(() => {
    const container = host.current
    if (!container) return
    const owner = Symbol(props.threadId)
    owners.set(props.threadId, owner)

    const instance = new Terminal({
      cursorBlink: true,
      fontFamily: terminalFont(),
      fontSize: 12.5,
      lineHeight: 1.25,
      screenReaderMode: true,
      scrollback: 5_000,
      theme: terminalTheme(),
    })
    const fit = new FitAddon()
    instance.loadAddon(fit)
    instance.open(container)
    terminal.current = instance

    let terminalId: string | undefined
    let opening = false
    let disposed = false
    let resizeFrame: number | undefined
    const earlyOutput = new Map<string, string[]>()

    const sendSize = () => {
      fit.fit()
      if (!terminalId || props.transport.state !== 'open') return
      void props.transport
        .request('terminal.resize', {
          terminalId,
          columns: instance.cols,
          rows: instance.rows,
        })
        .catch(() => undefined)
    }

    const scheduleFit = () => {
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined
        sendSize()
      })
    }

    const open = () => {
      if (opening || disposed || props.transport.state !== 'open') return
      opening = true
      setStatus({ state: 'connecting' })
      fit.fit()
      void props.transport
        .request('terminal.open', {
          threadId: props.threadId,
          columns: instance.cols,
          rows: instance.rows,
        })
        .then(({ terminalId: openedId }) => {
          opening = false
          if (disposed) {
            if (!owners.has(props.threadId)) {
              void props.transport
                .request('terminal.close', { terminalId: openedId })
                .catch(() => undefined)
            }
            return
          }
          terminalId = openedId
          for (const data of earlyOutput.get(openedId) ?? []) instance.write(data)
          earlyOutput.clear()
          setStatus({ state: 'open' })
          instance.focus()
        })
        .catch((error: unknown) => {
          opening = false
          if (!disposed) {
            setStatus({
              state: 'error',
              message: error instanceof Error ? error.message : String(error),
            })
          }
        })
    }
    reconnect.current = () => {
      terminalId = undefined
      instance.clear()
      open()
    }

    const onConnection = (connection: ConnectionState) => {
      if (connection === 'open') open()
      else {
        opening = false
        if (connection === 'connecting') setStatus({ state: 'connecting' })
        else if (connection === 'reconnecting') setStatus({ state: 'reconnecting' })
      }
    }

    const offState = props.transport.onState(onConnection)
    const offOutput = props.transport.on('terminal.output', (event) => {
      if (event.terminalId === terminalId) instance.write(event.data)
      // Only while our own open is in flight. terminal.output is a global
      // broadcast, so buffering whenever we have no id meant a pane left on
      // an exited terminal accumulated every other session's output forever.
      else if (!terminalId && opening) {
        const buffered = earlyOutput.get(event.terminalId) ?? []
        buffered.push(event.data)
        earlyOutput.set(event.terminalId, buffered)
      }
    })
    const offExit = props.transport.on('terminal.exit', (event) => {
      if (event.terminalId !== terminalId) return
      terminalId = undefined
      earlyOutput.clear()
      setStatus({ state: 'exited', exitCode: event.exitCode })
    })
    const input = instance.onData((data) => {
      if (!terminalId || props.transport.state !== 'open') return
      void props.transport.request('terminal.input', { terminalId, data }).catch(() => undefined)
    })
    const selection = instance.onSelectionChange(() => setHasSelection(instance.hasSelection()))
    instance.attachCustomKeyEventHandler((event) => {
      const copy = event.key.toLowerCase() === 'c' && (event.metaKey || event.ctrlKey)
      return !(copy && instance.hasSelection())
    })

    const observer = new ResizeObserver(scheduleFit)
    observer.observe(container)
    onConnection(props.transport.state)
    scheduleFit()

    return () => {
      disposed = true
      resizeCleanup.current()
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      observer.disconnect()
      input.dispose()
      selection.dispose()
      offState()
      offOutput()
      offExit()
      if (owners.get(props.threadId) === owner) {
        owners.delete(props.threadId)
      }
      if (terminalId && !owners.has(props.threadId)) {
        void props.transport.request('terminal.close', { terminalId }).catch(() => undefined)
      }
      terminal.current = null
      instance.dispose()
    }
  }, [props.threadId, props.transport])

  useLayoutEffect(() => {
    if (terminal.current) terminal.current.options.theme = terminalTheme()
  }, [props.theme])

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    resizeCleanup.current()
    const startY = event.clientY
    const startHeight = heightRef.current
    let active = true
    const move = (next: globalThis.PointerEvent) => {
      const maximum = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.72))
      setHeight(Math.min(maximum, Math.max(MIN_HEIGHT, startHeight + startY - next.clientY)))
    }
    const cleanup = (commit: boolean) => {
      if (!active) return
      active = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      resizeCleanup.current = () => {}
      if (commit) props.onHeightChange(heightRef.current)
    }
    const finish = () => cleanup(true)
    resizeCleanup.current = () => cleanup(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
    window.addEventListener('blur', finish, { once: true })
  }

  return (
    <section className="terminal-pane" style={{ height }} aria-label="Session terminal">
      <div
        className="terminal-pane__resize"
        role="separator"
        aria-label="Resize terminal"
        aria-orientation="horizontal"
        onPointerDown={beginResize}
      />
      <header className="terminal-pane__header">
        <span className="terminal-pane__title">Terminal</span>
        <span className={`terminal-pane__status is-${status.state}`} aria-live="polite">
          {statusText(status)}
        </span>
        <div className="terminal-pane__actions">
          {status.state === 'exited' || status.state === 'error' ? (
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
            onClick={() => {
              const text = terminal.current?.getSelection()
              if (text) void navigator.clipboard?.writeText(text)
            }}
          >
            <Copy size={13} aria-hidden />
          </button>
          <button className="icon-btn" title="Close terminal" onClick={props.onClose}>
            <X size={14} aria-hidden />
          </button>
        </div>
      </header>
      <div ref={host} className="terminal-pane__viewport" />
    </section>
  )
})

function statusText(status: TerminalStatus): string {
  if (status.state === 'open') return 'Connected'
  if (status.state === 'connecting') return 'Connecting…'
  if (status.state === 'reconnecting') return 'Reconnecting…'
  if (status.state === 'error') return status.message
  return status.exitCode === null ? 'Exited' : `Exited (${status.exitCode})`
}

export function terminalFont(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
}

export function terminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string) => style.getPropertyValue(name).trim()
  const dark = document.documentElement.dataset['theme'] !== 'light'
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
