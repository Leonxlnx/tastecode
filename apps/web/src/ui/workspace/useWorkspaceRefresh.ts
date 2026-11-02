import { useEffect, useRef } from 'react'
import type { Transport } from '../../transport.js'

/** A long turn's edits show at most this often while the tool is on screen. */
export const LIVE_REFRESH_MS = 2_000
/** Edits come in bursts; the first refresh of a burst waits for it to settle a little. */
const LIVE_SETTLE_MS = 300

/**
 * Calls `refresh` once shortly after a turn completes in this chat (any chat
 * when none is given) or the connection reopens. Deltas never trigger it.
 *
 * A hidden tool reads nothing: a change only marks it stale, and it refreshes
 * when it is shown again. With `onLiveChange`, a visible tool also follows
 * the turn's file edits and diff updates, at most once per LIVE_REFRESH_MS
 * and never two at a time; a turn's end still gets the full `refresh`.
 */
export function useWorkspaceRefresh(
  transport: Transport,
  threadId: string | undefined,
  refresh: () => void,
  options: { visible?: boolean; onLiveChange?: (() => Promise<unknown>) | undefined } = {},
): void {
  const visible = options.visible ?? true
  const onLiveChange = options.onLiveChange
  // Survives the re-subscription that showing or hiding the tool causes.
  const stale = useRef(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let liveTimer: ReturnType<typeof setTimeout> | undefined
    let liveRunning = false
    let livePending = false
    let lastLive = Number.NEGATIVE_INFINITY
    let disposed = false
    const ours = (id: string) => !threadId || id === threadId

    const schedule = () => {
      if (!visible) {
        stale.current = true
        return
      }
      // The full refresh reads everything a live one would.
      clearTimeout(liveTimer)
      liveTimer = undefined
      timer ??= setTimeout(() => {
        timer = undefined
        stale.current = false
        refresh()
      }, 200)
    }

    const runLive = () => {
      liveTimer = undefined
      if (!onLiveChange) return
      if (liveRunning) {
        livePending = true
        return
      }
      liveRunning = true
      lastLive = Date.now()
      void onLiveChange()
        .catch(() => undefined)
        .finally(() => {
          liveRunning = false
          if (livePending && !disposed) {
            livePending = false
            scheduleLive()
          }
        })
    }

    const scheduleLive = () => {
      if (!visible) {
        stale.current = true
        return
      }
      if (liveTimer !== undefined || timer !== undefined) return
      const wait = Math.max(LIVE_SETTLE_MS, lastLive + LIVE_REFRESH_MS - Date.now())
      liveTimer = setTimeout(runLive, wait)
    }

    const offEvent = transport.on('thread.event', (data) => {
      const event = data.event
      if (event.type === 'turn.completed') {
        if (ours(data.threadId)) schedule()
      } else if (
        onLiveChange &&
        (event.type === 'diff.updated' ||
          (event.type === 'item.completed' && event.item.type === 'file_change')) &&
        ours(data.threadId)
      ) {
        scheduleLive()
      }
    })
    const offState = transport.onState((state) => {
      if (state === 'open') schedule()
    })
    if (visible && stale.current) schedule()
    return () => {
      disposed = true
      clearTimeout(timer)
      clearTimeout(liveTimer)
      offEvent()
      offState()
    }
  }, [onLiveChange, refresh, threadId, transport, visible])
}
