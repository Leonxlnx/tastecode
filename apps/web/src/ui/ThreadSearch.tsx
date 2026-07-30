import { useEffect, useRef, useState } from 'react'
import type { Item } from '@harness/contracts'
import { ChevronDown, ChevronUp, X } from 'lucide-react'

/**
 * Find within the open thread.
 *
 * Virtualisation means Ctrl+F does not work — the match may not exist in the
 * DOM. So the app has to own find, and owning it lets us jump by result rather
 * than by pixel.
 */
export function ThreadSearch(props: {
  items: Item[]
  onJump: (index: number) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
  }, [])

  const term = query.trim().toLowerCase()
  const hits = term
    ? props.items
        .map((item, index) => ({ item, index }))
        .filter(
          ({ item }) =>
            item.text?.toLowerCase().includes(term) ||
            item.command?.toLowerCase().includes(term) ||
            item.path?.toLowerCase().includes(term),
        )
        .map(({ index }) => index)
    : []

  const go = (next: number) => {
    if (hits.length === 0) return
    // Wraps in both directions: reaching the end of results and being told
    // "no more" is worse than looping.
    const wrapped = (next + hits.length) % hits.length
    setCursor(wrapped)
    const target = hits[wrapped]
    if (target !== undefined) props.onJump(target)
  }

  return (
    <div className="find">
      <input
        ref={input}
        value={query}
        spellCheck={false}
        placeholder="Find in thread"
        onChange={(e) => {
          setQuery(e.target.value)
          setCursor(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onClose()
          if (e.key === 'Enter') go(e.shiftKey ? cursor - 1 : cursor + 1)
        }}
      />
      <span className="find__count">
        {term === '' ? '' : hits.length === 0 ? 'None' : `${cursor + 1}/${hits.length}`}
      </span>
      <button className="icon-btn icon-btn--always" onClick={() => go(cursor - 1)} title="Previous">
        <ChevronUp size={12} aria-hidden />
      </button>
      <button className="icon-btn icon-btn--always" onClick={() => go(cursor + 1)} title="Next">
        <ChevronDown size={12} aria-hidden />
      </button>
      <button className="icon-btn icon-btn--always" onClick={props.onClose} title="Close">
        <X size={12} aria-hidden />
      </button>
    </div>
  )
}
