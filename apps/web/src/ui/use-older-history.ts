import { useCallback, useEffect, useRef, useState } from 'react'
import type { ThreadFrameStore } from '../thread-frame-store.js'

export type OlderHistoryStatus = 'idle' | 'loading' | 'failed'

/**
 * Loads the turns above a paged transcript and reports how that is going:
 * page by page while the reader scrolls up, or all at once for find and
 * search jumps. The latest callbacks are used whatever their identity.
 */
export function useOlderHistory(
  threadId: string | undefined,
  frameStore: ThreadFrameStore,
  onLoadOlderHistory: ((threadId: string, turnLimit?: number) => Promise<void>) | undefined,
  onLoadCompleteHistory: ((threadId: string, signal: AbortSignal) => Promise<void>) | undefined,
) {
  const [status, setStatus] = useState<OlderHistoryStatus>('idle')
  const olderRead = useRef<{ threadId: string; read: Promise<boolean> } | undefined>(undefined)
  const olderFailed = useRef(false)
  const threadIdRef = useRef(threadId)
  threadIdRef.current = threadId
  const loadOlderRef = useRef(onLoadOlderHistory)
  loadOlderRef.current = onLoadOlderHistory
  const loadCompleteRef = useRef(onLoadCompleteHistory)
  loadCompleteRef.current = onLoadCompleteHistory
  const loadOlder = useCallback(
    (turnLimit?: number): Promise<boolean> => {
      const threadId = threadIdRef.current
      const load = loadOlderRef.current
      if (!threadId || !load) return Promise.resolve(false)
      if (olderRead.current?.threadId === threadId) return olderRead.current.read
      olderFailed.current = false
      setStatus('loading')
      const cursor = frameStore.getStructureSnapshot().olderCursor
      const read = load(threadId, turnLimit).then(
        // A read that leaves the same cursor behind would only be asked again,
        // by the next scroll or fill, forever.
        () => frameStore.getStructureSnapshot().olderCursor !== cursor,
        () => false,
      )
      olderRead.current = { threadId, read }
      void read.then((loaded) => {
        if (olderRead.current?.read !== read) return
        olderRead.current = undefined
        olderFailed.current = !loaded
        if (threadIdRef.current === threadId) setStatus(loaded ? 'idle' : 'failed')
      })
      return read
    },
    [frameStore],
  )

  const [completeStatus, setCompleteStatus] = useState<OlderHistoryStatus>('idle')
  const completeRead = useRef<{ threadId: string; abort: AbortController } | undefined>(undefined)
  /** Every remaining turn in one read; a call while it is out joins it. */
  const loadComplete = useCallback(() => {
    const threadId = threadIdRef.current
    const load = loadCompleteRef.current
    const cursor = frameStore.getStructureSnapshot().olderCursor
    if (!threadId || !load || !cursor || completeRead.current?.threadId === threadId) return
    const abort = new AbortController()
    completeRead.current = { threadId, abort }
    setCompleteStatus('loading')
    void load(threadId, abort.signal)
      .then(
        () => true,
        () => false,
      )
      .then((loaded) => {
        if (completeRead.current?.abort !== abort) return
        completeRead.current = undefined
        // A read that leaves the same cursor behind would only repeat itself.
        const stalled = frameStore.getStructureSnapshot().olderCursor === cursor
        setCompleteStatus(loaded && !stalled ? 'idle' : 'failed')
      })
  }, [frameStore])
  /** Stop waiting for the complete read; its reply is dropped. */
  const cancelComplete = useCallback(() => {
    completeRead.current?.abort.abort()
    completeRead.current = undefined
    setCompleteStatus('idle')
  }, [])

  useEffect(() => {
    olderFailed.current = false
    setStatus('idle')
    return cancelComplete
  }, [threadId, cancelComplete])
  /** Whether scrolling near the top may start a page read now. */
  const canLoadOnScroll = useCallback(
    () =>
      Boolean(frameStore.getStructureSnapshot().olderCursor) &&
      olderRead.current === undefined &&
      completeRead.current === undefined &&
      !olderFailed.current,
    [frameStore],
  )
  return { status, loadOlder, canLoadOnScroll, completeStatus, loadComplete, cancelComplete }
}
