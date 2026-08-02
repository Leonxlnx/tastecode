import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import { Copy, RotateCcw, X } from 'lucide-react'
import { memo, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import type { Transport, ConnectionState } from '../transport.js'

const MIN_HEIGHT = 160

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
  const heightRef = useRef(props.height)
  const [height, setHeight] = useState(props.height)
  const [status, setStatus] = useState<TerminalStatus>({ state: 'connecting' })
  const [hasSelection, setHasSelection] = useState(false)
  heightRef.current = height

  useLayoutEffect(() => {
    const container = host.current
    if (!container) return

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
            void props.transport
              .request('terminal.close', { terminalId: openedId })
              .catch(() => undefined)
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
      else if (!terminalId) {
        const buffered = earlyOutput.get(event.terminalId) ?? []
        buffered.push(event.data)
        earlyOutput.set(event.terminalId, buffered)
      }
    })
    const offExit = props.transport.on('terminal.exit', (event) => {
      if (event.terminalId !== terminalId) return
      terminalId = undefined
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
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      observer.disconnect()
      input.dispose()
      selection.dispose()
      offState()
      offOutput()
      offExit()
      if (terminalId) {
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
    const startY = event.clientY
    const startHeight = heightRef.current
    const move = (next: globalThis.PointerEvent) => {
      const maximum = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.72))
      setHeight(Math.min(maximum, Math.max(MIN_HEIGHT, startHeight + startY - next.clientY)))
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      props.onHeightChange(heightRef.current)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
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

function terminalFont(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
}

function terminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string) => style.getPropertyValue(name).trim()
  return {
    background: token('--bg'),
    foreground: token('--text'),
    cursor: token('--text-2'),
    cursorAccent: token('--bg'),
    selectionBackground: token('--surface-3'),
    selectionForeground: token('--text'),
  }
}
