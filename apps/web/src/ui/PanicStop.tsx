import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleStop, LoaderCircle } from 'lucide-react'
import { isMacOS } from '../bridge.js'
import { matchesShortcut, SHORTCUTS, shortcutAria, shortcutLabel } from '../shortcuts.js'
import type { Transport } from '../transport.js'

export function PanicStop({ transport }: { transport: Transport }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ text: string; failed: boolean }>()
  const stopping = useRef(false)
  const shortcut = shortcutLabel(SHORTCUTS.panicStop, isMacOS())

  const stop = useCallback(async () => {
    if (stopping.current) return
    stopping.current = true
    setBusy(true)
    setResult(undefined)
    try {
      const { sessions } = await transport.request('system.panicStop', {})
      const failed = sessions.filter((session) => session.status === 'failed')
      const stopped = sessions.length - failed.length
      setResult({
        failed: failed.length > 0,
        text:
          failed.length > 0
            ? `Stopped ${stopped} of ${sessions.length}. ${failed.map((session) => `${session.threadId}: ${session.error}`).join('; ')}`
            : sessions.length > 0
              ? `Stopped ${stopped} agent session${stopped === 1 ? '' : 's'}.`
              : 'No agent sessions were running.',
      })
    } catch (cause) {
      setResult({ failed: true, text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      stopping.current = false
      setBusy(false)
    }
  }, [transport])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !matchesShortcut(event, SHORTCUTS.panicStop))
        return
      event.preventDefault()
      void stop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stop])

  return (
    <aside className="panic-stop" aria-label="Emergency controls">
      <button
        className="panic-stop__button"
        type="button"
        disabled={busy}
        title={`Stop all agents (${shortcut})`}
        aria-keyshortcuts={shortcutAria(SHORTCUTS.panicStop)}
        onClick={() => void stop()}
      >
        {busy ? <LoaderCircle className="spinner" aria-hidden /> : <CircleStop aria-hidden />}
        {busy ? 'Stopping…' : 'Stop all agents'}
      </button>
      {result ? (
        <p className="panic-stop__result" role={result.failed ? 'alert' : 'status'}>
          {result.text}
        </p>
      ) : null}
    </aside>
  )
}
