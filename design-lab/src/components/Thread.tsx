/**
 * A finished transcript: user bubbles on the right, assistant replies as
 * plain text with a "Worked for" summary above and copy + time below.
 * Real app: apps/web/src/ui/Thread.tsx + styles/thread.css, markdown.css.
 */
import { IconChevronRight, IconCopy } from '@tabler/icons-react'
import { Fragment, type ReactNode } from 'react'
import { transcript, type Block } from '../data'

export function Thread() {
  return (
    <div className="thread">
      <div className="thread__runway">
        {transcript.map((turn, i) =>
          turn.role === 'user' ? (
            <div key={i} className="thread__row thread__row--user">
              <div className="said">
                <p className="said__text">{turn.text}</p>
              </div>
            </div>
          ) : (
            <div key={i} className="thread__row">
              <button className="activity">
                {turn.worked}
                <IconChevronRight size={13} stroke={2} />
              </button>
              <div className="reply">
                {turn.blocks.map((block, j) => (
                  <ReplyBlock key={j} block={block} />
                ))}
              </div>
              <div className="response-actions">
                <button className="icon-btn icon-btn--xs" aria-label="Copy">
                  <IconCopy size={14} stroke={1.75} />
                </button>
                <time>{turn.time}</time>
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  )
}

function ReplyBlock({ block }: { block: Block }) {
  if (block.kind === 'ul')
    return (
      <ul>
        {block.items.map((item, i) => (
          <li key={i}>{inline(item)}</li>
        ))}
      </ul>
    )
  return <p>{inline(block.text)}</p>
}

/** `code` spans only; enough markdown for the mock. */
function inline(text: string): ReactNode {
  return text.split(/(`[^`]+`)/).map((part, i) =>
    part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : <Fragment key={i}>{part}</Fragment>,
  )
}
