import { useCallback, useEffect, useRef, useState } from 'react'
import type { ThreadFrameStore } from '../thread-frame-store.js'
import { MAX_HISTORY_PAGE_TURNS } from './older-history.js'

export type OlderHistoryStatus = 'idle' | 'loading' | 'failed'

/**
 * Loads the turns above a paged transcript and reports how that is going.
 * `onLoadOlderHistory` may change identity; the latest one is used.
 */
export function useOlderHistory(
  threadId: string | undefined,
  frameStore: ThreadFrameStore,
  onLoadOlderHistory: ((threadId: string, turnLimit?: number) => Promise<void>) | undefined,
) {
  const [status, setStatus] = useState<OlderHistoryStatus>('idle')
  const olderRead = useRef<{ threadId: string; read: Promise<boolean> } | undefined>(undefined)
  const olderFailed = useRef(false)
  const threadIdRef = useRef(threadId)
  threadIdRef.current = threadId
  const loadOlderRef = useRef(onLoadOlderHistory)
  loadOlderRef.current = onLoadOlderHistory
  const loadOlder = useCallback((turnLimit?: number): Promise<boolean> => {
    const threadId = threadIdRef.current
    const load = loadOlderRef.current
    if (!threadId || !load) return Promise.resolve(false)
    if (olderRead.current?.threadId === threadId) return olderRead.current.read
    olderFailed.current = false
    setStatus('loading')
    const read = load(threadId, turnLimit).then(
      () => true,
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
  }, [])
  const searchingOlder = useRef(false)
  // Find and search jumps need every turn, so fetch the rest in large pages.
  const loadAllOlder = useCallback(async () => {
    const threadId = threadIdRef.current
    if (searchingOlder.current) return
    searchingOlder.current = true
    try {
      while (
        threadIdRef.current === threadId &&
        frameStore.getStructureSnapshot().olderCursor &&
        (await loadOlder(MAX_HISTORY_PAGE_TURNS))
      );
    } finally {
      searchingOlder.current = false
    }
  }, [frameStore, loadOlder])
  useEffect(() => {
    olderFailed.current = false
    setStatus('idle')
  }, [threadId])
  /** Whether scrolling near the top may start a page read now. */
  const canLoadOnScroll = useCallback(
    () =>
      Boolean(frameStore.getStructureSnapshot().olderCursor) &&
      olderRead.current === undefined &&
      !olderFailed.current,
    [frameStore],
  )
  return { status, loadOlder, loadAllOlder, canLoadOnScroll }
}
