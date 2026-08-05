import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { memo, useLayoutEffect, useRef } from 'react'
import { installState, subscribeInstalls } from '../provider-install.js'
import type { Transport } from '../transport.js'
import { terminalFont, terminalTheme } from './TerminalPane.js'

/**
 * A terminal attached to an install already running on the server. Unlike
 * TerminalPane it does not open anything: the install owns the pty, this view
 * replays the log captured so far and goes live from there, so the user can
 * answer an installer prompt or read a failure without having watched it.
 */
export const InstallTerminal = memo(function InstallTerminal(props: {
  transport: Transport
  installKey: string
}) {
  const host = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const container = host.current
    if (!container) return

    const instance = new Terminal({
      cursorBlink: true,
      fontFamily: terminalFont(),
      fontSize: 12,
      lineHeight: 1.25,
      screenReaderMode: true,
      scrollback: 5_000,
      theme: terminalTheme(),
    })
    const fit = new FitAddon()
    instance.loadAddon(fit)
    instance.open(container)

    let shownTerminalId: string | undefined
    let written = 0

    const sync = () => {
      const state = installState(props.installKey)
      if (!state) return
      if (state.terminalId !== shownTerminalId || state.log.length < written) {
        // A retry replaced the session, or the rolling log was trimmed:
        // replay from the start rather than appending nonsense.
        shownTerminalId = state.terminalId
        written = 0
        instance.clear()
      }
      if (state.log.length > written) {
        instance.write(state.log.slice(written))
        written = state.log.length
      }
    }

    const sendSize = () => {
      fit.fit()
      const state = installState(props.installKey)
      if (!state || state.phase !== 'running' || props.transport.state !== 'open') return
      void props.transport
        .request('terminal.resize', {
          terminalId: state.terminalId,
          columns: instance.cols,
          rows: instance.rows,
        })
        .catch(() => undefined)
    }

    const offStore = subscribeInstalls(sync)
    const input = instance.onData((data) => {
      const state = installState(props.installKey)
      if (!state || state.phase !== 'running' || props.transport.state !== 'open') return
      void props.transport
        .request('terminal.input', { terminalId: state.terminalId, data })
        .catch(() => undefined)
    })
    instance.attachCustomKeyEventHandler((event) => {
      const copy = event.key.toLowerCase() === 'c' && (event.metaKey || event.ctrlKey)
      return !(copy && instance.hasSelection())
    })

    const observer = new ResizeObserver(sendSize)
    observer.observe(container)
    sync()
    sendSize()
    instance.focus()

    return () => {
      observer.disconnect()
      input.dispose()
      offStore()
      instance.dispose()
    }
  }, [props.installKey, props.transport])

  return <div ref={host} className="install-terminal" aria-label="Install terminal" />
})
