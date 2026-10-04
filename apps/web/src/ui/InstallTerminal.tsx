import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { memo, useLayoutEffect, useRef } from 'react'
import { isMacOS } from '../bridge.js'
import { installState, subscribeInstalls } from '../provider-install.js'
import type { Transport } from '../transport.js'
import {
  copyTerminalSelection,
  terminalCopyShortcut,
  terminalFont,
  terminalTheme,
} from './TerminalPane.js'

/**
 * A terminal attached to an install already running on the server. Unlike
 * TerminalPane it does not open anything: the install owns the pty, this view
 * replays the log captured so far and goes live from there, so the user can
 * answer an installer prompt or read a failure without having watched it.
 */
export const InstallTerminal = memo(function InstallTerminal(props: {
  transport: Transport
  installKey: string
  ariaLabel?: string | undefined
  profile?: 'app' | 'workspace' | undefined
  appearance?: 'notice' | undefined
}) {
  const host = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const container = host.current
    if (!container) return
    const workspace = props.profile === 'workspace'
    const theme = terminalTheme(props.profile)
    if (props.appearance === 'notice') {
      const style = getComputedStyle(container)
      theme.background = style.getPropertyValue('--menu-bg').trim()
      theme.cursorAccent = theme.background
    }

    const instance = new Terminal({
      cursorBlink: true,
      fontFamily: terminalFont(props.profile),
      fontSize: workspace ? 13 : 12,
      lineHeight: workspace ? 1 : 1.25,
      screenReaderMode: true,
      scrollback: 5_000,
      theme,
    })
    const fit = new FitAddon()
    instance.loadAddon(fit)
    instance.open(container)

    let shownTerminalId: string | undefined
    let written = 0

    const sync = () => {
      const state = installState(props.installKey)
      if (!state) return
      const end = state.logOffset + state.log.length
      if (state.terminalId !== shownTerminalId || written < state.logOffset || written > end) {
        // A retry replaced the session, or the rolling log was trimmed:
        // replay from the start rather than appending nonsense.
        shownTerminalId = state.terminalId
        written = state.logOffset
        // reset(), not clear(): clear() keeps the cursor line, so the last
        // line of a failed install stayed pinned above the fresh retry.
        instance.reset()
      }
      if (end > written) {
        instance.write(state.log.slice(written - state.logOffset))
        written = end
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
      if (!terminalCopyShortcut(event, instance.hasSelection(), isMacOS())) return true
      copyTerminalSelection(instance)
      return false
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
  }, [props.appearance, props.installKey, props.profile, props.transport])

  return (
    <div
      ref={host}
      className="install-terminal"
      aria-label={props.ariaLabel ?? 'Install terminal'}
    />
  )
})
