import { useEffect } from 'react'
import type { Transport } from '../../transport.js'

/**
 * Calls `refresh` once shortly after a turn completes in this chat (any chat
 * when none is given) or the connection reopens. Deltas never trigger it.
 */
export function useWorkspaceRefresh(
  transport: Transport,
  threadId: string | undefined,
  refresh: () => void,
): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      timer ??= setTimeout(() => {
        timer = undefined
        refresh()
      }, 200)
    }
    const offEvent = transport.on('thread.event', (data) => {
      if (data.event.type === 'turn.completed' && (!threadId || data.threadId === threadId))
        schedule()
    })
    const offState = transport.onState((state) => {
      if (state === 'open') schedule()
    })
    return () => {
      clearTimeout(timer)
      offEvent()
      offState()
    }
  }, [refresh, threadId, transport])
}
