import { useEffect, useRef } from 'react'
import type { Item } from '@harness/contracts'
import { Markdown } from './Markdown.js'

/**
 * The thread.
 *
 * Messages read as prose; everything else — commands, reasoning, file edits —
 * collapses to a one-line row you can open. The default view should read as a
 * summary of what happened, not a transcript of every byte.
 */
export function Thread(props: { items: Item[]; running: boolean }) {
  const scroller = useRef<HTMLDivElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Follow new output only while the user is already at the bottom. Yanking
  // someone back mid-read is the cardinal sin of chat UIs. End-anchored
  // virtualisation replaces this wholesale in M1.
  useEffect(() => {
    if (pinned.current) bottom.current?.scrollIntoView({ block: 'end' })
  }, [props.items])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  return (
    <div className="thread" ref={scroller} onScroll={onScroll}>
      <div className="thread__col">
        {props.items.map((item) => (
          <Row key={item.id} item={item} />
        ))}
        {props.running ? <Working /> : null}
        <div ref={bottom} />
      </div>
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
