import { useEffect, useMemo, useRef, useState } from 'react'
import type { Item } from '@harness/contracts'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { LiveItemUpdate } from '../thread-store.js'
import { createThreadSearchIndexer, findThreadSearchHits } from '../thread-search-index.js'

/**
 * Find within the open thread.
 *
 * Virtualisation means Ctrl+F does not work — the match may not exist in the
 * DOM. So the app has to own find, and owning it lets us jump by result rather
 * than by pixel.
 */
export function ThreadSearch(props: {
  items: Item[]
  liveItems?: ReadonlyMap<number, LiveItemUpdate> | undefined
  threadId?: string | undefined
  onJump: (index: number) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const jumped = useRef(false)
  const liveItems = useRef(props.liveItems)
  liveItems.current = props.liveItems

  useEffect(() => {
    input.current?.focus()
  }, [])

  const term = query.trim().toLowerCase()
  // Settled rows are immutable. Normalize them once when search opens instead
  // of lowercasing the whole transcript again for every typed character.
  const projectSearchIndex = useMemo(createThreadSearchIndexer, [props.threadId])
  const searchIndex = projectSearchIndex(props.items)
  const hits = useMemo(
    () => (term ? findThreadSearchHits(searchIndex, liveItems.current, term) : []),
    [searchIndex, props.items, term],
  )

  const go = (next: number) => {
    if (hits.length === 0) return
    // Wraps in both directions: reaching the end of results and being told
    // "no more" is worse than looping.
    const wrapped = (next + hits.length) % hits.length
    setCursor(wrapped)
    const target = hits[wrapped]
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
    go(back ? cursor - 1 : cursor + 1)
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
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onClose()
          if (e.key === 'Enter') advance(e.shiftKey)
        }}
      />
      <span className="find__count">
        {term === '' ? '' : hits.length === 0 ? 'None' : `${cursor + 1}/${hits.length}`}
      </span>
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
