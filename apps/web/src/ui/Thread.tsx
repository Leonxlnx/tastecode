import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Item, PlanStep } from '@harness/contracts'
import { Diff } from './Diff.js'
import { Markdown } from './Markdown.js'
import { Plan } from './Plan.js'
import { ThreadSearch } from './ThreadSearch.js'
import { isAtBottom, modeForNewTurn, shouldReleaseAnchor, type ScrollMode } from './scroll-mode.js'

/**
 * The thread.
 *
 * Virtualised: only the rows near the viewport exist in the DOM, so a session
 * with hundreds of turns costs the same as one with five. Rows are measured
 * rather than estimated because a single item can be three words or a 400-line
 * diff, and a wrong estimate shows up as scroll drift.
 *
 * Messages read as prose; commands, reasoning and file edits collapse to one
 * line you can open. The default view should read as a summary of what
 * happened, not a transcript of every byte.
 */
export function Thread(props: {
  items: Item[]
  running: boolean
  plan: PlanStep[]
  diff: string | undefined
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<ScrollMode>('follow-end')
  const [finding, setFinding] = useState(false)
  const modeRef = useRef(mode)
  modeRef.current = mode

  /** Index the current turn starts at, for anchor mode. */
  const anchorIndex = useRef(0)
  const wasRunning = useRef(props.running)

  const virtualizer = useVirtualizer({
    count: props.items.length,
    getScrollElement: () => scroller.current,
    // Roughly one paragraph. Wrong estimates only cost a correction on measure.
    estimateSize: () => 72,
    // Stable identity per item, never the index — index keys make every
    // insertion look like a change to every row after it.
    getItemKey: (index) => props.items[index]?.id ?? index,
    overscan: 8,
  })

  // A turn starting is the one moment the reading position should change.
  useEffect(() => {
    if (props.running && !wasRunning.current) {
      const el = scroller.current
      anchorIndex.current = Math.max(0, props.items.length - 1)
      setMode(modeForNewTurn(el ? isAtBottom(el) : true))
    }
    wasRunning.current = props.running
  }, [props.running, props.items.length])

  // Layout effect, not effect: this runs before paint, so the correction is
  // never visible as a jump.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return

    if (modeRef.current === 'follow-end') {
      el.scrollTop = el.scrollHeight
      return
    }

    if (modeRef.current === 'anchor-turn') {
      const start = virtualizer.getOffsetForIndex(anchorIndex.current, 'start')?.[0]
      if (start === undefined) return
      const turnHeight = virtualizer.getTotalSize() - start
      if (shouldReleaseAnchor(turnHeight, el.clientHeight)) {
        setMode('follow-end')
        return
      }
      el.scrollTop = start
    }
  }, [props.items, virtualizer])

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    // Any manual scroll hands control back to the user. Fighting them for the
    // viewport is the single most hostile thing a chat UI can do.
    if (isAtBottom(el)) {
      if (modeRef.current === 'free') setMode('follow-end')
    } else if (modeRef.current === 'follow-end') {
      setMode('free')
    }
  }, [])

  // Ctrl+F cannot work with a virtualised list — the match may not be in the
  // DOM — so the app owns find instead of the browser.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setFinding(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const jumpTo = useCallback(
    (index: number) => {
      setMode('free')
      virtualizer.scrollToIndex(index, { align: 'center' })
    },
    [virtualizer],
  )

  const rows = virtualizer.getVirtualItems()

  return (
    <div className="thread" ref={scroller} onScroll={onScroll}>
      {finding ? (
        <ThreadSearch items={props.items} onJump={jumpTo} onClose={() => setFinding(false)} />
      ) : null}
      <div className="thread__col">
        <div className="thread__runway" style={{ height: virtualizer.getTotalSize() }}>
          {rows.map((row) => {
            const item = props.items[row.index]
            if (!item) return null
            return (
              <div
                key={row.key}
                className="thread__row"
                data-index={row.index}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <Row item={item} />
              </div>
            )
          })}
        </div>

        <Plan steps={props.plan} />
        <Diff diff={props.diff} />
        {props.running ? <Working /> : null}
      </div>

      {mode === 'free' ? (
        <button
          className="jump"
          onClick={() => {
            setMode('follow-end')
            const el = scroller.current
            if (el) el.scrollTop = el.scrollHeight
          }}
        >
          Jump to latest
        </button>
      ) : null}
    </div>
  )
}

function Row({ item }: { item: Item }) {
  // The user's own words get a surface so the eye can find where each exchange
  // begins; the agent's answer is plain prose, which is what you actually read.
  if (item.type === 'message' && item.role === 'user') {
    return (
      <div className="said">
        <p className="said__text">{item.text}</p>
      </div>
    )
  }

  if (item.type === 'message') {
    return (
      <div className="reply">
        <Markdown text={item.text ?? ''} />
      </div>
    )
  }

  return (
    <details className={`aux aux--${item.type}`}>
      <summary className="aux__row">
        <span className="aux__glyph" aria-hidden>
          {glyph(item.type)}
        </span>
        <span className="aux__label">{summarise(item)}</span>
        {item.exitCode !== undefined && item.exitCode !== 0 ? (
          <span className="aux__code">exit {item.exitCode}</span>
        ) : null}
        {/* Only worth showing once it is long enough to have been noticed. */}
        {item.durationMs !== undefined && item.durationMs >= 1000 ? (
          <span className="aux__time">{duration(item.durationMs)}</span>
        ) : null}
        {item.status === 'started' ? <span className="aux__live" aria-hidden /> : null}
      </summary>
      {item.text ? <pre className="aux__out">{item.text}</pre> : null}
    </details>
  )
}

function Working() {
  return (
    <div className="working">
      <span className="spinner" aria-hidden />
      <span>Working</span>
    </div>
  )
}

function duration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

function glyph(type: Item['type']): string {
  switch (type) {
    case 'command':
      return '›_'
    case 'reasoning':
      return '~'
    case 'file_change':
      return '±'
    case 'tool_call':
      return '⌘'
    case 'plan':
      return '≡'
    case 'error':
      return '!'
    default:
      return '·'
  }
}

function summarise(item: Item): string {
  switch (item.type) {
    case 'command':
      return item.command ?? 'command'
    case 'reasoning':
      return 'Thinking'
    case 'file_change':
      return item.path ? `Edited ${item.path}` : 'Edited files'
    case 'tool_call':
      return item.text ?? 'Tool call'
    case 'plan':
      return 'Plan'
    case 'error':
      return item.text ?? 'Error'
    default:
      return item.type
  }
}
