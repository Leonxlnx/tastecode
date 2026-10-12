import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Item } from '@harness/contracts'
import {
  IconChevronDown as ChevronDown,
  IconChevronUp as ChevronUp,
  IconRotate as RotateCcw,
  IconX as X,
} from '@tabler/icons-react'
import type { LiveItemUpdate } from '../thread-store.js'
import type { ThreadFrameStore } from '../thread-frame-store.js'
import {
  createLiveThreadSearch,
  createThreadSearchIndexer,
  findThreadSearchHits,
  mergeThreadSearchHits,
  NO_LIVE_THREAD_SEARCH,
} from '../thread-search-index.js'
import { isComposingKey, isConfirmEnter } from '../shortcuts.js'
import type { OlderHistoryStatus } from './use-older-history.js'

/**
 * Find within the open thread.
 *
 * Virtualisation means Ctrl+F does not work — the match may not exist in the
 * DOM. So the app has to own find, and owning it lets us jump by result rather
 * than by pixel. A long thread opens with only its newest turns, so the first
 * query asks for the rest in one read; matches above appear when it lands.
 */
export function ThreadSearch(props: {
  items: Item[]
  liveItems?: ReadonlyMap<number, LiveItemUpdate> | undefined
  frameStore?: ThreadFrameStore | undefined
  threadId?: string | undefined
  /** Older turns exist that are not loaded yet. */
  hasOlder?: boolean | undefined
  /** The read of those turns: idle until a query asks for it. */
  olderStatus?: OlderHistoryStatus | undefined
  /** Start that read, or retry it after a failure. */
  onLoadOlder?: (() => void) | undefined
  onJump: (index: number) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const jumped = useRef(false)
  const selected = useRef<string | undefined>(undefined)
  const subscribeFrame = useCallback(
    (listener: () => void) => props.frameStore?.subscribe(listener) ?? (() => undefined),
    [props.frameStore],
  )
  const getFrameSnapshot = useCallback(() => props.frameStore?.getSnapshot(), [props.frameStore])
  const frameSnapshot = useSyncExternalStore(subscribeFrame, getFrameSnapshot, getFrameSnapshot)
  const items = frameSnapshot?.items ?? props.items
  const liveItems = frameSnapshot?.liveItems ?? props.liveItems

  useEffect(() => {
    input.current?.focus()
  }, [])

  const term = query.trim().toLowerCase()
  // Settled rows are immutable. Normalize them once when search opens instead
  // of lowercasing the whole transcript again for every typed character.
  const projectSearchIndex = useMemo(createThreadSearchIndexer, [props.threadId])
  const searchIndex = projectSearchIndex(items)
  // A streamed delta publishes a new liveItems map every frame. Only structural
  // updates rescan settled rows; deltas search the live rows' new tails.
  const settledHits = useMemo(
    () => (term ? findThreadSearchHits(searchIndex, undefined, term) : []),
    [items, searchIndex, term],
  )
  const searchLiveItems = useMemo(createLiveThreadSearch, [props.threadId])
  const liveSearch = term ? searchLiveItems(liveItems, term) : NO_LIVE_THREAD_SEARCH
  const hits = useMemo(
    () => mergeThreadSearchHits(settledHits, liveSearch),
    [settledHits, liveSearch],
  )
  const currentCursor = Math.min(cursor, Math.max(0, hits.length - 1))

  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, hits.length - 1)))
    if (hits.length === 0) jumped.current = false
  }, [hits.length])

  // Older pages shift every index; keep the counter on the match last shown.
  useEffect(() => {
    if (selected.current === undefined) return
    const index = hits.findIndex((hit) => items[hit]?.id === selected.current)
    if (index >= 0) setCursor(index)
  }, [hits, items])

  const searching = term !== ''
  const { hasOlder, olderStatus = 'idle', onLoadOlder } = props
  const loadingOlder = hasOlder && olderStatus === 'loading'
  const olderFailed = hasOlder && olderStatus === 'failed'
  // A failed read waits for Retry instead of asking again on every keystroke.
  useEffect(() => {
    if (searching && hasOlder && olderStatus === 'idle') onLoadOlder?.()
  }, [searching, hasOlder, olderStatus, onLoadOlder])

  const go = (next: number) => {
    if (hits.length === 0) return
    // Wraps in both directions: reaching the end of results and being told
    // "no more" is worse than looping.
    const wrapped = (next + hits.length) % hits.length
    setCursor(wrapped)
    const target = hits[wrapped]
    selected.current = target === undefined ? undefined : items[target]?.id
    if (target !== undefined) props.onJump(target)
  }

  /** The first navigation lands on match one whichever control triggers it —
   *  advancing before ever jumping skipped it while the counter said "2/n". */
  const advance = (back: boolean) => {
    if (!jumped.current) {
      jumped.current = true
      go(back ? hits.length - 1 : 0)
      return
    }
    go(back ? currentCursor - 1 : currentCursor + 1)
  }

  return (
    <div className="find">
      <input
        ref={input}
        value={query}
        spellCheck={false}
        aria-label="Find in thread"
        placeholder="Find in thread"
        onChange={(e) => {
          setQuery(e.target.value)
          setCursor(0)
          jumped.current = false
          selected.current = undefined
        }}
        onKeyDown={(e) => {
          if (isComposingKey(e)) return
          if (e.key === 'Escape') props.onClose()
          if (isConfirmEnter(e)) advance(e.shiftKey)
        }}
      />
      <span className="find__count">
        {term === ''
          ? ''
          : hits.length === 0
            ? loadingOlder
              ? 'Searching…'
              : olderFailed
                ? 'Failed'
                : 'None'
            : `${currentCursor + 1}/${hits.length}${loadingOlder ? '…' : ''}`}
      </span>
      {/* Always mounted, so the reader hears when the read changes state. */}
      <span className="visually-hidden" role="status">
        {!searching
          ? ''
          : loadingOlder
            ? 'Searching earlier messages'
            : olderFailed
              ? 'Couldn’t search earlier messages'
              : ''}
      </span>
      {searching && olderFailed ? (
        <button
          className="icon-btn icon-btn--always"
          onClick={onLoadOlder}
          title="Couldn’t search earlier messages. Retry"
          aria-label="Retry searching earlier messages"
        >
          <RotateCcw size={12} aria-hidden />
        </button>
      ) : null}
      <button
        className="icon-btn icon-btn--always"
        onClick={() => advance(true)}
        title="Previous"
        aria-label="Previous match"
      >
        <ChevronUp size={12} aria-hidden />
      </button>
      <button
        className="icon-btn icon-btn--always"
        onClick={() => advance(false)}
        title="Next"
        aria-label="Next match"
      >
        <ChevronDown size={12} aria-hidden />
      </button>
      <button
        className="icon-btn icon-btn--always"
        onClick={props.onClose}
        title="Close"
        aria-label="Close thread search"
      >
        <X size={12} aria-hidden />
      </button>
    </div>
  )
}
